import "@excalidraw/excalidraw/index.css";

import { Excalidraw, getSceneVersion, restore } from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import { useEffect, useRef } from "react";

import type { SceneBlob } from "../../shared/types";

const SAVE_DEBOUNCE_MS = 500;

/**
 * Only these AppState fields are persisted in the scene blob: the viewport
 * (so a canvas re-opens where it was left) and the current tool styling. All
 * the ephemeral editing state (selection, dragging, editing element, …) is
 * dropped, which keeps blobs small and restores glitch-free.
 */
const PERSISTED_APPSTATE_KEYS = [
  "scrollX",
  "scrollY",
  "zoom",
  "viewBackgroundColor",
  "gridModeEnabled",
  "theme",
  "currentItemStrokeColor",
  "currentItemBackgroundColor",
  "currentItemFillStyle",
  "currentItemStrokeWidth",
  "currentItemStrokeStyle",
  "currentItemRoughness",
  "currentItemOpacity",
  "currentItemFontFamily",
  "currentItemFontSize",
  "currentItemTextAlign",
  "currentItemStartArrowhead",
  "currentItemEndArrowhead",
] as const satisfies readonly (keyof AppState)[];

function pickPersistedAppState(appState: AppState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PERSISTED_APPSTATE_KEYS) {
    out[key] = appState[key];
  }
  return out;
}

/** Defaults for a fresh canvas (dark notepad on the panel's glass). */
// viewBackgroundColor is stored in light-mode form; the dark theme
// filter (invert 93% + hue-rotate 180°) maps #ffffff → ~#121212.
const DEFAULT_SCENE_APP_STATE: Record<string, unknown> = {
  theme: "dark",
  viewBackgroundColor: "#ffffff",
  gridModeEnabled: false,
  currentItemStrokeColor: "#1e1e1e",
};

/**
 * Reduce a loaded blob's appState to the persisted subset. Blobs written by
 * older/foreign code may carry runtime-only fields (e.g. collaborators as a
 * plain object) that crash Excalidraw when fed back as-is.
 */
function sanitizeLoadedAppState(
  raw: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out = { ...DEFAULT_SCENE_APP_STATE };
  if (!raw) return out;
  for (const key of PERSISTED_APPSTATE_KEYS) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

/** Fingerprint of the viewport, used to detect pan/zoom-only changes. */
function viewportKey(appState: {
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
}): string {
  return `${appState.scrollX.toFixed(4)},${appState.scrollY.toFixed(4)},${appState.zoom.value.toFixed(4)}`;
}

interface Debounced<A extends unknown[]> {
  (...args: A): void;
  flush(): void;
  cancel(): void;
}

function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): Debounced<A> {
  let timer: number | null = null;
  let pending: A | null = null;

  const run = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };

  const debounced = (...args: A) => {
    pending = args;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(run, ms);
  };
  debounced.flush = () => {
    if (timer === null && pending === null) return;
    run();
  };
  debounced.cancel = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return debounced;
}

/**
 * The Excalidraw drawing surface for one tab. Remounted per tab (keyed by
 * tabId in FloatingPanel), which resets Excalidraw's internal undo stack —
 * the correct per-tab behavior.
 *
 * Persistence: every onChange is debounce-saved as a full scene blob; the
 * main process broadcasts it to other windows, which apply it via
 * updateScene without remounting.
 */
