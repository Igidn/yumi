import type { TtsBackend } from "../../shared/types";

export interface TtsConfig {
  backend: TtsBackend;
  rate: number;
  /** Voice selection per backend; backend voice lists are disjoint. */
  voiceIds: Record<TtsBackend, string | null>;
}

const TTS_CONFIG_KEY = "tts:config";

const DEFAULT_CONFIG: TtsConfig = {
  backend: "web",
  rate: 1,
  voiceIds: { web: null, edge: null },
};

export async function loadTtsConfig(): Promise<TtsConfig> {
  try {
    const raw = await window.yumi.invoke("settings:get", {
      key: TTS_CONFIG_KEY,
    });
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<TtsConfig> & {
      // Pre-per-backend configs stored a single voiceId for the active backend.
      voiceId?: unknown;
    };
    const stored: Partial<Record<TtsBackend, unknown>> =
      parsed.voiceIds ?? {};
    const voiceIds: Record<TtsBackend, string | null> = {
      edge: typeof stored.edge === "string" ? stored.edge : null,
      web: typeof stored.web === "string" ? stored.web : null,
    };
    if (typeof parsed.voiceId === "string") {
      const backend =
        parsed.backend === "edge" || parsed.backend === "web"
          ? parsed.backend
          : DEFAULT_CONFIG.backend;
      if (!voiceIds[backend]) voiceIds[backend] = parsed.voiceId;
    }
    return {
      backend:
        parsed.backend === "edge" || parsed.backend === "web"
          ? parsed.backend
          : DEFAULT_CONFIG.backend,
      rate:
        typeof parsed.rate === "number" &&
        parsed.rate >= 0.5 &&
        parsed.rate <= 2
          ? parsed.rate
          : DEFAULT_CONFIG.rate,
      voiceIds,
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
