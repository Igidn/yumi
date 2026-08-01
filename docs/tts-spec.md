# TTS Spec — Yumi

## Goal

Apple Books-style text-to-speech via context menu: user selects text,
right-clicks, picks "Speak" from the context menu, and TTS reads from the
selected word onward, auto-advancing through spreads and chapters until
stopped.

## Backends

Three backends, ranked by quality. User picks in settings; default is Edge
(free, best voices, requires internet). The app falls back to Web Speech API
if the chosen backend is unavailable.

### 1. Edge TTS (default)

Microsoft's free Edge TTS API. No API key. 200+ neural voices across 100+
languages. Requires internet.

- Protocol: WebSocket to `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud`
- Input: SSML with text, voice, rate, pitch.
- Output: binary stream of MP3 audio + `Path: wordboundary` JSON markers
  interleaved per sentence.
- npm: `edge-tts` (JS client), or implement directly with `ws` + proper
  `X-*` auth headers.

### 2. Kokoro TTS

Local neural TTS (82M params), runs via ONNX Runtime. Zero network, fully
private. Excellent quality, fast on GPU, acceptable on CPU. Requires
downloading ~300MB of model weights on first use.

- npm: `kokoro-js` wraps the ONNX model. First run downloads weights to the
  app's userData directory.
- Output: raw PCM f32 audio at 24kHz + phoneme-level timestamps.
- Voices: ~20 mixable voices (American/British English, Japanese, Mandarin,
  French, Korean, etc.). Voice is selected by name (e.g. `af_bella`,
  `am_adam`).

### 3. Web Speech API (fallback)

Built into Chromium. Zero deps, offline. Quality varies wildly by OS:
passable on macOS, poor on Windows, none on Linux.

### Backend selection

Persisted in `app_settings` under `tts:backend` (`"edge" | "kokoro" | "web"`).
Picker in Settings view + a shortcut dropdown in the TTS control bar.

Voice picker populates from the active backend.
Speed applies uniformly (Edge/Kokoro map to SSML `rate` or model speed;
Web Speech API uses `utterance.rate`).

## Architecture

```
            Renderer                              Main Process
            ────────                              ────────────
ReaderView
  ├─ ContextMenu
  ├─ useTts (hook)
  │    ├─ web: window.speechSynthesis (direct)
  │    └─ edge|kokoro: IPC invoke/on
  └─ TtsBar
                              IPC
       tts:speak ────────────────►  TtsBackend (edge or kokoro)
       tts:pause ───────────────►    synthesizes segment →
       tts:resume ──────────────►    returns audio + word
       tts:stop ────────────────►    boundary metadata

       tts:audio-ready ◄──────────  { audio: base64, words: WordBoundary[] }
       tts:audio-ended ◄──────────  synthesis complete
```

### IPC channels (new)

```ts
// shared/types.ts additions
"tts:speak"; // → { text: string, voice: string, rate: number }
"tts:pause"; // → void
"tts:resume"; // → void
"tts:stop"; // → void
"tts:backend"; // → { backend: "edge" | "kokoro" | "web" }
"tts:voices"; // → void (returns available voices for current backend)
```

### IPC events (main → renderer)

```ts
type TtsEvent =
  | "tts:audio-ready" // { audioBase64: string, words: WordBoundary[], mimeType: string }
  | "tts:audio-ended"; // void
```

### Word boundary

```ts
interface WordBoundary {
  /** Offset in seconds from the start of this segment's audio. */
  time: number;
  /** Duration in seconds. */
  duration: number;
  /** The word text. Used only for debug; highlighting is driven by character offset. */
  text: string;
  /** Character offset within the original segment text (0-indexed). */
  charOffset: number;
  charLength: number;
}
```

### Audio playback

Edge and Kokoro produce full-segment audio as a single buffer (a spread's
worth of text — 20–60 seconds). Renderer plays it via `AudioContext` +
`AudioBufferSourceNode`. Word boundaries drive `highlightBlockIndex` updates
via `setTimeout` scheduling or `sourceNode.onended` → `requestAnimationFrame`
loop checking elapsed time.

`pause()` → `audioContext.suspend()`, `resume()` → `audioContext.resume()`.
The `AudioContext.currentTime` tracks elapsed offset for highlight sync.

