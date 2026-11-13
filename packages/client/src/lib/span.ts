const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * How long a task took, as a person says it: "2d 4h", "5h" under a day, "<1h" under an hour, and a dash for no time
 * at all (no task measured).
 */
export function formatSpan(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < HOUR) return "<1h";
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  if (days === 0) return `${hours}h`;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}
