import { localParts, resolveTime } from "./event-mapper.js";
export type BusyInterval = { start: string; end: string };
export type Preferences = { startHour?: string; endHour?: string; excludeWeekends?: boolean; pageSize?: number };
export function suggestSlots(busy: BusyInterval[], start: number, end: number, durationMinutes = 30, timeZone = "UTC", preferences: Preferences = {}) {
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1) throw new Error("durationMinutes must be a positive integer");
  if (end <= start) throw new Error("endTime must be after startTime");
  const limit = preferences.pageSize ?? 5;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("preferences.pageSize must be a positive integer");
  for (const hour of [preferences.startHour, preferences.endHour]) if (hour && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hour)) throw new Error("Working hours must use HH:mm");
  if (preferences.startHour && preferences.endHour && preferences.startHour >= preferences.endHour) throw new Error("endHour must be after startHour");
  const blocks = busy.map(item => ({ start: resolveTime(item.start, timeZone), end: resolveTime(item.end, timeZone) })).sort((a, b) => a.start - b.start);
  const duration = durationMinutes * 60000;
  const slots: Array<{ startTime: string; endTime: string; timeZone: string }> = [];
  let cursor = start;
  while (cursor + duration <= end && slots.length < limit) {
    const parts = localParts(cursor, timeZone);
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    if (preferences.excludeWeekends) {
      const last = localParts(cursor + duration - 1, timeZone);
      const lastDate = Date.parse(`${last.year}-${last.month}-${last.day}T00:00:00Z`);
      let includesWeekend = false;
      for (let day = Date.parse(`${date}T00:00:00Z`); day <= lastDate; day += 86400000) {
        const weekday = new Date(day).getUTCDay();
        if (weekday === 0 || weekday === 6) { includesWeekend = true; break; }
      }
      if (includesWeekend) { cursor += 60000; continue; }
    }
    if (preferences.startHour || preferences.endHour) {
      const dayStart = resolveTime(`${date}T${preferences.startHour ?? "00:00"}:00`, timeZone);
      const dayEnd = preferences.endHour ? resolveTime(`${date}T${preferences.endHour}:00`, timeZone) : resolveTime(`${new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)}T00:00:00`, timeZone);
      if (cursor < dayStart) { cursor = dayStart; continue; }
      if (cursor + duration > dayEnd) { cursor += 60000; continue; }
    }
    const conflict = blocks.find(block => block.start < cursor + duration && block.end > cursor);
    if (conflict) { cursor = Math.max(cursor + 60000, conflict.end); continue; }
    slots.push({ startTime: new Date(cursor).toISOString(), endTime: new Date(cursor + duration).toISOString(), timeZone });
    cursor += duration;
  }
  return slots;
}
