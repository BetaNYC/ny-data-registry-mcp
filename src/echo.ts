/**
 * What the caller typed, as it may be repeated in an answer or an error: one line (control,
 * format and line-break characters and runs of spaces become one space) of at most `max`
 * characters (code points), ending "…" when cut. Every message that names the caller's own
 * input goes through this, so a long or multi-line input cannot fill or reshape the reply.
 */
export const ECHO_MAX = 80;

export function echo(v: unknown, max = ECHO_MAX): string {
  const line = String(v ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ").trim();
  const cp = [...line];
  return cp.length > max ? `${cp.slice(0, max - 1).join("")}…` : line;
}