`stop()` → stop source node, cancel any pending synthesis IPC.

## Trigger flow

```
User selects text in the reader
       ↓
Right-clicks (or long-press on trackpad)
       ↓
Custom context menu appears at cursor position
  ┌──────────────┐
  │  🔊 Speak     │
  └──────────────┘
       ↓
TTS starts from the first selected word
Control bar appears at bottom center
```

No speaker button in the header.

## Selection → utterance mapping

When the user invokes "Speak":

1. `window.getSelection()` gives the selection range.
2. Walk up from `range.startContainer` to find the nearest element with a
   `data-b` attribute → this is the starting block index.
3. Compute the character offset within that block's `textContent`.
4. Build the segment text:
   - **First block**: `block.text.slice(startCharOffset)`
   - **Subsequent blocks** in current spread: full `block.text`
   - **Skip images** (`ContentBlock.type === "image"`)
5. Send segment text to the TTS backend. Track which block each character
   belongs to via accumulated block lengths, so word boundaries can be mapped
   to `highlightBlockIndex`.

## Data flow

```
ReaderView
  ├─ ttsActive: boolean
  ├─ ttsBackend: "edge" | "kokoro" | "web"
  ├─ ttsBlockIndex: number | null
  └─ spread (existing state)

PagedChapter
  ├─ highlightBlockIndex?: number
  └─ onContextMenu?: (e: MouseEvent, selection: TtsSelection | null) => void

TtsBar (bottom center)
  ├─ useTts hook (backend-agnostic API)
  └─ speed, play/pause, skip/back, stop, backend switcher, voice picker
```

## UI

### Context menu

At mouse cursor, auto-dismissed on click-away or Escape:

```
┌──────────────┐
│  🔊  Speak   │
└──────────────┘
```

Shows only when text is selected. Icon: `Volume2` from lucide-react.

### Control bar

Bottom-center of reading surface:

```
        ┌─────────────────────────────────────────────────────┐
        │ [Edge ▾]  [1× ▾]  [◂◂]  [▶]  [▸▸]  [⏹]  [voice ▾] │
        └─────────────────────────────────────────────────────┘
```

- **Backend switcher** — `Edge` | `Kokoro` | `Web`. Updates voice list on change.
- **Speed selector** — 0.5×, 0.75×, 1×, 1.25×, 1.5×, 1.75×, 2×.
- **Skip back** — restart current spread.
- **Play/Pause** — toggle.
- **Skip forward** — next spread.
- **Stop** — dismiss bar, clear state.
- **Voice picker** — populated from active backend.

Bar slides up/down with `translateY` + `opacity` transition.

### Paragraph highlight

CSS class `reader-tts-speaking` on the current `<p>` / heading. Driven by
word boundary timing — map elapsed audio time to `charOffset` → block index.

## Behavior

| Action                               | Behavior                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| "Speak" on selected text             | Synthesize segment from selection point.                                                           |
| Segment ends, more spreads remain    | Auto-page right, synthesize next spread.                                                           |
| Segment ends, last spread of chapter | Advance chapter, spread 0. If last chapter, stop.                                                  |
| User pages manually during TTS       | Stop current, synthesize new spread.                                                               |
| Pause / Resume                       | `AudioContext.suspend()` / `resume()` (edge/kokoro). `speechSynthesis.pause()` / `resume()` (web). |
| Skip back                            | Re-synthesize current spread from start.                                                           |
| Skip forward                         | Next spread.                                                                                       |
| Stop                                 | Cancel synthesis, dismiss bar.                                                                     |
| Window closes                        | Stop playback, cancel pending IPC.                                                                 |
| Backend unavailable                  | Fall back to Web Speech API, show toast.                                                           |
| Edge offline                         | Fall back to Web Speech API or Kokoro if model is downloaded.                                      |

## `useTts` hook API

