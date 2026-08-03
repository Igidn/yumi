import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ContentBlock,
  ReaderChapter,
  TtsBackend,
  TtsSelection,
  TtsSpeakResult,
  TtsVoice,
  WordBoundary,
} from "../../shared/types";
import { loadTtsConfig, saveTtsConfig } from "./ttsSettings";

// Module-level var to pass persisted voice ID between effects (avoids window pollution).
let pendingVoiceId: string | null = null;

interface BlockMapEntry {
  blockIndex: number;
  startChar: number;
  endChar: number;
}

/** One ~3-paragraph chunk sent to the TTS engine. */
interface TtsSegment {
  text: string;
  blockMap: BlockMapEntry[];
}

// Preload window: segments up to LOOKAHEAD past the one currently playing
// are requested from main. ~3 paragraphs synth in ~1–2s vs ~10–15s of
// playback, so the queue converges to 1–2 buffered segments.
const LOOKAHEAD = 2;
const SEG_PARAGRAPHS = 3;
const SEG_MAX_CHARS = 600;

/** Split blocks into ~3-paragraph segments, skipping images and empty blocks. */
function segmentBlocks(
  blocks: ContentBlock[],
  startBlockIdx: number,
  startCharOff: number,
): TtsSegment[] {
  const segs: TtsSegment[] = [];
  let text = "";
  let blockMap: BlockMapEntry[] = [];
  let paraCount = 0;
  const flush = () => {
    if (text.trim()) segs.push({ text, blockMap });
    text = "";
    blockMap = [];
    paraCount = 0;
  };
  for (let i = startBlockIdx; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "image") continue;
    const blockText = i === startBlockIdx ? b.text.slice(startCharOff) : b.text;
    if (!blockText.trim()) continue;
    if (blockMap.length > 0) text += " ";
    const start = text.length;
    text += blockText;
    // endChar extends past the last char to cover the inter-block space.
    blockMap.push({
      blockIndex: i,
      startChar: start,
      endChar: text.length + 1,
    });
    paraCount++;
    if (paraCount >= SEG_PARAGRAPHS || text.length >= SEG_MAX_CHARS) flush();
  }
  flush();
  return segs;
}

/** Block index for each whitespace token, in text order. */
function buildWordBlockMap(text: string, blockMap: BlockMapEntry[]): number[] {
  const out: number[] = [];
  let ci = 0;
  while (ci < text.length) {
    while (ci < text.length && /\s/.test(text[ci])) ci++;
    if (ci >= text.length) break;
    const wordStart = ci;
    while (ci < text.length && !/\s/.test(text[ci])) ci++;
    const match = blockMap.find(
      (b) => wordStart >= b.startChar && wordStart < b.endChar,
    );
    out.push(
      match ? match.blockIndex : out.length > 0 ? out[out.length - 1] : 0,
    );
  }
  return out;
}

