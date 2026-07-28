import { Book, Check, ChevronDown, ChevronRight, Flame, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Book as BookType, ReadingStats } from "../../shared/types";
import { fitToViewport } from "../shared/fit-to-viewport";

/** Daily-goal presets offered by the goal menu, in minutes. */
const GOAL_PRESETS = [5, 10, 15, 20, 30, 45, 60];
const GOAL_SETTINGS_KEY = "readingGoalMinutes";

const sectionLabel =
  "text-[11px] font-semibold uppercase tracking-[0.12em] text-muted";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

function MiniCover({
  book,
  className,
}: {
  book: BookType;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <div
      className={`overflow-hidden rounded-[3px] bg-shell ring-1 ring-ink/10 ${className ?? ""}`}
    >
      {book.coverPath && !broken ? (
        <img
          src={book.coverPath}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
          onError={() => setBroken(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Book size={14} strokeWidth={1.5} className="text-muted" />
        </div>
      )}
    </div>
  );
}

/** Popover listing the daily-goal presets; styled after SortMenu. */
function GoalMenu({
  goalMinutes,
  onSelect,
  onClose,
  anchorRef,
}: {
  goalMinutes: number;
  onSelect: (minutes: number) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      setPos(
        fitToViewport(r.right, r.bottom + 4, 120, GOAL_PRESETS.length * 28),
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchorRef]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (menuRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Next tick so the click that opened the menu doesn't close it.
    const id = setTimeout(() => {
      window.addEventListener("pointerdown", onPointer);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorRef]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Daily reading goal"
      className="fixed z-50 min-w-[120px] overflow-hidden rounded-[8px] border border-edge bg-shell py-1 shadow-shell"
      style={pos ?? { left: -9999, top: -9999 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {GOAL_PRESETS.map((minutes) => {
        const active = minutes === goalMinutes;
        return (
          <button
            key={minutes}
            role="menuitemradio"
            aria-checked={active}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-field"
            onClick={() => onSelect(minutes)}
          >
            <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-muted">
              {active ? <Check size={12} strokeWidth={2.25} /> : null}
            </span>
            <span className="flex-1">{minutes} min</span>
          </button>
        );
      })}
    </div>
  );
}

/** Modal listing every book finished this year; chrome after BookDetail. */
function BooksReadModal({
  books,
  onClose,
}: {
  books: BookType[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="app-no-drag fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="books-read-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-[560px] flex-col rounded-[14px] border border-edge bg-shell p-6 shadow-shell"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2
            id="books-read-title"
            className="text-[15px] font-medium text-ink"
          >
            Books read this year
          </h2>
          <button
            onClick={onClose}
            className="text-muted transition-colors hover:text-ink"
            aria-label="Close"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>
        <p className="mt-1 text-[12px] text-muted">
          {books.length} {books.length === 1 ? "book" : "books"} finished
        </p>

        <div className="no-scrollbar mt-5 grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-x-4 gap-y-6 overflow-y-auto pb-1">
          {books.map((book) => (
            <div key={book.id}>
              <MiniCover book={book} className="aspect-[2/3] w-full" />
              <p
                className="mt-2 line-clamp-2 text-[12px] leading-snug text-ink"
                title={book.title}
              >
                {book.title || "Untitled"}
              </p>
              <p className="mt-0.5 text-[11px] text-muted">
                {book.finishedAt ? formatDate(book.finishedAt) : ""}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The library "Reading goal" panel, sitting right of the Continue reading
 * shelf: today's progress toward the configurable daily goal, the
 * goal-completion streak, and a books-read-this-year preview.
 *
 * `wide` (no shelf beside it) spreads the three blocks across the row.
 */
export function ReadingGoalPanel({ wide = false }: { wide?: boolean }) {
  const [stats, setStats] = useState<ReadingStats | null>(null);
  const [goalOpen, setGoalOpen] = useState(true); // TEMP: visual check
  const [booksOpen, setBooksOpen] = useState(false);
  const goalTriggerRef = useRef<HTMLButtonElement | null>(null);

  const fetchStats = useCallback(() => {
    window.yumi
      .invoke("reading:stats")
      .then(setStats)
      .catch((err) => console.error("[ReadingGoalPanel] stats failed", err));
  }, []);

  useEffect(() => {
    fetchStats();
    // Fired on imports, progress saves, and reading-time ticks.
    return window.yumi.on("library:changed", fetchStats);
  }, [fetchStats]);

  if (!stats) return null;

  const changeGoal = (minutes: number) => {
    setGoalOpen(false);
    void window.yumi
      .invoke("settings:set", {
        key: GOAL_SETTINGS_KEY,
        value: String(minutes),
      })
      // Streaks derive from the goal, so re-pull rather than patching local.
      .then(fetchStats);
  };

  const goalSeconds = stats.goalMinutes * 60;
  const fraction = Math.min(1, stats.todaySeconds / goalSeconds);
  const doneMinutes = Math.floor(stats.todaySeconds / 60);
  const goalMet = stats.todaySeconds >= goalSeconds;

  // SVG ring geometry (56px box, 5px stroke).
  const R = 24;
  const C = 2 * Math.PI * R;

  const divider = wide
    ? "border-l border-edge pl-8"
    : "mt-4 border-t border-edge pt-4";
  // In wide mode the columns are too broad for corner-to-corner headers.
  const headerRow = wide
    ? "flex items-center gap-3"
    : "flex items-center justify-between";

  return (
    <div
      className={
        wide
          ? "grid flex-1 grid-cols-3 gap-8 self-start"
          : "w-[260px] shrink-0 self-start"
      }
    >
      {/* Daily goal */}
      <div>
        <div className={headerRow}>
          <h2 className={sectionLabel}>Reading goal</h2>
          <button
            ref={goalTriggerRef}
            onClick={() => setGoalOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={goalOpen}
            className="flex h-6 items-center gap-1 rounded-[6px] border border-edge bg-field px-2 text-[11px] tabular-nums text-ink transition-colors hover:border-muted"
            title="Change daily goal"
          >
            {stats.goalMinutes} min
            <ChevronDown size={12} strokeWidth={1.75} className="text-muted" />
          </button>
        </div>
        <div className="mt-3 flex items-center gap-3.5">
          <div className="relative h-14 w-14 shrink-0">
            <svg viewBox="0 0 56 56" className="h-full w-full -rotate-90">
              <circle
                cx="28"
                cy="28"
                r={R}
                fill="none"
                strokeWidth="5"
                className="stroke-edge"
              />
              <circle
                cx="28"
                cy="28"
                r={R}
                fill="none"
                strokeWidth="5"
                strokeLinecap="round"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - fraction)}
                className="stroke-accent transition-[stroke-dashoffset] duration-500"
              />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-[14px] font-semibold tabular-nums text-ink">
              {goalMet ? (
                <Check size={18} strokeWidth={2.5} className="text-accent" />
              ) : (
                doneMinutes
              )}
            </span>
          </div>
          <div className="min-w-0">
            {goalMet ? (
              <>
                <p className="text-[13px] font-medium text-accent">Goal met</p>
                <p className="mt-0.5 text-[11px] tabular-nums text-muted">
                  {doneMinutes} of {stats.goalMinutes} min
                </p>
              </>
            ) : (
              <>
                <p className="text-[13px] font-medium tabular-nums text-ink">
                  {doneMinutes} of {stats.goalMinutes} min
                </p>
                <p className="mt-0.5 text-[11px] text-muted">read today</p>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Streak */}
      <div className={divider}>
        <div className="flex items-center gap-2.5">
          <Flame
            size={20}
            strokeWidth={1.75}
            className={stats.streakDays > 0 ? "text-accent" : "text-muted"}
          />
          <p className="text-[13px] font-medium tabular-nums text-ink">
            {stats.streakDays}-day streak
          </p>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          Highest record is {stats.bestStreakDays}{" "}
          {stats.bestStreakDays === 1 ? "day" : "days"}.
        </p>
      </div>

      {/* Books read this year */}
      <div className={divider}>
        <div className={headerRow}>
          <h2 className={sectionLabel}>Books read this year</h2>
          {stats.booksReadThisYear.length > 0 && (
            <button
              onClick={() => setBooksOpen(true)}
              className="flex items-center gap-0.5 text-[11px] text-muted transition-colors hover:text-ink"
            >
              See all
              <ChevronRight size={12} strokeWidth={1.75} />
            </button>
          )}
        </div>
        {stats.booksReadThisYear.length > 0 ? (
          <div className="mt-3 flex gap-1.5">
            {stats.booksReadThisYear.slice(0, 4).map((book) => (
              <MiniCover
                key={book.id}
                book={book}
                className="aspect-[2/3] w-[34px]"
              />
            ))}
          </div>
        ) : (
          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            Finish a book and it will show up here.
          </p>
        )}
      </div>

      {goalOpen && (
        <GoalMenu
          goalMinutes={stats.goalMinutes}
          onSelect={changeGoal}
          onClose={() => setGoalOpen(false)}
          anchorRef={goalTriggerRef}
        />
      )}
      {booksOpen && (
        <BooksReadModal
          books={stats.booksReadThisYear}
          onClose={() => setBooksOpen(false)}
        />
      )}
    </div>
  );
}
