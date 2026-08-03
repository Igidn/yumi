import {
  Check,
  ChevronDown,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
  Volume2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { TtsBackend, TtsVoice } from "../../shared/types";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const BACKENDS: TtsBackend[] = ["edge", "web"];
const EQ_DELAYS = [0, 0.18, 0.36];

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

/** Click-away + Escape dismissal, mirroring ContextMenu. */
function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const id = setTimeout(() => {
      window.addEventListener("keydown", onKey);
      window.addEventListener("click", onClick);
    }, 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, [open, onClose]);
  return ref;
}

function MenuItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors ${
        active ? "text-reader-accent" : "text-reader hover:bg-reader-edge/40"
      }`}
    >
      <span className="flex-1 truncate">{children}</span>
      {active && <Check size={13} strokeWidth={2.5} />}
    </button>
  );
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
  const [menu, setMenu] = useState<"voice" | "speed" | null>(null);
  const voiceRef = useDismiss(menu === "voice", () => setMenu(null));
  const speedRef = useDismiss(menu === "speed", () => setMenu(null));

  const playing = speaking && !paused;

  return (
    <div
      className={`absolute bottom-6 left-1/2 z-20 -translate-x-1/2 rounded-full border border-reader-edge bg-reader-chrome px-2 py-1 shadow-lg transition-all duration-250 ${
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-3 opacity-0"
      }`}
    >
      <div className="flex items-center gap-0.5 text-[12px] text-reader-muted">
        {/* Backend switcher */}
        <div className="mr-1 flex rounded-full bg-reader-edge/40 p-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]">
          {BACKENDS.map((b) => (
            <button
              key={b}
              onClick={() => onBackendChange(b)}
              className={`rounded-full px-1.5 py-0.5 transition-colors ${
                backend === b
                  ? "bg-reader-ink text-reader-bg"
                  : "hover:text-reader"
              }`}
              aria-pressed={backend === b}
            >
              {b}
            </button>
          ))}
        </div>

        {/* Voice */}
        {voices.length > 0 && (
          <div ref={voiceRef} className="relative">
            <button
              onClick={() => setMenu((m) => (m === "voice" ? null : "voice"))}
              className={`flex max-w-[140px] items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium transition-colors ${
                menu === "voice"
                  ? "bg-reader-edge/50 text-reader"
                  : "hover:bg-reader-edge/30 hover:text-reader"
              }`}
              aria-haspopup="listbox"
              aria-expanded={menu === "voice"}
              aria-label="Voice"
            >
              <Volume2 size={13} strokeWidth={1.75} className="shrink-0" />
              <span className="truncate">{voice?.name ?? "Default"}</span>
              <ChevronDown
                size={11}
                strokeWidth={2}
                className={`shrink-0 transition-transform ${
                  menu === "voice" ? "rotate-180" : ""
                }`}
              />
            </button>
            {menu === "voice" && (
              <div
                role="listbox"
                className="absolute bottom-full left-1/2 z-30 mb-2 max-h-64 w-56 -translate-x-1/2 overflow-y-auto rounded-xl border border-reader-edge bg-reader-chrome p-1 shadow-xl"
              >
                <MenuItem active={voice === null} onClick={() => setMenu(null)}>
                  Default
                </MenuItem>
                {voices.map((v) => (
                  <MenuItem
                    key={v.id}
                    active={voice?.id === v.id}
                    onClick={() => {
                      onVoiceChange(v);
                      setMenu(null);
                    }}
                  >
                    {v.name}
                  </MenuItem>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Speed */}
        <div ref={speedRef} className="relative">
          <button
            onClick={() => setMenu((m) => (m === "speed" ? null : "speed"))}
            className={`flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium tabular-nums transition-colors ${
              menu === "speed"
                ? "bg-reader-edge/50 text-reader"
                : "hover:bg-reader-edge/30 hover:text-reader"
            }`}
            aria-haspopup="listbox"
            aria-expanded={menu === "speed"}
            aria-label="Speed"
          >
            {rate}&times;
            <ChevronDown
              size={11}
              strokeWidth={2}
              className={`transition-transform ${
                menu === "speed" ? "rotate-180" : ""
              }`}
            />
          </button>
          {menu === "speed" && (
            <div
              role="listbox"
              className="absolute bottom-full left-1/2 z-30 mb-2 w-24 -translate-x-1/2 rounded-xl border border-reader-edge bg-reader-chrome p-1 shadow-xl"
            >
              {SPEEDS.map((s) => (
                <MenuItem
                  key={s}
                  active={rate === s}
                  onClick={() => {
                    onRateChange(s);
                    setMenu(null);
                  }}
                >
                  {s}&times;
                </MenuItem>
              ))}
            </div>
          )}
        </div>

        <span className="mx-1 h-4 w-px bg-reader-edge" />

        {/* Live equalizer while speaking — slot always reserved so the
            bar doesn't resize when play/pause toggles. Idle bars rest at
            quarter height in the edge color. */}
        <span
          className="flex h-3.5 w-4 shrink-0 items-end justify-center gap-[2px]"
          aria-hidden
        >
          {EQ_DELAYS.map((d) => (
            <span
              key={d}
              className={`w-[2.5px] origin-bottom rounded-full transition-colors duration-200 ${
                playing
                  ? "bg-reader-accent animate-[reader-eq_0.9s_ease-in-out_infinite]"
                  : "scale-y-[0.25] bg-reader-edge"
              }`}
              style={{ height: "100%", animationDelay: `${d}s` }}
            />
          ))}
        </span>

        {/* Transport */}
        <button
          onClick={onSkipBack}
          className="rounded-full p-1.5 transition-colors hover:bg-reader-edge/30 hover:text-reader"
          aria-label="Skip back"
        >
          <SkipBack size={14} strokeWidth={1.75} />
        </button>

        <button
          onClick={onPlayPause}
          className={`mx-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-accent text-on-accent shadow-md transition-[filter,transform] hover:brightness-110 active:scale-95 ${
            buffering ? "animate-pulse" : ""
          }`}
          aria-label={buffering ? "Buffering…" : playing ? "Pause" : "Play"}
        >
          {playing ? (
            <Pause size={12} strokeWidth={2.5} fill="currentColor" />
          ) : (
            <Play
              size={12}
              strokeWidth={2.5}
              fill="currentColor"
              className="ml-0.5"
            />
          )}
        </button>

        <button
          onClick={onSkipFwd}
          className="rounded-full p-1.5 transition-colors hover:bg-reader-edge/30 hover:text-reader"
          aria-label="Skip forward"
        >
          <SkipForward size={14} strokeWidth={1.75} />
        </button>

        <button
          onClick={onStop}
          className="rounded-full p-1.5 transition-colors hover:bg-reader-edge/30 hover:text-reader"
          aria-label="Stop"
        >
          <Square size={12} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
