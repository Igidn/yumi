/**
 * Adjust a popover anchor so the resulting menu stays entirely inside the
 * viewport. Prevents clipping at window edges that `position: fixed` can't
 * escape.
 *
 * The block is assumed to render at (x, y) flowing down and to the right
 * (top-left anchor). When there isn't enough room below, the menu flips
 * above the anchor point instead.
 */
export function fitToViewport(
  x: number,
  y: number,
  estimatedWidth: number,
  estimatedHeight: number,
  pad = 8,
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = x;
  let top = y;

  if (left + estimatedWidth > vw) {
    left = Math.max(pad, vw - estimatedWidth - pad);
  }
  if (left < pad) {
    left = pad;
  }

  if (top + estimatedHeight > vh) {
    top = Math.max(pad, y - estimatedHeight - pad);
  }
  if (top < pad) {
    top = pad;
  }

  return { left, top };
}
