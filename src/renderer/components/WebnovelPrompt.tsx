import { useEffect, useRef, useState } from "react";

/**
 * Modal asking for a freewebnovel.com novel link (e.g.
 * `https://freewebnovel.com/novel/{slug}`). Enter submits; Escape cancels.
 */
export function WebnovelPrompt({
  importing,
  onImport,
  onClose,
}: {
  importing: boolean;
  onImport: (url: string) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = url.trim();
    if (!/^https?:\/\/freewebnovel\.com/i.test(trimmed)) {
      setError(
        "Paste a freewebnovel.com link, e.g. https://freewebnovel.com/novel/...",
      );
      return;
    }
    setError(null);
    onImport(trimmed);
  };

  return (
    <div
      className="app-no-drag fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="webnovel-title"
    >
      <div className="w-[440px] rounded-[14px] border border-edge bg-shell p-6 shadow-shell">
        <h2 id="webnovel-title" className="text-[16px] font-medium text-ink">
          Import a webnovel
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Paste a freewebnovel.com novel link. Yumi will fetch its cover, title,
          and full chapter list.
        </p>
        <input
          ref={inputRef}
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
          placeholder="https://freewebnovel.com/novel/..."
          spellCheck={false}
          className="mt-4 h-9 w-full rounded-[8px] border border-edge bg-field px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-muted focus:border-accent/60"
        />
        {error && (
          <p className="mt-2 text-[12px] text-red-400" role="alert">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={importing}
            className="h-[34px] rounded-[8px] border border-edge bg-field px-4 text-[12px] text-ink transition-colors hover:text-ink disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={importing}
            className="h-[34px] rounded-[8px] bg-accent px-4 text-[12px] font-semibold text-on-accent transition-[filter] hover:brightness-110 disabled:opacity-60"
          >
            {importing ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