```ts
interface TtsSelection {
  blockIndex: number;
  charOffset: number;
}

type TtsBackend = "edge" | "kokoro" | "web";

interface TtsVoice {
  name: string;
  lang: string;
  /** Voice ID for the backend (e.g. "en-US-AriaNeural" for Edge, "af_bella" for Kokoro). */
  id: string;
}

function useTts(
  spreadBlocks: ContentBlock[],
  onPageRight: () => void,
): {
  start: (origin: TtsSelection) => void;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  skipBack: () => void;
  skipFwd: () => void;
  rate: number;
  setRate: (r: number) => void;
  backend: TtsBackend;
  setBackend: (b: TtsBackend) => void;
  voice: TtsVoice | null;
  setVoice: (v: TtsVoice) => void;
  voices: TtsVoice[];
  speaking: boolean;
  paused: boolean;
  highlightBlockIndex: number | null;
  active: boolean;
};
```

## New files

| File                                  | Purpose                                                               |
| ------------------------------------- | --------------------------------------------------------------------- |
| `src/renderer/reader/useTts.ts`       | Hook: backend-agnostic TTS lifecycle, block tracking, spread advance. |
| `src/renderer/reader/TtsBar.tsx`      | Bottom-center control bar.                                            |
| `src/renderer/reader/ContextMenu.tsx` | "Speak" context menu.                                                 |
| `src/main/tts/edge.ts`                | Edge TTS backend: SSML → audio buffer + word boundaries.              |
| `src/main/tts/kokoro.ts`              | Kokoro backend: ONNX inference → PCM audio + phoneme timestamps.      |
| `src/main/tts/index.ts`               | Backend factory, IPC handler registration, voice listing.             |

## Changes to existing files

| File                                   | What changes                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/types.ts`                  | Add `TtsBackend`, `WordBoundary`, `TtsVoice`, IPC channel/event types.                                                          |
| `src/main/ipc.ts`                      | Register `tts:*` handlers, forward `tts:audio-ready` / `tts:audio-ended` events.                                                |
| `src/main/preload.ts`                  | Expose `tts:*` invoke + `on("tts:audio-ready", ...)` / `on("tts:audio-ended", ...)` subscription.                               |
| `src/renderer/reader/PagedChapter.tsx` | Add `highlightBlockIndex` and `onContextMenu` props.                                                                            |
| `src/renderer/views/ReaderView.tsx`    | Wire `useTts`, `TtsBar`, `ContextMenu`.                                                                                         |
| `src/renderer/globals.css`             | `.reader-tts-speaking` per theme.                                                                                               |
| `src/renderer/views/SettingsView.tsx`  | Add TTS backend preference.                                                                                                     |
| `package.json`                         | Add `ws` (Edge TTS WebSocket), `kokoro-js` (Kokoro ONNX wrapper), `node-audio-context` or use Electron's Web Audio in renderer. |

## Dependencies

```json
{
  "ws": "^8.x",
  "kokoro-js": "^1.x"
}
```

`ws` is lightweight (Edge TTS uses WebSocket). `kokoro-js` bundles ONNX
runtime and downloads model weights on first synthesis. Initial download is
~300MB; show a progress indicator in the control bar on first use.

## CSS additions

```css
/* dark */
.reader-dark .reader-tts-speaking {
  background: rgba(255 255 255 / 0.08);
  border-radius: 3px;
}
/* sepia */
.reader-sepia .reader-tts-speaking {
  background: rgba(180 140 80 / 0.15);
  border-radius: 3px;
}
/* light */
.reader-light .reader-tts-speaking {
  background: rgba(0 0 0 / 0.06);
  border-radius: 3px;
}
```

## Edge cases

- **Selection spanning multiple blocks**: use start of range.
- **Selection inside a heading**: same as paragraphs; headings carry `data-b`.
- **Selection on an image**: `TtsSelection` is `null` → no "Speak" in menu.
- **Selection inside `<a data-chapter>`**: walk up to nearest `data-b` parent.
- **Empty blocks**: included; synth handles pauses.
- **LaTeX**: raw source. Acceptable.
- **Empty spread**: skip to next.
- **Edge offline / Kokoro model not downloaded**: fall back to Web Speech
  API, show toast "Voice quality reduced — using system TTS."
- **Rapid stop/start**: cancel pending IPC + stop current audio before new
  synthesis.
- **Kokoro model download**: show progress bar in TtsBar. Persist download
  path to `app_settings:tts:kokoro-model-path`. The model is ~300MB; store in
  Electron `userData/` directory.
