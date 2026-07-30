import { useCallback, useEffect, useRef, useState } from "react";

import type { ContentBlock, TtsBackend, TtsSelection, TtsVoice } from "../../shared/types";
import { loadTtsConfig, saveTtsConfig } from "./ttsSettings";

export function useTts(
  spreadBlocks: ContentBlock[],
  onPageRight: () => void,
) {
  const [backend, setBackendState] = useState<TtsBackend>("web");
  const [rate, setRateState] = useState(1);
  const [voice, setVoiceState] = useState<TtsVoice | null>(null);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [highlightBlockIndex, setHighlightBlockIndex] = useState<number | null>(null);
  const [active, setActive] = useState(false);

  const continueRef = useRef(false);
  const rateRef = useRef(1);
  const voiceRef = useRef<TtsVoice | null>(null);
  const backendRef = useRef<TtsBackend>("web");
  const onPageRightRef = useRef(onPageRight);
  onPageRightRef.current = onPageRight;
  const utteranceIdRef = useRef(0);
  // Track the last highlight block so voice/rate changes can restart from it.
  const highlightBlockRef = useRef<number | null>(null);

  useEffect(() => { rateRef.current = rate; }, [rate]);
  useEffect(() => { voiceRef.current = voice; }, [voice]);
  useEffect(() => { backendRef.current = backend; }, [backend]);

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
      (window as any).__ttsPendingVoiceId = cfg.voiceId;
    });
    return () => { cancelled = true; };
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
      const pendingId = (window as any).__ttsPendingVoiceId as string | null | undefined;
      if (pendingId) {
        const match = list.find((v) => v.id === pendingId);
        if (match) {
          setVoiceState(match);
          voiceRef.current = match;
        }
        delete (window as any).__ttsPendingVoiceId;
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
        if (continueRef.current) onPageRightRef.current();
        else setActive(false);
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
          onPageRightRef.current();
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

  // Stop on unmount (window close).
  useEffect(() => {
    return () => {
      window.speechSynthesis.cancel();
    };
  }, []);

  // Auto-speak when spread/chapter changes during continuous playback.
  const prevBlocksRef = useRef(spreadBlocks);
  useEffect(() => {
    if (
      continueRef.current &&
      spreadBlocks !== prevBlocksRef.current &&
      spreadBlocks.length > 0
    ) {
      speakBlocks(spreadBlocks, 0, 0);
    }
    prevBlocksRef.current = spreadBlocks;
  }, [spreadBlocks, speakBlocks]);

  const start = useCallback(
    (origin: TtsSelection) => {
      continueRef.current = true;
      speakBlocks(spreadBlocks, origin.blockIndex, origin.charOffset);
    },
    [spreadBlocks, speakBlocks],
  );

  const stop = useCallback(() => {
    continueRef.current = false;
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
    speakBlocks(spreadBlocks, 0, 0);
  }, [spreadBlocks, speakBlocks]);

  const skipFwd = useCallback(() => {
    continueRef.current = true;
    window.speechSynthesis.cancel();
    utteranceIdRef.current += 1;
    onPageRight();
  }, [onPageRight]);

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
        const blockIdx = highlightBlockRef.current ?? 0;
        speakBlocks(spreadBlocks, blockIdx, 0);
      }
    },
    [spreadBlocks, speakBlocks, persistConfig],
  );

  const setVoiceAndUpdate = useCallback(
    (v: TtsVoice) => {
      setVoiceState(v);
      voiceRef.current = v;
      persistConfig();
      if (continueRef.current) {
        const blockIdx = highlightBlockRef.current ?? 0;
        speakBlocks(spreadBlocks, blockIdx, 0);
      }
    },
    [spreadBlocks, speakBlocks, persistConfig],
  );

  const setBackend = useCallback((b: TtsBackend) => {
    setBackendState(b);
    backendRef.current = b;
    persistConfig();
  }, [persistConfig]);

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
  };
}
