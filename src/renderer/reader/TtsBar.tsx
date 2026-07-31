import { Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";

import type { TtsBackend, TtsVoice } from "../../shared/types";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

interface TtsBarProps {
  backend: TtsBackend;
  onBackendChange: (b: TtsBackend) => void;
  rate: number;
  onRateChange: (r: number) => void;
  speaking: boolean;
  paused: boolean;
  buffering: boolean;
  onPlayPause: () => void;
  onSkipBack: () => void;
  onSkipFwd: () => void;
  onStop: () => void;
  voices: TtsVoice[];
  voice: TtsVoice | null;
  onVoiceChange: (v: TtsVoice) => void;
  visible: boolean;
}

export function TtsBar({
  backend,
  onBackendChange,
  rate,
  onRateChange,
  speaking,
  paused,
  buffering,
  onPlayPause,
  onSkipBack,
  onSkipFwd,
  onStop,
  voices,
  voice,
  onVoiceChange,
  visible,
}: TtsBarProps) {
  return (
    <div
      className={`absolute bottom-6 left-1/2 z-20 -translate-x-1/2 rounded-xl bg-reader-chrome px-3 py-2 shadow-lg transition-all duration-250 ${
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-3 opacity-0"
      }`}
    >
      <div className="flex items-center gap-1.5 text-[12px] text-reader-muted">
        {/* Backend switcher (Kokoro lands later) */}
        <select
          value={backend}
          onChange={(e) => onBackendChange(e.target.value as TtsBackend)}
          className="appearance-none rounded-md bg-reader-edge/40 px-2 py-1 text-[11px] font-medium text-reader outline-none cursor-pointer"
          aria-label="Backend"
        >
          <option value="edge">Edge</option>
          <option value="web">Web</option>
        </select>

        <span className="mx-0.5 h-4 w-px bg-reader-edge" />

        {/* Speed */}
        <select
          value={rate}
          onChange={(e) => onRateChange(Number(e.target.value))}
          className="appearance-none rounded-md bg-reader-edge/40 px-1.5 py-1 text-[11px] font-medium text-reader outline-none cursor-pointer"
          aria-label="Speed"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}&times;
            </option>
          ))}
        </select>

        {/* Voice */}
        {voices.length > 0 && (
          <select
            value={voice?.id ?? ""}
            onChange={(e) => {
              const v = voices.find((v) => v.id === e.target.value);
              if (v) onVoiceChange(v);
            }}
            className="max-w-[120px] appearance-none truncate rounded-md bg-reader-edge/40 px-1.5 py-1 text-[11px] font-medium text-reader outline-none cursor-pointer"
            aria-label="Voice"
          >
            <option value="">Default</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}

        <span className="mx-0.5 h-4 w-px bg-reader-edge" />

        {/* Playback controls */}
        <button
          onClick={onSkipBack}
          className="rounded-md p-1 hover:text-reader transition-colors"
          aria-label="Skip back"
        >
          <SkipBack size={14} strokeWidth={1.75} />
        </button>

        <button
          onClick={onPlayPause}
          className={`rounded-md p-1 transition-colors hover:text-reader ${
            buffering ? "animate-pulse text-reader" : ""
          }`}
          aria-label={buffering ? "Buffering…" : speaking && !paused ? "Pause" : "Play"}
        >
          {speaking && !paused ? (
            <Pause size={16} strokeWidth={2} />
          ) : (
            <Play size={16} strokeWidth={2} />
          )}
        </button>

        <button
          onClick={onSkipFwd}
          className="rounded-md p-1 hover:text-reader transition-colors"
          aria-label="Skip forward"
        >
          <SkipForward size={14} strokeWidth={1.75} />
        </button>

        <button
          onClick={onStop}
          className="rounded-md p-1 hover:text-reader transition-colors"
          aria-label="Stop"
        >
          <Square size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