export function DrawingSurface({
  tabId,
  position,
}: {
  tabId: string;
  /**
   * Panel viewport rect. Excalidraw caches its DOM offset for pointer→canvas
   * mapping and only refreshes it on resize/scroll — moving the fixed panel
   * (pure left/top change) fires neither, desyncing the pen. Refreshing here
   * keeps the cached offset in sync with the panel's position.
   */
  position: { x: number; y: number; width: number; height: number };
}) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  useEffect(() => {
    apiRef.current?.refresh();
  }, [position.x, position.y, position.width, position.height]);
  /**
   * Fingerprint of the last scene this window persisted or applied. onChange
   * fires for our own updateScene calls too — without this guard, two open
   * windows would ping-pong the same scene back and forth forever.
   */
  const lastPersistedRef = useRef({ elementsVersion: 0, viewportKey: "" });

  const saveScene = async (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
  ) => {
    const blob: SceneBlob = {
      elements,
      appState: pickPersistedAppState(appState),
    };
    await window.yumi.invoke("drawing:save-scene", {
      tabId,
      sceneData: JSON.stringify(blob),
    });
  };

  const saveRef = useRef(saveScene);
  const debouncedSaveRef = useRef<Debounced<
    [readonly OrderedExcalidrawElement[], AppState]
  > | null>(null);

  useEffect(() => {
    saveRef.current = saveScene;
  });

  // Flush any pending save when the tab unmounts (switch/close), so the
  // debounce window never swallows the user's last stroke.
  useEffect(() => {
    const debounced = debounce(
      (elements: readonly OrderedExcalidrawElement[], appState: AppState) => {
        void saveRef.current(elements, appState).catch(console.error);
      },
      SAVE_DEBOUNCE_MS,
    );
    debouncedSaveRef.current = debounced;
    return () => debounced.flush();
  }, []);

  // Apply scenes changed in other windows (blob is authoritative).
  useEffect(() => {
    const unsub = window.yumi.on("drawing:scene-updated", (_data: unknown) => {
      const data = _data as { tabId: string; sceneData: string | null };
      if (data.tabId !== tabId) return;
      const api = apiRef.current;
      if (!api) return;

      const blob: SceneBlob | null = data.sceneData
        ? (JSON.parse(data.sceneData) as SceneBlob)
        : null;
      const restored = restore(
        {
          elements: (blob?.elements ?? []) as never,
          appState: sanitizeLoadedAppState(blob?.appState),
        },
        null,
        null,
      );

      // Seed the guard before applying, so the onChange triggered by our own
      // updateScene is recognized as an echo and skipped.
      lastPersistedRef.current = {
        elementsVersion: getSceneVersion(restored.elements),
        viewportKey: viewportKey(restored.appState),
      };
      // A pending debounced save holds pre-update state; the incoming blob
      // wins, so drop it.
      debouncedSaveRef.current?.cancel();

      api.updateScene({
        elements: restored.elements,
        appState: {
          scrollX: restored.appState.scrollX,
          scrollY: restored.appState.scrollY,
          zoom: restored.appState.zoom,
        },
      });
    });
    return unsub;
  }, [tabId]);

  return (
    <div className="yumi-excalidraw min-h-0 flex-1">
      <Excalidraw
        theme="dark"
        excalidrawAPI={(api) => {
          apiRef.current = api;
        }}
        initialData={async () => {
          const raw = await window.yumi.invoke("drawing:load-scene", { tabId });
          const blob: SceneBlob | null = raw
            ? (JSON.parse(raw) as SceneBlob)
            : null;
          const elements = (blob?.elements ??
            []) as unknown as OrderedExcalidrawElement[];
          const appState = sanitizeLoadedAppState(blob?.appState);

          // Seed the guard with the loaded scene so the onChange that may
          // follow the initialData application doesn't re-save it.
          lastPersistedRef.current = {
            elementsVersion: getSceneVersion(elements),
            viewportKey: viewportKey({
              scrollX: (appState.scrollX as number) ?? 0,
              scrollY: (appState.scrollY as number) ?? 0,
              zoom: (appState.zoom as { value: number }) ?? { value: 1 },
            }),
          };

          return { elements, appState };
        }}
        onChange={(elements, appState) => {
          const fingerprint = {
            elementsVersion: getSceneVersion(elements),
            viewportKey: viewportKey(appState),
          };
          const last = lastPersistedRef.current;
          if (
            fingerprint.elementsVersion === last.elementsVersion &&
            fingerprint.viewportKey === last.viewportKey
          ) {
            return; // echo of our own load/updateScene — nothing to save
          }
          lastPersistedRef.current = fingerprint;
          debouncedSaveRef.current?.(elements, appState);
        }}
        onPaste={(data) => {
          // Binary files (pasted images) aren't persisted in the scene blob,
          // so they'd be broken after reload — reject them.
          if (data.files && Object.keys(data.files).length > 0) return false;
          return true;
        }}
        UIOptions={{
          canvasActions: {
            clearCanvas: false,
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            saveAsImage: false,
            toggleTheme: false,
          },
          tools: { image: false },
        }}
      />
    </div>
  );
}
