import {
  AudioLines,
  BookOpenText,
  Check,
  ChevronDown,
  Play,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { TtsBackend, TtsVoice } from "../../shared/types";
import { LinesIcon, THEMES } from "../reader/AppearanceMenu";
import {
  clampFontSize,
  DEFAULT_READER_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_PRESETS,
  loadReaderSettings,
  type ReaderSettings,
  saveReaderSettings,
} from "../reader/settings";
import {
  loadTtsConfig,
  saveTtsConfig,
  type TtsConfig,
} from "../reader/ttsSettings";

const rowLabel = "text-[12px] font-medium text-ink";
const ctrl =
  "h-9 rounded-[9px] border border-edge bg-field text-[12px] text-ink transition-colors hover:border-muted";

/** Same choices as the in-reader TTS bar. */
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const BACKENDS: TtsBackend[] = ["edge", "web"];

const SAMPLE_TEXT =
  "The reading lamp threw a warm amber circle across the page, and for a moment the night outside seemed to wait — patient, quiet, the way nights are when a story is just beginning.";

/** Click-away + Escape dismissal, mirroring the reader menus. */
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
  sub,
  children,
}: {
  active: boolean;
  onClick: () => void;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors ${
        active ? "text-accent" : "text-ink hover:bg-edge/40"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {sub && (
          <span className="block truncate text-[10px] text-muted">{sub}</span>
        )}
      </span>
      {active && <Check size={13} strokeWidth={2.5} />}
    </button>
  );
}

/** One setting row: label left, control right, hairline-separated. */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-11 items-center justify-between gap-4 px-4">
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className={rowLabel}>{label}</span>
        {hint && (
          <span className="truncate text-[11px] text-muted">{hint}</span>
        )}
      </span>
      {children}
    </div>
  );
}

/** A book-ish numbered section: roman numeral + rule, settings in a card. */
function Section({
  num,
  icon,
  title,
  aside,
  children,
}: {
  num: string;
  icon: React.ReactNode;
  title: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline gap-2">
        <span className="font-reading text-[17px] italic leading-none text-accent">
          {num}
        </span>
        <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
          <span className="text-muted">{icon}</span>
          {title}
        </h2>
        {aside && (
          <span className="ml-auto text-[11px] text-muted">{aside}</span>
        )}
      </div>
      <div className="mt-3 rounded-[14px] border border-edge/60 bg-shell">
        {children}
      </div>
    </section>
  );
}

