import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ReaderView } from "./views/ReaderView";
import "./globals.css";

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
