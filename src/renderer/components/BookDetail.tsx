import { useEffect, useRef, useState } from "react";
import { ImagePlus, Trash2, X } from "lucide-react";
import type { Book } from "../../shared/types";

function progressLabel(book: Book): string {
  return book.progress >= 1
    ? "Finished"
    : `${Math.round(book.progress * 100)}%`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

function CoverPlaceholder({ title }: { title: string }) {
  return (
    <div className="flex h-full w-full flex-col justify-end bg-page p-3 text-left">
      <span className="line-clamp-4 text-[12px] font-medium leading-snug text-ink">
        {title || "Untitled"}
      </span>
    </div>
  );
}

export function BookDetail({
  book,
  onClose,
  onUpdated,
}: {
  book: Book;
  onClose: () => void;
  onUpdated: (book: Book) => void;
}) {
  const [draft, setDraft] = useState(book);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(book.title);
  const [broken, setBroken] = useState(false);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  // Parent may refresh the book after library:changed — keep local draft in sync
  // when not mid-edit.
  useEffect(() => {
    setDraft(book);
    if (!editingTitle) setTitleValue(book.title);
    setBroken(false);
  }, [book, editingTitle]);

  useEffect(() => {
    if (editingTitle) titleRef.current?.select();
  }, [editingTitle]);

  // Esc closes the modal (or cancels title edit first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (editingTitle) {
        setEditingTitle(false);
        setTitleValue(draft.title);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingTitle, draft.title, onClose]);

  const saveTitle = async () => {
    const next = titleValue.trim() || "Untitled";
    setEditingTitle(false);
    if (next === draft.title) {
      setTitleValue(draft.title);
      return;
    }
    setSaving(true);
    try {
      const updated = await window.yumi.invoke("books:update", {
        id: draft.id,
        title: next,
      });
      setDraft(updated);
      setTitleValue(updated.title);
      onUpdated(updated);
    } catch (err) {
      console.error("[BookDetail] title update failed", err);
      setTitleValue(draft.title);
    } finally {
      setSaving(false);
    }
  };

  const changeCover = async () => {
    const path = await window.yumi.invoke("dialog:openImage");
    if (!path) return;
    setSaving(true);
    try {
      const updated = await window.yumi.invoke("books:update", {
        id: draft.id,
        coverSourcePath: path,
      });
      setDraft(updated);
      setBroken(false);
      onUpdated(updated);
    } catch (err) {
      console.error("[BookDetail] cover update failed", err);
    } finally {
      setSaving(false);
    }
  };

  const showCover = !!draft.coverPath && !broken;

  return (
    <div
      className="app-no-drag fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="book-detail-title"
      onClick={onClose}
    >
      <div
        className="relative w-[480px] rounded-[14px] border border-edge bg-shell p-6 shadow-shell"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-muted transition-colors hover:text-ink"
          aria-label="Close"
        >
          <X size={18} strokeWidth={1.75} />
        </button>

        <div className="flex gap-5">
          {/* Cover — click to replace */}
          <button
            type="button"
            onClick={() => void changeCover()}
            disabled={saving}
            className="group relative h-[200px] w-[130px] shrink-0 overflow-hidden rounded-[4px] bg-page focus-visible:outline-2 focus-visible:outline-muted disabled:opacity-60"
            aria-label="Change cover"
            title="Change cover"
          >
            {showCover ? (
              <img
                src={draft.coverPath!}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
                onError={() => setBroken(true)}
              />
            ) : (
              <CoverPlaceholder title={draft.title} />
            )}
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-page/0 transition-colors group-hover:bg-page/55">
              <ImagePlus
                size={22}
                strokeWidth={1.75}
                className="text-ink opacity-0 transition-opacity group-hover:opacity-100"
              />
            </span>
          </button>

          <div className="min-w-0 flex-1 pt-0.5 pr-6">
            {/* Title — click to edit inline */}
            {editingTitle ? (
              <input
                ref={titleRef}
                value={titleValue}
                onChange={(e) => setTitleValue(e.target.value)}
                onBlur={() => void saveTitle()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveTitle();
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    setEditingTitle(false);
                    setTitleValue(draft.title);
                  }
                }}
                disabled={saving}
                className="w-full rounded-[6px] border border-edge bg-field px-2 py-1 text-[16px] font-medium text-ink outline-none focus:border-muted"
                aria-label="Book title"
              />
            ) : (
              <button
                type="button"
                id="book-detail-title"
                onClick={() => setEditingTitle(true)}
                className="-mx-1 rounded-[6px] px-1 text-left text-[16px] font-medium leading-snug text-ink transition-colors hover:bg-field"
                title="Edit title"
              >
                {draft.title || "Untitled"}
              </button>
            )}

            <p className="mt-1 text-[13px] text-muted">
              {draft.author || "Unknown author"}
            </p>

            <dl className="mt-5 space-y-2 text-[12px]">
              <Row label="Format" value={draft.format.toUpperCase()} />
              {/* ponytail: page count arrives with the reader */}
              <Row label="Pages" value="—" />
              <Row label="Progress" value={progressLabel(draft)} />
              <Row label="Imported" value={formatDate(draft.importedAt)} />
              <Row label="Last opened" value={formatDate(draft.lastOpenedAt)} />
            </dl>
          </div>
        </div>

        {/* ponytail: delete is UI-only until trash/soft-delete lands */}
        <div className="mt-6 flex justify-end border-t border-edge pt-4">
          <button
            type="button"
            disabled
            title="Coming soon"
            className="flex h-[34px] items-center gap-1.5 rounded-[8px] border border-edge bg-field px-3 text-[12px] text-muted opacity-50"
          >
            <Trash2 size={14} strokeWidth={1.75} />
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate text-ink">{value}</dd>
    </div>
  );
}
