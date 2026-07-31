import { listVoicesUniversal } from "edge-tts-universal";
import { ipcMain } from "electron";

import type {
  IPCPayloads,
  TtsSpeakResult,
  TtsVoice,
} from "../../shared/types";
import { synthesizeEdgeSegment } from "./edge";

interface SynthJob {
  payload: IPCPayloads["tts:speak"];
  resolve: (r: TtsSpeakResult) => void;
  reject: (e: unknown) => void;
}

// FIFO, single-flight: edge runs one WebSocket synth at a time. The
// renderer only keeps ~2 segments in flight, so the queue stays tiny.
let queue: SynthJob[] = [];
let running = false;

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    try {
      job.resolve(
        await synthesizeEdgeSegment(
          job.payload.text,
          job.payload.voice,
          job.payload.rate,
        ),
      );
    } catch (e) {
      job.reject(e);
    }
  }
  running = false;
}

let voicesCache: TtsVoice[] | null = null;

export function registerTtsHandlers(): void {
  ipcMain.handle("tts:speak", (event, payload: IPCPayloads["tts:speak"]) => {
    return new Promise<TtsSpeakResult>((resolve, reject) => {
      queue.push({ payload, resolve, reject });
      void pump().catch((e) => reject(e));
    });
  });

  // Drop queued-but-not-started synthesis. The in-flight request can't be
  // aborted (the lib exposes no signal) and finishes in ~1–2s; the renderer
  // discards its result via its generation counter.
  ipcMain.handle("tts:stop", () => {
    queue = [];
  });

  ipcMain.handle("tts:voices", async (): Promise<TtsVoice[]> => {
    if (!voicesCache) {
      const voices = await listVoicesUniversal();
      voicesCache = voices.map((v) => ({
        name: v.FriendlyName,
        lang: v.Locale,
        id: v.ShortName,
      }));
    }
    return voicesCache;
  });
}
