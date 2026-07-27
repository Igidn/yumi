import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ReaderView } from "./views/ReaderView";
import "./globals.css";

// Excalidraw lazy-loads its fonts from window.EXCALIDRAW_ASSET_PATH (falling
// back to a CDN). Point it at the vendored copies in public/ so the drawing
// panel works offline. Resolved against the page URL so it works over both
// the dev server (http://localhost:5173) and file:// production builds.
(window as unknown as Record<string, unknown>).EXCALIDRAW_ASSET_PATH =
  new URL("vendor/excalidraw/", window.location.href).toString();

// The same bundle serves both window kinds: reader windows load with
// `?reader=<bookId>` (see src/main/windows.ts), the library window without.
const readerBookId = Number(new URLSearchParams(window.location.search).get("reader"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {Number.isInteger(readerBookId) && readerBookId > 0 ? (
      <ReaderView bookId={readerBookId} />
    ) : (
      <App />
    )}
  </StrictMode>
);
