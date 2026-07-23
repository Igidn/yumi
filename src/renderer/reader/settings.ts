export type ReaderTheme = "dark" | "sepia" | "light";

export interface ReaderSettings {
  /** Body text size in px. */
  fontSize: number;
  /** Unitless line-height multiplier. */
  lineHeight: number;
  theme: ReaderTheme;
}

export const READER_SETTINGS_KEY = "reader:settings";

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 19,
  lineHeight: 1.62,
  theme: "dark",
};

export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 26;

/** Line-height presets offered by the appearance menu. */
export const LINE_HEIGHT_PRESETS = [1.45, 1.62, 1.85] as const;

export function clampFontSize(size: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)));
}

export async function loadReaderSettings(): Promise<ReaderSettings> {
  try {
    const raw = await window.yumi.invoke("settings:get", {
      key: READER_SETTINGS_KEY,
    });
    if (!raw) return DEFAULT_READER_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ReaderSettings>;
    return {
      fontSize:
        typeof parsed.fontSize === "number"
          ? clampFontSize(parsed.fontSize)
          : DEFAULT_READER_SETTINGS.fontSize,
      lineHeight:
        typeof parsed.lineHeight === "number" && parsed.lineHeight > 0
          ? parsed.lineHeight
          : DEFAULT_READER_SETTINGS.lineHeight,
      theme:
        parsed.theme === "dark" ||
        parsed.theme === "sepia" ||
        parsed.theme === "light"
          ? parsed.theme
          : DEFAULT_READER_SETTINGS.theme,
    };
  } catch {
    return DEFAULT_READER_SETTINGS;
  }
}

export function saveReaderSettings(settings: ReaderSettings): void {
  // Fire-and-forget: settings are cheap to rewrite and loss is harmless.
  void window.yumi.invoke("settings:set", {
    key: READER_SETTINGS_KEY,
    value: JSON.stringify(settings),
  });
}
