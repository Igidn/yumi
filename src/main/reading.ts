import { and, eq, isNotNull, sql } from "drizzle-orm";

import type { ReadingStats } from "../shared/types";
import { getDb } from "./database";
import { appSettings, books, readingActivity } from "./db/schema";
import { bookForRenderer } from "./import";

/** app_settings key holding the daily goal, in minutes, as a plain number. */
export const READING_GOAL_KEY = "readingGoalMinutes";
export const DEFAULT_GOAL_MINUTES = 15;

/** YYYY-MM-DD in local time — the day bucket reading time accrues to. */
function localDateKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function getGoalMinutes(): Promise<number> {
  const db = await getDb();
  const row = await db.query.appSettings.findFirst({
    where: eq(appSettings.key, READING_GOAL_KEY),
  });
  const parsed = row ? Number.parseInt(row.value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_GOAL_MINUTES;
  return Math.min(parsed, 24 * 60);
}

/**
 * Add active reading time to today's bucket. The reader window sends a
 * heartbeat while it is visible and focused, so idle-open time never counts.
 */
export async function logReadingSeconds(seconds: number): Promise<void> {
  // Clamp a single tick so a stuck or synthetic timer can't inflate a day.
  const add = Math.min(Math.max(0, Math.round(seconds)), 3600);
  if (add === 0) return;
  const db = await getDb();
  const today = localDateKey(new Date());
  await db
    .insert(readingActivity)
    .values({ date: today, seconds: add })
    .onConflictDoUpdate({
      target: readingActivity.date,
      set: { seconds: sql`${readingActivity.seconds} + ${add}` },
    });
}

/**
 * Everything the library "Reading goal" panel shows, in one round-trip:
 * today's progress toward the daily goal, the completion streak (and best
 * streak ever), and the books finished this calendar year.
 */
export async function getReadingStats(): Promise<ReadingStats> {
  const db = await getDb();
  const goalMinutes = await getGoalMinutes();
  const goalSeconds = goalMinutes * 60;

  const activity = await db
    .select()
    .from(readingActivity)
    .orderBy(readingActivity.date);
  const metByDate = new Map<string, boolean>();
  let todaySeconds = 0;
  const todayKey = localDateKey(new Date());
  for (const row of activity) {
    metByDate.set(row.date, row.seconds >= goalSeconds);
    if (row.date === todayKey) todaySeconds = row.seconds;
  }

  // Current streak: consecutive goal-meeting days. An incomplete today
  // doesn't break the streak — count back from yesterday instead.
  let streakDays = 0;
  const cursor = new Date();
  if (!metByDate.get(localDateKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  while (metByDate.get(localDateKey(cursor))) {
    streakDays++;
    cursor.setDate(cursor.getDate() - 1);
  }

  // Best streak: longest run of consecutive goal-meeting days on record.
  let bestStreakDays = 0;
  let run = 0;
  let prevTime = 0;
  for (const row of activity) {
    if (!metByDate.get(row.date)) {
      run = 0;
      prevTime = 0;
      continue;
    }
    const [y, m, d] = row.date.split("-").map(Number);
    const time = new Date(y, m - 1, d).getTime();
    // Rounded day diff absorbs 23h/25h DST days.
    const consecutive =
      prevTime > 0 && Math.round((time - prevTime) / ONE_DAY_MS) === 1;
    run = consecutive ? run + 1 : 1;
    prevTime = time;
    if (run > bestStreakDays) bestStreakDays = run;
  }

  // Books finished this calendar year (finishedAt is UTC ISO; the year
  // boundary is judged in local time), most recently finished first.
  const thisYear = new Date().getFullYear();
  const finished = await db
    .select()
    .from(books)
    .where(and(eq(books.trashed, 0), isNotNull(books.finishedAt)));
  const booksReadThisYear = finished
    .filter((b) => new Date(b.finishedAt!).getFullYear() === thisYear)
    .sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!))
    .map(bookForRenderer);

  return {
    goalMinutes,
    todaySeconds,
    streakDays,
    bestStreakDays,
    booksReadThisYear,
  };
}
