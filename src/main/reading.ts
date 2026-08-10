import { and, eq, isNotNull, sql } from "drizzle-orm";

import type { ReadingStats } from "../shared/types";
import { getDb } from "./database";
import { appSettings, books, readingActivity } from "./db/schema";
import { bookForRenderer } from "./import";
import { computeStreaks, localDateKey, metByDateFor } from "./streak";

/** app_settings key holding the daily goal, in minutes, as a plain number. */
export const READING_GOAL_KEY = "readingGoalMinutes";
// Day (YYYY-MM-DD) the current goal took effect; streak days before it don't
// count, so a lowered goal can't retroactively revive a dead streak.
export const READING_GOAL_SET_KEY = "readingGoalSetAt";
export const DEFAULT_GOAL_MINUTES = 15;

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
 * Change the daily goal. Streaks count forward only: the change takes effect
 * today, so pre-change days can't retroactively meet the new goal (a lowered
 * goal must not resurrect a dead streak). No-op when the value didn't change.
 */
export async function setReadingGoalMinutes(minutes: number): Promise<void> {
  if ((await getGoalMinutes()) === minutes) return;
  const db = await getDb();
  const today = localDateKey(new Date());
  await db
    .insert(appSettings)
    .values({ key: READING_GOAL_SET_KEY, value: today })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: today } });
}

async function getGoalSetAt(): Promise<string | null> {
  const db = await getDb();
  const row = await db.query.appSettings.findFirst({
    where: eq(appSettings.key, READING_GOAL_SET_KEY),
  });
  return row?.value ?? null;
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
  const todayKey = localDateKey(new Date());
  const metByDate = metByDateFor(activity, goalSeconds, await getGoalSetAt());
  const todaySeconds =
    activity.find((row) => row.date === todayKey)?.seconds ?? 0;
  const { streakDays, bestStreakDays } = computeStreaks(metByDate, todayKey);

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
