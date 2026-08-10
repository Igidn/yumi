/** YYYY-MM-DD in local time — the day bucket reading time accrues to. */
export function localDateKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Day → whether the daily goal was met, judged at the current goal.
 */
export function metByDateFor(
  activity: readonly { date: string; seconds: number }[],
  goalSeconds: number,
): Map<string, boolean> {
  const met = new Map<string, boolean>();
  for (const row of activity) met.set(row.date, row.seconds >= goalSeconds);
  return met;
}

/**
 * Current streak: consecutive goal-meeting days ending today — or yesterday,
 * since an incomplete today doesn't break the streak. Days before `setAt`
 * (YYYY-MM-DD, the day the current goal took effect) don't count, so a
 * lowered goal can't retroactively meet old days and resurrect a dead
 * streak. Best streak: the longest run on record, judged at the current
 * goal — goal changes don't wipe the historical record.
 */
export function computeStreaks(
  metByDate: Map<string, boolean>,
  todayKey: string,
  setAt: string | null,
): { streakDays: number; bestStreakDays: number } {
  let streakDays = 0;
  const cursor = new Date(`${todayKey}T12:00:00`);
  const metOn = (key: string) =>
    setAt && key < setAt ? undefined : metByDate.get(key);
  if (!metOn(todayKey)) cursor.setDate(cursor.getDate() - 1);
  while (metOn(localDateKey(cursor))) {
    streakDays++;
    cursor.setDate(cursor.getDate() - 1);
  }

  let bestStreakDays = 0;
  let run = 0;
  let prevTime = 0;
  for (const date of [...metByDate.keys()].sort()) {
    if (!metByDate.get(date)) {
      run = 0;
      prevTime = 0;
      continue;
    }
    const [y, m, d] = date.split("-").map(Number);
    const time = new Date(y, m - 1, d).getTime();
    // Rounded day diff absorbs 23h/25h DST days.
    const consecutive =
      prevTime > 0 && Math.round((time - prevTime) / ONE_DAY_MS) === 1;
    run = consecutive ? run + 1 : 1;
    prevTime = time;
    if (run > bestStreakDays) bestStreakDays = run;
  }

  return { streakDays, bestStreakDays };
}

// ponytail: tiny self-check, run with `npx tsx src/main/streak.ts`. Guards
// the goal-change regression: a lowered goal must not retroactively meet
// pre-change days and bring a dead streak back. `argv[1]` never ends in
// "streak.ts" inside the packaged app or the dev main, so this is inert there.
if (typeof process !== "undefined" && process.argv[1]?.endsWith("streak.ts")) {
  const day = (date: string, seconds: number) => ({ date, seconds });
  // Five days meeting a 60-min goal, then three days of only 20 min.
  const activity = [
    day("2026-08-03", 3600),
    day("2026-08-04", 3600),
    day("2026-08-05", 3600),
    day("2026-08-06", 3600),
    day("2026-08-07", 3600),
    day("2026-08-08", 1200),
    day("2026-08-09", 1200),
    day("2026-08-10", 1200),
  ];
  const today = "2026-08-10";

  // Goal still 60 min: the 20-min days don't meet it, streak is dead,
  // best stays at the 5-day run.
  const at60 = metByDateFor(activity, 3600);
  const at60Streaks = computeStreaks(at60, today, null);
  if (at60Streaks.streakDays !== 0)
    throw new Error("60-min streak should be broken");
  if (at60Streaks.bestStreakDays !== 5)
    throw new Error("60-min best streak should be 5");

  // Buggy behavior (no cutoff): lowering to 20 min resurrects the streak to 8.
  const noCutoff = metByDateFor(activity, 1200);
  if (computeStreaks(noCutoff, today, null).streakDays !== 8)
    throw new Error("expected resurrection without the cutoff");

  // Fixed: the 20-min goal takes effect today, so the current streak
  // restarts at 1, while the best streak survives across the change.
  const streaks = computeStreaks(metByDateFor(activity, 1200), today, today);
  if (streaks.streakDays !== 1)
    throw new Error("streak must restart at 1 on the change day");
  if (streaks.bestStreakDays !== 8)
    throw new Error("best streak must survive the goal change");

  // And it keeps growing forward from there.
  const next = metByDateFor(
    [...activity, day("2026-08-11", 1200)],
    1200,
  );
  if (computeStreaks(next, "2026-08-11", today).streakDays !== 2)
    throw new Error("streak should grow forward after the change");

  console.log("streak.ts: ok");
}
