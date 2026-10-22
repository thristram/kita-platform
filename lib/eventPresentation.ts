export type ContentRecord = Record<string, unknown>;
export const text = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : String(value);
export const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(text) : [];
export const records = (value: unknown): ContentRecord[] => Array.isArray(value) ? value.filter((v): v is ContentRecord => !!v && typeof v === "object") : [];
export const titleCase = (value: unknown) => text(value).replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
export function dateLabel(value: unknown, timezone: string, time = false): string {
  if (!value) return "Date pending";
  const date = new Date(text(value));
  if (Number.isNaN(date.getTime())) return "Date pending";
  return new Intl.DateTimeFormat("en-US", time ? { hour: "numeric", minute: "2-digit", timeZone: timezone } : { month: "short", day: "numeric", year: "numeric", timeZone: timezone }).format(date);
}
export function dayKey(value: unknown, timezone: string): string {
  if (!value || Number.isNaN(new Date(text(value)).getTime())) return "Undated";
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timezone }).format(new Date(text(value)));
}
export function matchesSubject(item: ContentRecord, key: string): boolean {
  return records(item.subjectTargets).some((target) => target.canonicalKey === key);
}
export function calendarFile(sessions: ContentRecord[], timezone: string): string {
  const escape = (value: unknown) => text(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll(",", "\\,").replaceAll(";", "\\;");
  const stamp = (value: unknown) => new Date(text(value)).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//KitaCon//Event schedule//EN", "CALSCALE:GREGORIAN", ...sessions.filter((s) => s.startDate && !Number.isNaN(new Date(text(s.startDate)).getTime())).flatMap((s) => ["BEGIN:VEVENT", `UID:${escape(s.externalKey)}@kitacon`, `DTSTAMP:${stamp(new Date().toISOString())}`, `DTSTART:${stamp(s.startDate)}`, ...(s.endDate ? [`DTEND:${stamp(s.endDate)}`] : []), `SUMMARY:${escape(s.title)}`, `DESCRIPTION:${escape(s.description)}`, `LOCATION:${escape([s.venueName,s.room].filter(Boolean).join(" · "))}`, `X-WR-TIMEZONE:${escape(timezone)}`, "END:VEVENT"]), "END:VCALENDAR", ""].join("\r\n");
}
