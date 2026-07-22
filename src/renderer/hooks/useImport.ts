import { useCallback, useState } from "react";

export interface ImportFailure {
  path: string;
  error: string;
}

export interface ImportResult {
  ok: number;
  failed: ImportFailure[];
}

/**
 * Drives the `import:book` IPC for one or more file paths. The main process
 * also broadcasts `library:changed` after each successful insert, so views
 * that show the library should subscribe to that event to re-fetch.
 *
 * Used by the file-dialog import button (LibraryView) and the drop overlay
 * (App). Failures are surfaced via `lastResult` for the caller to display.
 */
export function useImport() {
  const [importing, setImporting] = useState(false);
  const [lastResult, setLastResult] = useState<ImportResult | null>(null);

  const importPaths = useCallback(
    async (paths: string[]): Promise<ImportResult> => {
      if (paths.length === 0) return { ok: 0, failed: [] };
      setImporting(true);
      const result: ImportResult = { ok: 0, failed: [] };
      for (const path of paths) {
        try {
          await window.yumi.invoke("import:book", { sourcePath: path });
          result.ok += 1;
        } catch (err) {
          result.failed.push({
            path,
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

  return { importing, lastResult, importPaths };
}
