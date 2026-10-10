/**
 * Japanese for time copy that the "{0}" dictionary cannot express: compound
 * durations ("4m 12s", "Expires in 1d 3h"), "yesterday at 20:49" (also inside
 * other copy, like "Resets tomorrow at 9:00"), and the chat timestamp tooltip
 * ("20:49, 9th October 2026") from timestampFormat.ts. Upstream keeps
 * producing English; domTranslation.ts calls this after the dictionary misses.
 */

const DURATION = /^(?:(\d+)d)? ?(?:(\d+)h)? ?(?:(\d+)m)? ?(?:(\d+)s)?$/;
const UNITS = ["日", "時間", "分", "秒"] as const;

/** "1d 3h" → "1日3時間"; null for anything that is not a plain duration. */
function translateDuration(text: string): string | null {
  const match = DURATION.exec(text);
  if (match === null) return null;
  const parts = match
    .slice(1)
    .flatMap((value, index) => (value ? [`${value}${UNITS[index]}`] : []));
  return parts.length === 0 ? null : parts.join("");
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const TOOLTIP_DATE = new RegExp(`^(.+), (\\d{1,2})(?:st|nd|rd|th) (${MONTHS.join("|")}) (\\d{4})$`);

const EXPIRES_IN = "Expires in ";
const DAY_AT = /^(yesterday|tomorrow) at (.+)$/;

export function translateTimeText(text: string): string | null {
  const duration = translateDuration(text);
  if (duration !== null) return duration;
  if (text.startsWith(EXPIRES_IN)) {
    const left = translateDuration(text.slice(EXPIRES_IN.length));
    return left === null ? null : `あと${left}で期限切れ`;
  }
  const dayAt = DAY_AT.exec(text);
  if (dayAt !== null) return `${dayAt[1] === "yesterday" ? "昨日" : "明日"} ${dayAt[2]}`;
  const tooltip = TOOLTIP_DATE.exec(text);
  if (tooltip !== null) {
    const [, time, day, month, year] = tooltip;
    return `${year}年${MONTHS.indexOf(month ?? "") + 1}月${day}日 ${time}`;
  }
  return null;
}