export function SettingsView() {
  const [settings, setSettings] = useState<ReaderSettings>(
    DEFAULT_READER_SETTINGS,
  );
  const [tts, setTts] = useState<TtsConfig>({
    backend: "web",
    rate: 1,
    voiceId: null,
  });
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [voiceMenu, setVoiceMenu] = useState(false);
  const voiceRef = useDismiss(voiceMenu, () => setVoiceMenu(false));
  // Don't let the async loads clobber a change the user already made.
  const dirtyRef = useRef(false);
  const ttsDirtyRef = useRef(false);

  // Voice sample playback (edge: decoded WebAudio; web: speechSynthesis).
  const [testing, setTesting] = useState(false);
  const testCtxRef = useRef<AudioContext | null>(null);
  const stopTest = useCallback(() => {
    setTesting(false);
    window.speechSynthesis.cancel();
    void testCtxRef.current?.close();
    testCtxRef.current = null;
  }, []);

  useEffect(() => {
    void loadReaderSettings().then((s) => {
      if (!dirtyRef.current) setSettings(s);
    });
  }, []);

  useEffect(() => {
    void loadTtsConfig().then((c) => {
      if (!ttsDirtyRef.current) setTts(c);
    });
  }, []);

  // Stop any in-flight sample when the provider switches mid-play.
  const backendRef = useRef(tts.backend);
  useEffect(() => {
    if (backendRef.current !== tts.backend) {
      backendRef.current = tts.backend;
      stopTest();
    }
  }, [tts.backend, stopTest]);

  useEffect(
    () => () => {
      window.speechSynthesis.cancel();
      void testCtxRef.current?.close();
    },
    [],
  );

  // Voices for the selected provider; backend lists are disjoint.
  useEffect(() => {
    let cancelled = false;
    if (tts.backend === "edge") {
      window.yumi
        .invoke("tts:voices")
        .then((list) => {
          if (!cancelled) setVoices(list);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
    const synth = window.speechSynthesis;
    const populate = () => {
      const list = synth
        .getVoices()
        .map((v) => ({ name: v.name, lang: v.lang, id: v.voiceURI }));
      if (!cancelled) setVoices(list);
    };
    populate();
    synth.onvoiceschanged = populate;
    return () => {
      cancelled = true;
      synth.onvoiceschanged = null;
    };
  }, [tts.backend]);

  const update = (next: ReaderSettings) => {
    dirtyRef.current = true;
    setSettings(next);
    saveReaderSettings(next);
  };

  const updateTts = (next: TtsConfig) => {
    ttsDirtyRef.current = true;
    setTts(next);
    saveTtsConfig(next);
  };

  const voice = voices.find((v) => v.id === tts.voiceId) ?? null;

  /** Speak SAMPLE_TEXT with the current voice/speed; toggles to stop. */
  const handleTest = () => {
    if (testing) {
      stopTest();
      return;
    }
    setTesting(true);
    if (tts.backend === "edge") {
      window.yumi
        .invoke("tts:speak", {
          text: SAMPLE_TEXT,
          voice: tts.voiceId,
          rate: tts.rate,
        })
        .then(async (res) => {
          const ctx = new AudioContext();
          testCtxRef.current = ctx;
          const bin = atob(res.audioBase64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const buffer = await ctx.decodeAudioData(bytes.buffer);
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(ctx.destination);
          src.onended = () => {
            void ctx.close();
            testCtxRef.current = null;
            setTesting(false);
          };
          void ctx.resume();
          src.start();
        })
        .catch((err) => {
          console.error("tts sample failed", err);
          setTesting(false);
        });
    } else {
      const u = new SpeechSynthesisUtterance(SAMPLE_TEXT);
      if (voice) {
        u.voice =
          window.speechSynthesis
            .getVoices()
            .find((sv) => sv.voiceURI === voice.id) ?? null;
      }
      u.rate = tts.rate;
      u.onend = () => setTesting(false);
      window.speechSynthesis.speak(u);
    }
  };

  return (
    <div className="container-app select-none">
      <div className="mx-auto max-w-[760px] pb-20">
        <header className="pt-4">
          <div className="h-[2px] w-9 rounded-full bg-accent" />
          <h1 className="mt-4 font-reading text-[30px] leading-none text-ink">
            Settings
          </h1>
          <p className="mt-2.5 text-[13px] text-muted">
            Paper, type, and voice for the reading room.
          </p>
        </header>

        <div className="mt-8 space-y-9">
          <Section
            num="I"
            icon={<BookOpenText size={13} strokeWidth={2} />}
            title="Reader"
            aside="Applies to every book"
          >
            {/* Theme picker — three miniature pages, each in its own theme. */}
            <div className="grid grid-cols-3 gap-3 p-4 pb-3.5">
              {THEMES.map((theme) => {
                const active = settings.theme === theme.id;
                return (
                  <button
                    key={theme.id}
                    onClick={() => update({ ...settings, theme: theme.id })}
                    aria-pressed={active}
                    className="group flex flex-col text-left"
                  >
                    <span
                      className={`reader-${theme.id} relative block h-[108px] overflow-hidden rounded-[10px] border-2 px-3 py-2.5 transition-colors ${
                        active
                          ? "border-accent"
                          : "border-edge/80 group-hover:border-muted"
                      }`}
                    >
                      <span className="reader-content block text-[9.5px] leading-[1.55] text-reader">
                        {SAMPLE_TEXT}
                      </span>
                      {active && (
                        <span className="absolute right-1.5 top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-accent text-on-accent">
                          <Check size={11} strokeWidth={3} />
                        </span>
                      )}
                    </span>
                    <span
                      className={`mt-2 text-[11px] transition-colors ${
                        active ? "font-medium text-ink" : "text-muted"
                      }`}
                    >
                      {theme.label}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="divide-y divide-edge/50 border-t border-edge/50">
              {/* Font size stepper, same affordance as the AA menu. */}
              <Row label="Text size">
                <div className="flex h-9 items-center rounded-[9px] border border-edge bg-field">
                  <button
                    onClick={() =>
                      update({
                        ...settings,
                        fontSize: clampFontSize(settings.fontSize - 1),
                      })
                    }
                    disabled={settings.fontSize <= FONT_SIZE_MIN}
                    className="flex h-full w-9 items-center justify-center text-muted transition-colors hover:text-ink disabled:opacity-40"
                    aria-label="Decrease text size"
                  >
                    <span className="text-[10px] font-medium">A</span>
                    <span className="text-[10px]">−</span>
                  </button>
                  <span className="w-10 text-center text-[12px] tabular-nums text-muted">
                    {settings.fontSize}px
                  </span>
                  <button
                    onClick={() =>
                      update({
                        ...settings,
                        fontSize: clampFontSize(settings.fontSize + 1),
                      })
                    }
                    disabled={settings.fontSize >= FONT_SIZE_MAX}
                    className="flex h-full w-9 items-center justify-center text-muted transition-colors hover:text-ink disabled:opacity-40"
                    aria-label="Increase text size"
                  >
                    <span className="text-[13px] font-medium">A</span>
                    <span className="text-[10px]">+</span>
                  </button>
                </div>
              </Row>

              {/* Line-height presets. */}
              <Row label="Line spacing">
                <div className="flex items-center gap-0.5 rounded-[9px] border border-edge bg-field p-0.5">
                  {LINE_HEIGHT_PRESETS.map((preset) => {
                    const active = Math.abs(settings.lineHeight - preset) < 0.01;
                    return (
                      <button
                        key={preset}
                        onClick={() => update({ ...settings, lineHeight: preset })}
                        aria-pressed={active}
                        aria-label={`Line spacing ${preset}`}
                        className={`flex h-8 w-10 items-center justify-center rounded-[7px] transition-colors ${
                          active
                            ? "bg-pill text-ink"
                            : "text-muted hover:bg-edge/40 hover:text-ink"
                        }`}
                      >
                        <LinesIcon
                          tight={preset === LINE_HEIGHT_PRESETS[0]}
                          loose={preset === LINE_HEIGHT_PRESETS[2]}
                          className="text-current"
                        />
                      </button>
                    );
                  })}
                </div>
              </Row>
            </div>

            {/* Live page preview in the chosen theme + typography. */}
            <div className="border-t border-edge/50 px-4 py-4">
              <div
                className={`reader-${settings.theme} rounded-[10px] border border-reader-edge bg-reader px-5 pb-4 pt-3`}
              >
                <p className="font-logo text-[9px] uppercase tracking-[0.22em] text-reader-muted">
                  Preview
                </p>
                <p
                  className="reader-content mt-1.5 text-reader"
                  style={{
                    fontSize: settings.fontSize,
                    lineHeight: settings.lineHeight,
                  }}
                >
                  {SAMPLE_TEXT}
                </p>
              </div>
            </div>
          </Section>

          <Section
            num="II"
            icon={<AudioLines size={13} strokeWidth={2} />}
            title="Text to speech"
            aside="Applies to the next book you open"
          >
            <div className="divide-y divide-edge/50">
              {/* Provider — same choices as the in-reader TTS bar. */}
              <Row label="Provider">
                <div className="flex items-center gap-0.5 rounded-[9px] border border-edge bg-field p-0.5">
                  {BACKENDS.map((b) => {
                    const active = tts.backend === b;
                    return (
                      <button
                        key={b}
                        onClick={() =>
                          updateTts({ ...tts, backend: b, voiceId: null })
                        }
                        aria-pressed={active}
                        className={`rounded-[7px] px-3.5 py-1 text-[12px] capitalize transition-colors ${
                          active
                            ? "bg-pill text-ink"
                            : "text-muted hover:bg-edge/40 hover:text-ink"
                        }`}
                      >
                        {b}
                      </button>
                    );
                  })}
                </div>
              </Row>

              {/* Voice dropdown — mirrors the TTS bar's voice menu. */}
              <Row label="Voice">
                <div ref={voiceRef} className="relative">
                  <button
                    onClick={() => setVoiceMenu((m) => !m)}
                    aria-haspopup="listbox"
                    aria-expanded={voiceMenu}
                    className={`${ctrl} flex max-w-[240px] items-center gap-1.5 px-3`}
                  >
                    <span className="max-w-[190px] truncate">
                      {voice ? `${voice.name} · ${voice.lang}` : "Default voice"}
                    </span>
                    <ChevronDown
                      size={12}
                      strokeWidth={2}
                      className={`shrink-0 text-muted transition-transform ${
                        voiceMenu ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                  {voiceMenu && (
                    <div
                      role="listbox"
                      className="absolute right-0 top-full z-30 mt-1 max-h-64 w-72 overflow-y-auto rounded-xl border border-edge bg-shell p-1 shadow-shell"
                    >
                      <MenuItem
                        active={voice === null}
                        onClick={() => {
                          updateTts({ ...tts, voiceId: null });
                          setVoiceMenu(false);
                        }}
                      >
                        Default voice
                      </MenuItem>
                      {voices.map((v) => (
                        <MenuItem
                          key={v.id}
                          active={voice?.id === v.id}
                          sub={v.lang}
                          onClick={() => {
                            updateTts({ ...tts, voiceId: v.id });
                            setVoiceMenu(false);
                          }}
                        >
                          {v.name}
                        </MenuItem>
                      ))}
                    </div>
                  )}
                </div>
              </Row>

              {/* Playback speed presets. */}
              <Row label="Playback speed">
                <div className="flex items-center gap-0.5 rounded-[9px] border border-edge bg-field p-0.5">
                  {SPEEDS.map((s) => {
                    const active = tts.rate === s;
                    return (
                      <button
                        key={s}
                        onClick={() => updateTts({ ...tts, rate: s })}
                        aria-pressed={active}
                        aria-label={`Playback speed ${s} times`}
                        className={`rounded-[7px] px-2 py-1 text-[12px] tabular-nums transition-colors ${
                          active
                            ? "bg-pill text-ink"
                            : "text-muted hover:bg-edge/40 hover:text-ink"
                        }`}
                      >
                        {s}&times;
                      </button>
                    );
                  })}
                </div>
              </Row>

              {/* Audition the current voice + speed before opening a book. */}
              <Row label="Test voice" hint="Plays a sample">
                <button
                  onClick={handleTest}
                  className={`flex h-9 items-center gap-1.5 rounded-[9px] px-3.5 text-[12px] font-medium transition-colors ${
                    testing
                      ? "bg-pill text-ink"
                      : "border border-edge bg-field text-ink hover:border-muted"
                  }`}
                >
                  {testing ? (
                    <Square size={11} strokeWidth={2.5} />
                  ) : (
                    <Play size={11} strokeWidth={2.5} className="text-accent" />
                  )}
                  {testing ? "Stop" : "Play sample"}
                </button>
              </Row>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
