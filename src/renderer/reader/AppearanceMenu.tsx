import {
  clampFontSize,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_PRESETS,
  type ReaderSettings,
  type ReaderTheme,
} from "./settings";

export const THEMES: { id: ReaderTheme; label: string; bg: string; ink: string }[] = [
  { id: "light", label: "Light", bg: "#ffffff", ink: "#1c1c1e" },
  { id: "sepia", label: "Sepia", bg: "#f3ead6", ink: "#463926" },
  { id: "dark", label: "Dark", bg: "#19160c", ink: "#e8e3d8" },
];

/**
 * The "AA" popover, after Apple Books: theme swatches, a font-size stepper,
 * and line-height presets. Changes apply live and persist via app settings.
 */
export function AppearanceMenu({
  settings,
  onChange,
  onClose,
}: {
  settings: ReaderSettings;
  onChange: (next: ReaderSettings) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden />
      <div
        className="fixed right-3 top-[56px] z-30 w-[248px] rounded-[12px] border border-reader-edge bg-reader-chrome/95 p-4 shadow-shell backdrop-blur-md"
        role="dialog"
        aria-label="Appearance"
      >
        {/* Themes */}
        <div className="flex justify-between">
          {THEMES.map((theme) => {
            const active = settings.theme === theme.id;
            return (
              <button
                key={theme.id}
                onClick={() => onChange({ ...settings, theme: theme.id })}
                className="flex flex-col items-center gap-1.5 outline-none"
                aria-pressed={active}
              >
                <span
                  className={`flex h-[44px] w-[44px] items-center justify-center rounded-full border-2 text-[13px] font-medium transition-transform ${
                    active
                      ? "border-reader-accent"
                      : "border-reader-edge hover:scale-105"
                  }`}
                  style={{ backgroundColor: theme.bg, color: theme.ink }}
                >
                  A
                </span>
                <span
                  className={`text-[11px] ${active ? "text-reader" : "text-reader-muted"}`}
                >
                  {theme.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* Font size */}
        <div className="mt-4 border-t border-reader-edge pt-4">
          <div className="flex items-center justify-between rounded-[8px] border border-reader-edge">
            <button
              onClick={() =>
                onChange({
                  ...settings,
                  fontSize: clampFontSize(settings.fontSize - 1),
                })
              }
              disabled={settings.fontSize <= FONT_SIZE_MIN}
              className="flex h-[34px] w-[44px] items-center justify-center text-reader-muted transition-colors hover:text-reader disabled:opacity-40"
              aria-label="Decrease font size"
            >
              <span className="text-[12px] font-medium">A</span>
              <span className="text-[12px]">−</span>
            </button>
            <span className="text-[12px] tabular-nums text-reader-muted">
              {settings.fontSize}
            </span>
            <button
              onClick={() =>
                onChange({
                  ...settings,
                  fontSize: clampFontSize(settings.fontSize + 1),
                })
              }
              disabled={settings.fontSize >= FONT_SIZE_MAX}
              className="flex h-[34px] w-[44px] items-center justify-center text-reader-muted transition-colors hover:text-reader disabled:opacity-40"
              aria-label="Increase font size"
            >
              <span className="text-[16px] font-medium">A</span>
              <span className="text-[13px]">+</span>
            </button>
          </div>
        </div>

        {/* Line height */}
        <div className="mt-3 flex items-center justify-between rounded-[8px] border border-reader-edge px-2 py-1.5">
          {LINE_HEIGHT_PRESETS.map((preset) => {
            const active = Math.abs(settings.lineHeight - preset) < 0.01;
            return (
              <button
                key={preset}
                onClick={() => onChange({ ...settings, lineHeight: preset })}
                aria-pressed={active}
                aria-label={`Line height ${preset}`}
                className={`rounded-[6px] px-2.5 py-1.5 transition-colors ${
                  active ? "bg-reader-edge/70" : "hover:bg-reader-edge/40"
                }`}
              >
                <LinesIcon
                  tight={preset === LINE_HEIGHT_PRESETS[0]}
                  loose={preset === LINE_HEIGHT_PRESETS[2]}
                />
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

export function LinesIcon({
  tight,
  loose,
  className = "text-reader",
}: {
  tight?: boolean;
  loose?: boolean;
  className?: string;
}) {
  const gap = tight ? 3 : loose ? 7 : 5;
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      <line x1="3" y1={9 - gap} x2="15" y2={9 - gap} />
      <line x1="3" y1="9" x2="15" y2="9" />
      <line x1="3" y1={9 + gap} x2="15" y2={9 + gap} />
    </svg>
  );
}
