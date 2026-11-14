/** Dates as Access users type them, read into ISO text (shared by the app and the server). */

/** Accepts yyyy-mm-dd[ hh:mm[:ss]] and m/d/yyyy[ h:mm[:ss] [AM|PM]]. */
export function parseAccessDate(text: string): string | null {
  const s = text.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  let y: number, mo: number, d: number, h = 0, mi = 0, sec = 0, hasTime = false;
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[4]) [h, mi, sec, hasTime] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0), true];
  } else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(s);
    if (!m) return null;
    [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 100) y += y < 30 ? 2000 : 1900;
    if (m[4]) {
      [h, mi, sec, hasTime] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0), true];
      if (m[7]?.toUpperCase() === "PM" && h < 12) h += 12;
      if (m[7]?.toUpperCase() === "AM" && h === 12) h = 0;
    }
  }
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const iso = dt.toISOString();
  return hasTime ? (sec ? iso.slice(0, 19) : iso.slice(0, 16)) : iso.slice(0, 10);
}