export function useTts(
  chapters: ReaderChapter[],
  readerChapterPosRef: React.MutableRefObject<number>,
) {
  const [backend, setBackendState] = useState<TtsBackend>("web");
  const [rate, setRateState] = useState(1);
  const [voice, setVoiceState] = useState<TtsVoice | null>(null);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(false);
  /** True when segment synthesis failed after retries (edge backend). */
  const [genError, setGenError] = useState(false);
  const [highlightBlockIndex, setHighlightBlockIndex] = useState<number | null>(
    null,
  );
  const [active, setActive] = useState(false);
  /** TTS-owned chapter position, independent of the reader view. */
  const [ttsChapterPos, setTtsChapterPos] = useState(0);

  const continueRef = useRef(false);
  /** Authoritative pause flag for the edge backend (state can lag during buffering). */
  const pausedRef = useRef(false);
  const rateRef = useRef(1);
  const voiceRef = useRef<TtsVoice | null>(null);
  const backendRef = useRef<TtsBackend>("web");
  const utteranceIdRef = useRef(0);
  // Track the last highlight block so voice/rate changes can restart from it.
  const highlightBlockRef = useRef<number | null>(null);

  // Stable refs for values accessed inside stable ([]-deps) callbacks.
  const chaptersRef = useRef(chapters);
  useEffect(() => {
    chaptersRef.current = chapters;
  }, [chapters]);
  const ttsChapterPosRef = useRef(0);
  useEffect(() => {
    ttsChapterPosRef.current = ttsChapterPos;
  }, [ttsChapterPos]);
  /** When true, the next ttsChapterPos change is an auto-advance to speak. */
  const advanceRef = useRef(false);

  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);
  useEffect(() => {
    backendRef.current = backend;
  }, [backend]);

  // --- Segmented pipeline: preloader + AudioContext chaining ---
  const genRef = useRef(0);
  const segmentsRef = useRef<TtsSegment[]>([]);
  const buffersRef = useRef<
    Map<number, { buffer: AudioBuffer; words: WordBoundary[] }>
  >(new Map());
  const currentSegRef = useRef(0);
  const requestedUpToRef = useRef(-1);
  const ensurePreloadedRef = useRef<() => void>(() => {});
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  // Segment cache: key = text|voice|rate. Session-scoped LRU so skip-back
  // and re-listening don't re-synthesize. Keyed by text (not segment index)
  // because segments are re-chunked from the start offset on each restart.
  const cacheRef = useRef<Map<string, TtsSpeakResult>>(new Map());
  const CACHE_MAX = 32;

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  }, []);

  const stopHighlightLoop = useCallback(() => {
    if (highlightTimerRef.current !== null) {
      window.clearInterval(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
  }, []);

  /** Position to restart from after a voice/provider switch parked playback. */
  const pendingRestartRef = useRef<{ blockIdx: number; charOffset: number } | null>(null);

  /** Chapter ended: clear playback state, then auto-advance or stop. */
  const finishChapter = useCallback(() => {
    stopHighlightLoop();
    setHighlightBlockIndex(null);
    setSpeaking(false);
    if (continueRef.current) {
      advanceRef.current = true;
      setTtsChapterPos((prev) => prev + 1);
    } else {
      setActive(false);
    }
  }, [stopHighlightLoop]);

  const clearGenError = useCallback(() => setGenError(false), []);

  const cacheGet = useCallback((key: string): TtsSpeakResult | undefined => {
    const hit = cacheRef.current.get(key);
    if (hit) {
      // Refresh LRU order.
      cacheRef.current.delete(key);
      cacheRef.current.set(key, hit);
    }
    return hit;
  }, []);

  const cachePut = useCallback((key: string, res: TtsSpeakResult) => {
    cacheRef.current.set(key, res);
    if (cacheRef.current.size > CACHE_MAX) {
      const oldest = cacheRef.current.keys().next().value;
      if (oldest !== undefined) cacheRef.current.delete(oldest);
    }
  }, []);

  const playSegment = useCallback(
    function playSegmentImpl(idx: number) {
      const gen = genRef.current;
      const segs = segmentsRef.current;
      if (idx >= segs.length) {
        // Chapter finished; stop preloading (no cross-chapter synth).
        finishChapter();
        return;
      }
      currentSegRef.current = idx;
      const entry = buffersRef.current.get(idx);
      // First block of this segment = N+1 of the last spoken one. While the
      // segment is still synthesizing, park the highlight there without
      // starting word counting (the interval below is the word counter).
      const firstBlock = segs[idx]?.blockMap[0]?.blockIndex ?? null;
      setHighlightBlockIndex(firstBlock);
      if (!entry) {
        setBuffering(true);
        return;
      }
      setBuffering(false);
      const ctx = getAudioCtx();
      // Don't clobber an in-flight pause: the context is suspended, the source
      // below still gets scheduled and plays once the user resumes.
      if (!pausedRef.current) {
        void ctx.resume();
        setPaused(false);
      }
      const src = ctx.createBufferSource();
      src.buffer = entry.buffer;
      src.connect(ctx.destination);
      const startAt = ctx.currentTime + 0.05;
      src.start(startAt);
      sourceRef.current = src;
      setSpeaking(true);

      // Highlight: word time offsets are in the segment's audio timeline, so
      // map elapsed time → word → block. Token-count alignment with the
      // engine's word stream can drift by a word or two; paragraph-level
      // highlighting tolerates that.
      const tokenBlocks = buildWordBlockMap(segs[idx].text, segs[idx].blockMap);
      let wi = 0;
      stopHighlightLoop();
      highlightTimerRef.current = window.setInterval(() => {
        const elapsed = ctx.currentTime - startAt;
        while (
          wi < entry.words.length - 1 &&
          entry.words[wi + 1].time <= elapsed
        )
          wi++;
        const blockIdx =
          tokenBlocks[Math.min(wi, tokenBlocks.length - 1)] ?? null;
        setHighlightBlockIndex(blockIdx);
      }, 100);

      src.onended = () => {
        if (genRef.current !== gen) return;
        if (continueRef.current) {
          stopHighlightLoop();
          setHighlightBlockIndex(null);
          playSegmentImpl(idx + 1);
        } else {
          finishChapter();
        }
      };
      void ensurePreloadedRef.current();
    },
    [getAudioCtx, stopHighlightLoop, finishChapter],
  );

  const storeSegment = useCallback(
    async (idx: number, res: TtsSpeakResult) => {
      const gen = genRef.current;
      const ctx = getAudioCtx();
      const bin = atob(res.audioBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const buffer = await ctx.decodeAudioData(bytes.buffer);
      if (genRef.current !== gen) return;
      buffersRef.current.set(idx, { buffer, words: res.words });
      if (idx === currentSegRef.current) playSegment(idx);
    },
    [getAudioCtx, playSegment],
  );

  const stop = useCallback(() => {
    continueRef.current = false;
    advanceRef.current = false;
    pendingRestartRef.current = null;
    window.speechSynthesis.cancel();
    utteranceIdRef.current += 1;
    genRef.current += 1;
    stopHighlightLoop();
    sourceRef.current?.stop();
    sourceRef.current = null;
    buffersRef.current.clear();
    segmentsRef.current = [];
    webSegmentsRef.current = [];
    requestedUpToRef.current = -1;
    setBuffering(false);
    void window.yumi.invoke("tts:stop").catch(() => {});
    setActive(false);
    setSpeaking(false);
    setPaused(false);
    pausedRef.current = false;
    setHighlightBlockIndex(null);
    setGenError(false);
  }, [stopHighlightLoop]);

  // Preload rule: keep segments up to LOOKAHEAD past the one currently
  // playing requested from main. Runs after every render so it always
  // captures the latest callbacks; only ever invoked from event handlers.
  useEffect(() => {
    ensurePreloadedRef.current = () => {
      const gen = genRef.current;
      const segs = segmentsRef.current;
      const maxReq = Math.min(
        segs.length,
        currentSegRef.current + LOOKAHEAD + 1,
      );
      while (requestedUpToRef.current + 1 < maxReq) {
        const idx = ++requestedUpToRef.current;
        const seg = segs[idx];
        // Key by synthesized text, not segment index: segments are re-chunked
        // from the start offset on every restart, so an index-only key makes a
        // mid-chapter restart replay the original run's segments from cache.
        const key = `${seg.text}|${voiceRef.current?.id ?? ""}|${
          rateRef.current
        }`;
        const cached = cacheGet(key);
        if (cached) {
          void storeSegment(idx, cached);
          continue;
        }
        window.yumi
          .invoke("tts:speak", {
            text: seg.text,
            voice: voiceRef.current?.id ?? null,
            rate: rateRef.current,
          })
          .then((res) => {
            if (genRef.current !== gen) return;
            cachePut(key, res);
            void storeSegment(idx, res);
          })
          .catch((err) => {
            if (genRef.current !== gen) return;
            console.error("tts:speak failed", err);
            stop();
            setGenError(true);
          });
      }
    };
  });

  /** Start the segmented pipeline for a chapter. */
  const startEdge = useCallback(
    (blocks: ContentBlock[], startBlockIdx: number, startCharOff: number) => {
      genRef.current += 1;
      pendingRestartRef.current = null;
      stopHighlightLoop();
      sourceRef.current?.stop();
      sourceRef.current = null;
      segmentsRef.current = segmentBlocks(blocks, startBlockIdx, startCharOff);
      buffersRef.current.clear();
      requestedUpToRef.current = -1;
      currentSegRef.current = 0;
      setActive(true);
      setSpeaking(true);
      setGenError(false);
      setPaused(false);
      pausedRef.current = false;
      // Tracking highlight appears instantly on the first spoken block;
      // word counting only starts once that segment's audio arrives.
      setHighlightBlockIndex(
        segmentsRef.current[0]?.blockMap[0]?.blockIndex ?? null,
      );
      // Create/resume the context synchronously inside the user gesture so
      // playback isn't subject to autoplay policies on strict platforms.
      void getAudioCtx().resume();
      void window.yumi.invoke("tts:stop").catch(() => {});
      ensurePreloadedRef.current();
      playSegment(0);
    },
    [stopHighlightLoop, playSegment, getAudioCtx],
  );

  // --- Segmented Web Speech path: same ~3-paragraph chunks as the edge
  // preloader, spoken sequentially. Word-boundary counting is per segment,
  // so token-count drift resets every segment instead of accumulating over
  // a whole chapter. ---
  const webSegmentsRef = useRef<TtsSegment[]>([]);

  // Persist helper: snapshot current config to app_settings.
  const persistConfig = useCallback(() => {
    saveTtsConfig({
      backend: backendRef.current,
      rate: rateRef.current,
      voiceId: voiceRef.current?.id ?? null,
    });
  }, []);

  // Load persisted TTS config on mount.
  useEffect(() => {
    let cancelled = false;
    void loadTtsConfig().then((cfg) => {
      if (cancelled) return;
      setBackendState(cfg.backend);
      backendRef.current = cfg.backend;
      setRateState(cfg.rate);
      rateRef.current = cfg.rate;
      // voice restore is deferred until voices are populated below
      pendingVoiceId = cfg.voiceId;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const restorePendingVoice = useCallback((list: TtsVoice[]) => {
    if (!pendingVoiceId) return;
    const match = list.find((v) => v.id === pendingVoiceId);
    if (match) {
      setVoiceState(match);
      voiceRef.current = match;
    }
    pendingVoiceId = null;
  }, []);

  // Load available voices from Web Speech API.
  useEffect(() => {
    if (backend !== "web") return;
    const synth = window.speechSynthesis;
    const populate = () => {
      const list = synth.getVoices().map((v) => ({
        name: v.name,
        lang: v.lang,
        id: v.voiceURI,
      }));
      setVoices(list);
      restorePendingVoice(list);
    };
    populate();
    synth.onvoiceschanged = populate;
    return () => {
      synth.onvoiceschanged = null;
    };
  }, [backend, restorePendingVoice]);

  // Load available voices from the edge backend.
  useEffect(() => {
    if (backend !== "edge") return;
    let cancelled = false;
    window.yumi
      .invoke("tts:voices")
      .then((list) => {
        if (cancelled) return;
        setVoices(list);
        restorePendingVoice(list);
      })
      .catch((err) => console.error("tts:voices failed", err));
    return () => {
      cancelled = true;
    };
  }, [backend, restorePendingVoice]);

  const playWebSegment = useCallback(
    (idx: number) => {
      const segs = webSegmentsRef.current;
      if (idx >= segs.length) {
        finishChapter();
        return;
      }
      const seg = segs[idx];
      const synth = window.speechSynthesis;
      const myId = utteranceIdRef.current;
      // Tracking highlight appears instantly on the segment's first block;
      // word boundaries move it once speech actually starts.
      setHighlightBlockIndex(seg.blockMap[0]?.blockIndex ?? null);

      // Build word-to-block mapping so we can track TTS position by
      // counting onboundary word events instead of trusting charIndex
      // (which is sentence-relative on some platforms).
      const wordBlockMap = buildWordBlockMap(seg.text, seg.blockMap);
      let wordIndex = 0;

      const utterance = new SpeechSynthesisUtterance(seg.text);
      utterance.rate = rateRef.current;
      const vid = voiceRef.current?.id;
      if (vid) {
        const sv = synth.getVoices().find((v) => v.voiceURI === vid);
        if (sv) utterance.voice = sv;
      }

      utterance.onboundary = (e) => {
        if (utteranceIdRef.current !== myId) return;
        if (e.name === "word") {
          const blockIndex =
            wordIndex < wordBlockMap.length
              ? wordBlockMap[wordIndex]
              : (wordBlockMap[wordBlockMap.length - 1] ?? 0);
          setHighlightBlockIndex(blockIndex);
          wordIndex++;
        }
      };

      utterance.onstart = () => {
        if (utteranceIdRef.current !== myId) return;
        setSpeaking(true);
        setPaused(false);
      };
      utterance.onpause = () => {
        if (utteranceIdRef.current !== myId) return;
        setPaused(true);
      };
      utterance.onresume = () => {
        if (utteranceIdRef.current !== myId) return;
        setPaused(false);
      };
      utterance.onend = () => {
        if (utteranceIdRef.current !== myId) return;
        // Keep speaking true across the chain; the last segment's finish
        // clears it via finishChapter.
        playWebSegment(idx + 1);
      };
      utterance.onerror = (e) => {
        if (utteranceIdRef.current !== myId) return;
        if (e.error === "canceled" || e.error === "interrupted") return;
        setSpeaking(false);
        setHighlightBlockIndex(null);
        setActive(false);
      };

      synth.speak(utterance);
    },
    [finishChapter],
  );

  /** Start the segmented web pipeline for a chapter. */
  const startWeb = useCallback(
    (blocks: ContentBlock[], startBlockIdx: number, startCharOff: number) => {
      window.speechSynthesis.cancel();
      pendingRestartRef.current = null;
      utteranceIdRef.current += 1;
      webSegmentsRef.current = segmentBlocks(
        blocks,
        startBlockIdx,
        startCharOff,
      );
      setActive(true);
      setSpeaking(true);
      setGenError(false);
      setPaused(false);
      playWebSegment(0);
    },
    [playWebSegment],
  );

  /** Speak a whole chapter from the start, dispatching on backend. */
  const speakChapter = useCallback(
    (pos: number) => {
      const blocks = chaptersRef.current[pos]?.blocks ?? [];
      if (blocks.length > 0) {
        if (backendRef.current === "web") startWeb(blocks, 0, 0);
        else startEdge(blocks, 0, 0);
      } else {
        // Empty chapter — skip it.
        advanceRef.current = true;
        setTtsChapterPos((prev) => prev + 1);
      }
    },
    [startWeb, startEdge],
  );

  // Auto-advance: when ttsChapterPos changes due to an advanceRef flag,
  // load the next chapter's blocks and speak them.
  useEffect(() => {
    if (!advanceRef.current) return;
    advanceRef.current = false;
    const pos = ttsChapterPosRef.current;
    if (pos >= chaptersRef.current.length) {
      setActive(false);
      return;
    }
    speakChapter(pos);
  }, [ttsChapterPos, speakChapter]);

  const start = useCallback(
    (origin: TtsSelection) => {
      continueRef.current = true;
      advanceRef.current = false;
      const pos = readerChapterPosRef.current;
      ttsChapterPosRef.current = pos;
      setTtsChapterPos(pos);
      const blocks = chaptersRef.current[pos]?.blocks ?? [];
      if (backendRef.current === "web") {
        startWeb(blocks, origin.blockIndex, origin.charOffset);
      } else {
        startEdge(blocks, origin.blockIndex, origin.charOffset);
      }
    },
    [readerChapterPosRef, startWeb, startEdge],
  );

  const pause = useCallback(() => {
    if (backendRef.current === "web") {
      window.speechSynthesis.pause();
    } else {
      pausedRef.current = true;
      void audioCtxRef.current?.suspend();
      setPaused(true);
    }
  }, []);

  const resume = useCallback(() => {
    // Playback was parked by a voice/provider switch: start it with the
    // new config instead of resuming a dead provider.
    const pending = pendingRestartRef.current;
    if (pending) {
      pendingRestartRef.current = null;
      continueRef.current = true;
      advanceRef.current = false;
      const blocks =
        chaptersRef.current[ttsChapterPosRef.current]?.blocks ?? [];
      if (backendRef.current === "web")
        startWeb(blocks, pending.blockIdx, pending.charOffset);
      else startEdge(blocks, pending.blockIdx, pending.charOffset);
      return;
    }
    if (backendRef.current === "web") {
      window.speechSynthesis.resume();
    } else {
      pausedRef.current = false;
      void audioCtxRef.current?.resume();
      setPaused(false);
    }
  }, [startWeb, startEdge]);

  const skipBack = useCallback(() => {
    continueRef.current = true;
    advanceRef.current = false;
    const blocks = chaptersRef.current[ttsChapterPosRef.current]?.blocks ?? [];
    if (backendRef.current === "web") startWeb(blocks, 0, 0);
    else startEdge(blocks, 0, 0);
  }, [startWeb, startEdge]);

  const skipFwd = useCallback(() => {
    continueRef.current = true;
    window.speechSynthesis.cancel();
    utteranceIdRef.current += 1;
    const nextPos = ttsChapterPosRef.current + 1;
    if (nextPos >= chaptersRef.current.length) {
      // Last chapter: full teardown. setActive(false) alone leaves the edge
      // source playing — the hidden bar, the highlight, and the continueRef
      // chain all keep running until the segment list exhausts.
      stop();
      return;
    }
    advanceRef.current = true;
    setTtsChapterPos(nextPos);
  }, [stop]);

  // Keep highlightBlockRef in sync so voice/rate changes restart from the
  // current block instead of jumping back to the beginning.
  useEffect(() => {
    highlightBlockRef.current = highlightBlockIndex;
  }, [highlightBlockIndex]);

  const setRateAndUpdate = useCallback(
    (r: number) => {
      setRateState(r);
      rateRef.current = r;
      persistConfig();
      if (continueRef.current) {
        advanceRef.current = false;
        const blockIdx = highlightBlockRef.current ?? 0;
        const blocks =
          chaptersRef.current[ttsChapterPosRef.current]?.blocks ?? [];
        if (backendRef.current === "web") startWeb(blocks, blockIdx, 0);
        else startEdge(blocks, blockIdx, 0);
      }
    },
    [startWeb, startEdge, persistConfig],
  );

  const setVoiceAndUpdate = useCallback(
    (v: TtsVoice) => {
      setVoiceState(v);
      voiceRef.current = v;
      persistConfig();
      if (continueRef.current || pendingRestartRef.current !== null) {
        // Park playback paused at the current block; play resumes it with
        // the new voice.
        const blockIdx =
          pendingRestartRef.current?.blockIdx ?? highlightBlockRef.current ?? 0;
        stop();
        pendingRestartRef.current = { blockIdx, charOffset: 0 };
        setActive(true);
        setSpeaking(false);
        setPaused(true);
      }
    },
    [stop, persistConfig],
  );

  const setBackend = useCallback(
    (b: TtsBackend) => {
      if (b === backendRef.current) return;
      // Keep the bar visible: halt the current provider and park playback
      // paused at the current block; play resumes with the new backend.
      // A parked pipeline (pendingRestartRef) counts as active — switching
      // backends twice in a row must not drop the bar.
      const wasActive =
        continueRef.current || pendingRestartRef.current !== null;
      const blockIdx =
        pendingRestartRef.current?.blockIdx ?? highlightBlockRef.current ?? 0;
      stop();
      setBackendState(b);
      backendRef.current = b;
      // Backend voice lists are disjoint; drop the selection until the new
      // list populates (restore-on-mount handles the persisted voice).
      setVoiceState(null);
      voiceRef.current = null;
      persistConfig();
      if (wasActive) {
        pendingRestartRef.current = { blockIdx, charOffset: 0 };
        setActive(true);
        setSpeaking(false);
        setPaused(true);
      }
    },
    [stop, persistConfig],
  );

  // Stop on unmount (window close).
  useEffect(() => {
    return () => {
      window.speechSynthesis.cancel();
      genRef.current += 1;
      stopHighlightLoop();
      sourceRef.current?.stop();
      void window.yumi.invoke("tts:stop").catch(() => {});
      void audioCtxRef.current?.close().catch(() => {});
    };
  }, [stopHighlightLoop]);

  return {
    start,
    stop,
    pause,
    resume,
    skipBack,
    skipFwd,
    rate,
    setRate: setRateAndUpdate,
    backend,
    setBackend,
    voice,
    setVoice: setVoiceAndUpdate,
    voices,
    speaking,
    paused,
    buffering,
    genError,
    clearGenError,
    highlightBlockIndex,
    active,
    ttsChapterPos,
  };
}
