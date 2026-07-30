import type { TtsBackend } from "../../shared/types";

export interface TtsConfig {
  backend: TtsBackend;
  rate: number;
  voiceId: string | null;
}

const TTS_CONFIG_KEY = "tts:config";

const DEFAULT_CONFIG: TtsConfig = {
  backend: "web",
  rate: 1,
  voiceId: null,
};

export async function loadTtsConfig(): Promise<TtsConfig> {
  try {
    const raw = await window.yumi.invoke("settings:get", {
      key: TTS_CONFIG_KEY,
    });
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<TtsConfig>;
    return {
      backend:
        parsed.backend === "edge" ||
        parsed.backend === "kokoro" ||
        parsed.backend === "web"
          ? parsed.backend
          : DEFAULT_CONFIG.backend,
      rate:
        typeof parsed.rate === "number" &&
        parsed.rate >= 0.5 &&
        parsed.rate <= 2
          ? parsed.rate
          : DEFAULT_CONFIG.rate,
      voiceId:
        typeof parsed.voiceId === "string" || parsed.voiceId === null
          ? parsed.voiceId
          : DEFAULT_CONFIG.voiceId,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveTtsConfig(config: TtsConfig): void {
  void window.yumi.invoke("settings:set", {
    key: TTS_CONFIG_KEY,
    value: JSON.stringify(config),
  });
}
