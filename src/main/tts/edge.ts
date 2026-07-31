import { Communicate } from "edge-tts-universal";

import type { TtsSpeakResult, WordBoundary } from "../../shared/types";

const DEFAULT_VOICE = "en-US-AriaNeural";

/**
 * Synthesize one segment via Microsoft Edge's readaloud WebSocket.
 * Rate maps to SSML percentage (0.5× → -50%, 2× → +100%); word boundary
 * offsets come back in the rate-adjusted audio timeline, so the renderer
 * can use them directly for highlighting.
 */
export async function synthesizeEdgeSegment(
  text: string,
  voice: string | null,
  rate: number,
): Promise<TtsSpeakResult> {
  const ratePct = Math.round((rate - 1) * 100);
  const communicate = new Communicate(text, {
    voice: voice ?? DEFAULT_VOICE,
    rate: `${ratePct >= 0 ? "+" : ""}${ratePct}%`,
  });

  const audio: Buffer[] = [];
  const words: WordBoundary[] = [];
  for await (const chunk of communicate.stream()) {
    if (chunk.type === "audio" && chunk.data) {
      audio.push(chunk.data);
    } else if (
      chunk.type === "WordBoundary" &&
      typeof chunk.offset === "number"
    ) {
      words.push({
        // Edge reports offsets in 100-nanosecond units.
        time: chunk.offset / 10_000_000,
        duration: (chunk.duration ?? 0) / 10_000_000,
        text: chunk.text ?? "",
      });
    }
  }
  if (audio.length === 0) throw new Error("edge-tts: no audio received");

  return {
    audioBase64: Buffer.concat(audio).toString("base64"),
    mimeType: "audio/mpeg",
    words,
  };
}
