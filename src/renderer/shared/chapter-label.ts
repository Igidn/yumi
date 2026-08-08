/**
 * Label for a webnovel chapter number. "Chapter N" needs word wrap once N
 * exceeds one digit (e.g. "Chapter 120"), so multi-digit numbers shorten to
 * "C. N".
 */
export function chapterLabel(n: number): string {
  return n > 9 ? `C. ${n}` : `Chapter ${n}`;
}
