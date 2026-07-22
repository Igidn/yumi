import { useCallback, useRef, useState } from "react";
import type { Book, ImportOutcome } from "../../shared/types";

export interface ImportFailure {
  path: string;
  error: string;
}

export interface ImportResult {
  ok: number;
  skipped: number;
  failed: ImportFailure[];
}

/** A pending duplicate awaiting the user's skip/replace decision. */
export interface PendingDuplicate {
  sourcePath: string;
  existingBook: Book;
}

type Resolve = (action: "skip" | "replace") => void;

/**
 * Drives the `import:book` IPC for one or more file paths, surfacing
 * duplicates (same SHA-256 as an existing book) as an interactive prompt.
 *
 * The loop pauses when a duplicate is detected: `pendingDuplicate` is set and
 * the loop awaits `resolveDuplicate("skip" | "replace")` before continuing to
 * the next file. Main also broadcasts `library:changed` after each successful
 * insert, so views showing the library should subscribe to that event.
 */
export function useImport() {
  const [importing, setImporting] = useState(false);
  const [lastResult, setLastResult] = useState<ImportResult | null>(null);
  const [pendingDuplicate, setPendingDuplicate] =
    useState<PendingDuplicate | null>(null);
  // Holds the resolver for the in-flight duplicate prompt. A ref so the
  // queue loop and the user-decision callback share the same closure.
  const resolveRef = useRef<Resolve | null>(null);

  const resolveDuplicate = useCallback((action: "skip" | "replace") => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setPendingDuplicate(null);
    resolve?.(action);
  }, []);

  const importPaths = useCallback(
    async (paths: string[]): Promise<ImportResult> => {
      if (paths.length === 0) return { ok: 0, skipped: 0, failed: [] };
      setImporting(true);
      const result: ImportResult = { ok: 0, skipped: 0, failed: [] };
      for (const sourcePath of paths) {
        try {
          let outcome: ImportOutcome = await window.yumi.invoke("import:book", {
            sourcePath,
          });
          if (outcome.status === "duplicate") {
            const existingBook = outcome.existingBook;
            const action = await new Promise<"skip" | "replace">((resolve) => {
              resolveRef.current = resolve;
              setPendingDuplicate({ sourcePath, existingBook });
            });
            outcome = await window.yumi.invoke("import:book", {
              sourcePath,
              duplicateHandling: action,
            });
          }
          if (outcome.status === "imported") result.ok += 1;
          else result.skipped += 1;
        } catch (err) {
          result.failed.push({
            path: sourcePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      setImporting(false);
      setLastResult(result);
      if (result.failed.length > 0) {
        console.error("[import] failures:", result.failed);
      }
      return result;
    },
    []
  );

  return {
    importing,
    lastResult,
    importPaths,
    pendingDuplicate,
    resolveDuplicate,
  };
}