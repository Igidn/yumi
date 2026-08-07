import { useEffect, useRef, useState } from "react";

import { LinesIcon, THEMES } from "../reader/AppearanceMenu";
import {
  clampFontSize,
  DEFAULT_READER_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_PRESETS,
  loadReaderSettings,
  saveReaderSettings,
  type ReaderSettings,
} from "../reader/settings";

const rowLabel = "text-[12px] font-medium text-ink";

export function SettingsView() {
  const [settings, setSettings] = useState<ReaderSettings>(
    DEFAULT_READER_SETTINGS,
  );
  // Don't let the async load clobber a change the user already made.
  const dirtyRef = useRef(false);

  useEffect(() => {
    void loadReaderSettings().then((s) => {
      if (!dirtyRef.current) setSettings(s);
    });
  }, []);

  const update = (next: ReaderSettings) => {
    dirtyRef.current = true;
    setSettings(next);
    saveReaderSettings(next);
  };

  return (
    <div className="container-app select-none">
      <div className="max-w-[560px]">
        <h2 className="text-[15px] font-semibold text-ink">Settings</h2>
        <p className="mt-1 text-[12px] text-muted">
          Reading appearance and typography, applied to every book.
        </p>

        <section className="mt-6 rounded-[12px] border border-edge bg-shell/60 p-5">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            Reader
          </h3>

          {/* Theme swatches — same choices as the in-reader "AA" menu. */}
          <div className="mt-4 flex items-center justify-between">
            <span className={rowLabel}>Theme</span>
            <div className="flex gap-2">
              {THEMES.map((theme) => {
                const active = settings.theme === theme.id;
                return (
                  <button
                    key={theme.id}
                    onClick={() => update({ ...settings, theme: theme.id })}
                    aria-pressed={active}
                    title={theme.label}
                    className={`flex h-[30px] w-[30px] items-center justify-center rounded-full border-2 text-[12px] font-medium transition-transform ${
                      active ? "border-accent" : "border-edge hover:scale-105"
                    }`}
                    style={{ backgroundColor: theme.bg, color: theme.ink }}
                  >
                    A
                  </button>
                );
              })}
            </div>
          </div>

          {/* Font size stepper, same affordance as the AA menu. */}
          <div className="mt-5 flex items-center justify-between">
            <span className={rowLabel}>Text size</span>
            <div className="flex items-center rounded-[8px] border border-edge bg-field">
              <button
                onClick={() =>
                  update({
                    ...settings,
                    fontSize: clampFontSize(settings.fontSize - 1),
                  })
                }
                disabled={settings.fontSize <= FONT_SIZE_MIN}
                className="flex h-[32px] w-[40px] items-center justify-center text-muted transition-colors hover:text-ink disabled:opacity-40"
                aria-label="Decrease text size"
              >
                <span className="text-[11px] font-medium">A</span>
                <span className="text-[11px]">−</span>
              </button>
              <span className="w-[44px] text-center text-[12px] tabular-nums text-muted">
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
                className="flex h-[32px] w-[40px] items-center justify-center text-muted transition-colors hover:text-ink disabled:opacity-40"
                aria-label="Increase text size"
              >
                <span className="text-[14px] font-medium">A</span>
                <span className="text-[11px]">+</span>
              </button>
            </div>
          </div>

          {/* Line-height presets. */}
          <div className="mt-5 flex items-center justify-between">
            <span className={rowLabel}>Line spacing</span>
            <div className="flex items-center gap-1 rounded-[8px] border border-edge bg-field p-1">
              {LINE_HEIGHT_PRESETS.map((preset) => {
                const active = Math.abs(settings.lineHeight - preset) < 0.01;
                return (
                  <button
                    key={preset}
                    onClick={() => update({ ...settings, lineHeight: preset })}
                    aria-pressed={active}
                    aria-label={`Line spacing ${preset}`}
                    className={`rounded-[6px] px-2.5 py-1.5 transition-colors ${
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
          </div>

          {/* Live preview of the chosen theme + typography. Fixed height so
              the card doesn't resize when the text size or spacing changes. */}
          <div
            className={`reader-${settings.theme} mt-5 flex h-[120px] items-center overflow-hidden rounded-[8px] border border-reader-edge bg-reader px-5 py-4`}
          >
            <p
              className="reader-content text-reader"
              style={{
                fontSize: settings.fontSize,
                lineHeight: settings.lineHeight,
              }}
            >
              The reading lamp threw a warm amber circle across the page, and
              for a moment the night outside seemed to wait — patient, quiet,
              the way nights are when a story is just beginning.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
