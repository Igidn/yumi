import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ContentBlock,
  ReaderChapter,
  TtsBackend,
  TtsSelection,
  TtsVoice,
} from "../../shared/types";
import { loadTtsConfig, saveTtsConfig } from "./ttsSettings";

// Module-level var to pass persisted voice ID between effects (avoids window pollution).
let pendingVoiceId: string | null = null;

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
  const [highlightBlockIndex, setHighlightBlockIndex] = useState<number | null>(
    null,
  );
  const [active, setActive] = useState(false);
  /** TTS-owned chapter position, independent of the reader view. */
  const [ttsChapterPos, setTtsChapterPos] = useState(0);

  const continueRef = useRef(false);
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

  // Load available voices from Web Speech API. Restore persisted voice once
  // the voice list is populated (may be async on some platforms).
  useEffect(() => {
    const synth = window.speechSynthesis;
    const populate = () => {
      const list = synth.getVoices().map((v) => ({
        name: v.name,
        lang: v.lang,
        id: v.voiceURI,
      }));
      setVoices(list);
      // Restore persisted voice if we have a pending ID.
      if (pendingVoiceId) {
        const match = list.find((v) => v.id === pendingVoiceId);
        if (match) {
          setVoiceState(match);
          voiceRef.current = match;
        }
        pendingVoiceId = null;
      }
    };
    populate();
    synth.onvoiceschanged = populate;
    return () => {
      synth.onvoiceschanged = null;
    };
  }, []);

  const speakBlocks = useCallback(
    (blocks: ContentBlock[], startBlockIdx: number, startCharOff: number) => {
      const synth = window.speechSynthesis;
      synth.cancel();
      utteranceIdRef.current += 1;
      const myId = utteranceIdRef.current;

      let text = "";
      const blockMap: {
        blockIndex: number;
        startChar: number;
        endChar: number;
      }[] = [];

      for (let i = startBlockIdx; i < blocks.length; i++) {
        const block = blocks[i];
        if (block.type === "image") continue;
        const blockText =
          i === startBlockIdx ? block.text.slice(startCharOff) : block.text;

        if (i > startBlockIdx) text += " ";
        const startChar = text.length;
        text += blockText;
        blockMap.push({ blockIndex: i, startChar, endChar: text.length });
      }

      if (!text.trim()) {
        // Empty chapter: auto-advance to the next one.
        if (continueRef.current) {
          advanceRef.current = true;
          setTtsChapterPos((prev) => prev + 1);
        } else {
          setActive(false);
        }
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = rateRef.current;
      const vid = voiceRef.current?.id;
      if (vid) {
        const sv = synth.getVoices().find((v) => v.voiceURI === vid);
        if (sv) utterance.voice = sv;
      }

      utterance.onboundary = (e) => {
        if (utteranceIdRef.current !== myId) return;
        if (e.name === "word" && e.charIndex !== undefined) {
          const idx = e.charIndex;
          const match = blockMap.find(
            (b) => idx >= b.startChar && idx < b.endChar,
          );
          if (match) setHighlightBlockIndex(match.blockIndex);
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
        setSpeaking(false);
        setHighlightBlockIndex(null);
        if (continueRef.current) {
          advanceRef.current = true;
          setTtsChapterPos((prev) => prev + 1);
        } else {
          setActive(false);
        }
      };
      utterance.onerror = (e) => {
        if (utteranceIdRef.current !== myId) return;
        if (e.error === "canceled" || e.error === "interrupted") return;
        setSpeaking(false);
        setHighlightBlockIndex(null);
        setActive(false);
      };

      synth.speak(utterance);
      setActive(true);
    },
    [],
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
    const blocks = chaptersRef.current[pos]?.blocks ?? [];
    if (blocks.length > 0) {
      speakBlocks(blocks, 0, 0);
    } else {
      // Empty chapter — skip it.
      advanceRef.current = true;
      setTtsChapterPos((prev) => prev + 1);
    }
  }, [ttsChapterPos, speakBlocks]);

  // Stop on unmount (window close).
  useEffect(() => {
    return () => {
      window.speechSynthesis.cancel();
    };
  }, []);

  const start = useCallback(
    (origin: TtsSelection) => {
      continueRef.current = true;
      advanceRef.current = false;
      const pos = readerChapterPosRef.current;
      ttsChapterPosRef.current = pos;
      setTtsChapterPos(pos);
      const blocks = chaptersRef.current[pos]?.blocks ?? [];
      speakBlocks(blocks, origin.blockIndex, origin.charOffset);
    },
    [readerChapterPosRef, speakBlocks],
  );

  const stop = useCallback(() => {
    continueRef.current = false;
    advanceRef.current = false;
    window.speechSynthesis.cancel();
    utteranceIdRef.current += 1;
    setActive(false);
    setSpeaking(false);
    setPaused(false);
    setHighlightBlockIndex(null);
  }, []);

  const pause = useCallback(() => {
    window.speechSynthesis.pause();
  }, []);

  const resume = useCallback(() => {
    window.speechSynthesis.resume();
  }, []);

  const skipBack = useCallback(() => {
    continueRef.current = true;
    advanceRef.current = false;
    const blocks =
      chaptersRef.current[ttsChapterPosRef.current]?.blocks ?? [];
    speakBlocks(blocks, 0, 0);
  }, [speakBlocks]);

  const skipFwd = useCallback(() => {
    continueRef.current = true;
    window.speechSynthesis.cancel();
    utteranceIdRef.current += 1;
    const nextPos = ttsChapterPosRef.current + 1;
    if (nextPos >= chaptersRef.current.length) {
      setActive(false);
      return;
    }
    advanceRef.current = true;
    setTtsChapterPos(nextPos);
  }, []);

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
        speakBlocks(blocks, blockIdx, 0);
      }
    },
    [speakBlocks, persistConfig],
  );

  const setVoiceAndUpdate = useCallback(
    (v: TtsVoice) => {
      setVoiceState(v);
      voiceRef.current = v;
      persistConfig();
      if (continueRef.current) {
        advanceRef.current = false;
        const blockIdx = highlightBlockRef.current ?? 0;
        const blocks =
          chaptersRef.current[ttsChapterPosRef.current]?.blocks ?? [];
        speakBlocks(blocks, blockIdx, 0);
      }
    },
    [speakBlocks, persistConfig],
  );

  const setBackend = useCallback(
    (b: TtsBackend) => {
      setBackendState(b);
      backendRef.current = b;
      persistConfig();
    },
    [persistConfig],
  );

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
    highlightBlockIndex,
    active,
    ttsChapterPos,
  };
}
