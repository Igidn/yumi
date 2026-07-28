import type { PendingDuplicate } from "../hooks/useImport";

/**
 * Modal asking whether to skip or replace a book whose SHA-256 already exists
 * in the library (SPEC §1). The whole overlay is `app-no-drag` so the buttons
 * stay clickable over the window drag region.
 */
export function DuplicatePrompt({
  pending,
  onResolve,
}: {
  pending: PendingDuplicate;
  onResolve: (action: "skip" | "replace") => void;
}) {
  const { existingBook } = pending;
  return (
    <div
      className="app-no-drag fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dup-title"
    >
      <div className="w-[420px] rounded-[14px] border border-edge bg-shell p-6 shadow-shell">
        <h2 id="dup-title" className="text-[16px] font-medium text-ink">
          Already in your library
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {existingBook.title || "Untitled"} is already in your library with the
          same content. Replacing removes the existing copy and re-imports this
          file.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => onResolve("skip")}
            className="h-[34px] rounded-[8px] border border-edge bg-field px-4 text-[12px] text-ink transition-colors hover:text-ink"
          >
            Skip
          </button>
          <button
            onClick={() => onResolve("replace")}
            className="h-[34px] rounded-[8px] bg-pill px-4 text-[12px] text-ink transition-opacity hover:opacity-90"
          >
            Replace
          </button>
        </div>
      </div>
    </div>
  );
}
