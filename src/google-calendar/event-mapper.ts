import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { create_event, update_event } from "./models.js";

export type EventResource = Record<string, unknown> & { start?: { date?: string | null; dateTime?: string | null; timeZone?: string | null }; end?: { date?: string | null; dateTime?: string | null; timeZone?: string | null }; attendees?: Array<Record<string, unknown> & { email?: string; self?: boolean }>; attachments?: Array<Record<string, unknown> & { fileUrl?: string }> };
type Params = Partial<z.infer<typeof create_event>> & Partial<z.infer<typeof update_event>>;

export function localParts(timestamp: number, timeZone: string) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(timestamp).map(part => [part.type, part.value]));
}
export function resolveTime(value: string, timeZone: string): number {
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const result = Date.parse(value);
    if (!Number.isFinite(result)) throw new Error("Invalid timestamp");
    return result;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/.exec(value);
  if (!match) throw new Error("Expected an ISO 8601 timestamp");
  const desired = Date.UTC(+match[1], +match[2] - 1, +match[3], +(match[4] ?? 0), +(match[5] ?? 0), +(match[6] ?? 0));
  const normalized = new Date(desired);
  if (normalized.getUTCFullYear() !== +match[1] || normalized.getUTCMonth() !== +match[2] - 1 || normalized.getUTCDate() !== +match[3] || normalized.getUTCHours() !== +(match[4] ?? 0) || normalized.getUTCMinutes() !== +(match[5] ?? 0) || normalized.getUTCSeconds() !== +(match[6] ?? 0)) throw new Error("Invalid timestamp");
  const milliseconds = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  let result = desired;
  for (let i = 0; i < 4; i++) {
    const parts = localParts(result, timeZone);
    const actual = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    if (actual === desired) return result + milliseconds;
    result += desired - actual;
  }
  throw new Error("Local time does not exist in this time zone (DST transition)");
}
export function mapEvent(params: Params, timeZone: string, existing: EventResource = {}): EventResource {
  const result: EventResource = {};
  for (const field of ["summary", "description", "location", "visibility", "colorId"] as const) if (params[field] !== undefined) result[field] = params[field];
  const allDay = params.allDay ?? Boolean(existing.start?.date);
  const conversion = existing.start && allDay !== Boolean(existing.start.date);
  const endpoint = (value: string) => allDay ? { date: value.slice(0, 10), ...(conversion ? { dateTime: null, timeZone: null } : {}) } : { dateTime: new Date(resolveTime(value, timeZone)).toISOString(), timeZone, ...(conversion ? { date: null } : {}) };
  if (params.allDay !== undefined && conversion && (!params.startTime || !params.endTime)) throw new Error("Changing allDay requires startTime and endTime");
  if (params.startTime !== undefined) result.start = endpoint(params.startTime);
  if (params.endTime !== undefined) result.end = endpoint(params.endTime);
  if (params.startTime && !params.endTime && existing.start && existing.end) {
    const oldStart = resolveTime(existing.start.dateTime ?? existing.start.date!, existing.start.timeZone ?? timeZone);
    const oldEnd = resolveTime(existing.end.dateTime ?? existing.end.date!, existing.end.timeZone ?? timeZone);
    if (allDay) {
      const days = (Date.parse(existing.end.date!) - Date.parse(existing.start.date!)) / 86400000;
      result.end = { date: new Date(Date.parse(params.startTime.slice(0, 10)) + days * 86400000).toISOString().slice(0, 10) };
    } else result.end = { dateTime: new Date(resolveTime(params.startTime, timeZone) + oldEnd - oldStart).toISOString(), timeZone };
  }
  if (params.timeZone && !params.startTime && existing.start?.dateTime) result.start = { ...existing.start, timeZone };
  if (params.timeZone && !params.endTime && !result.end && existing.end?.dateTime) result.end = { ...existing.end, timeZone };
  const start = result.start ?? existing.start;
  const end = result.end ?? existing.end;
  if (start && end && resolveTime(end.dateTime ?? end.date!, timeZone) <= resolveTime(start.dateTime ?? start.date!, timeZone)) throw new Error("endTime must be after startTime");
  if (params.recurrenceData !== undefined) result.recurrence = params.recurrenceData;
  if (params.eventType !== undefined) result.eventType = ({ EVENT_TYPE_UNSPECIFIED: "default", DEFAULT: "default", OUT_OF_OFFICE: "outOfOffice", FOCUS_TIME: "focusTime", WORKING_LOCATION: "workingLocation", BIRTHDAY: "birthday", FROM_GMAIL: "fromGmail" })[params.eventType];
  if (allDay && ["outOfOffice", "focusTime"].includes(String(result.eventType ?? existing.eventType))) throw new Error("Out-of-office and focus-time events cannot be all-day");
  if (result.eventType === "fromGmail") throw new Error("FROM_GMAIL events cannot be created");
  if (result.eventType === "focusTime" || result.eventType === "outOfOffice") {
    if (params.availability === "AVAILABILITY_FREE") throw new Error("Status events must block time");
    result.transparency = "opaque";
    result[result.eventType === "focusTime" ? "focusTimeProperties" : "outOfOfficeProperties"] = { autoDeclineMode: "declineNone" };
  }
  if (result.eventType === "workingLocation") {
    if (params.availability && params.availability !== "AVAILABILITY_FREE" || params.visibility && params.visibility !== "public") throw new Error("Working-location events require public visibility and free availability");
    result.transparency = "transparent";
    result.visibility = "public";
    if (!params.workingLocationProperties) throw new Error("Working-location events require workingLocationProperties");
  }
  if (params.availability !== undefined) result.transparency = params.availability === "AVAILABILITY_FREE" ? "transparent" : "opaque";
  if (params.guestPermissions) {
    const { guestsCanSeeGuests, ...permissions } = params.guestPermissions;
    Object.assign(result, permissions, guestsCanSeeGuests !== undefined ? { guestsCanSeeOtherGuests: guestsCanSeeGuests } : {});
  }
  if (params.useDefaultReminders === true && params.overrideReminders !== undefined) throw new Error("Default reminders cannot be combined with overrides");
  if (params.useDefaultReminders !== undefined || params.overrideReminders !== undefined) result.reminders = { useDefault: params.useDefaultReminders ?? false, overrides: params.useDefaultReminders ? [] : params.overrideReminders ?? [] };
  if (params.attendees !== undefined || params.addedAttendees !== undefined || params.removedAttendeeEmails !== undefined) {
    const removed = new Set(params.removedAttendeeEmails?.map(email => email.toLowerCase()));
    const attendees = new Map((params.attendees ?? existing.attendees ?? []).map(attendee => [attendee.email?.toLowerCase(), { ...attendee }]));
    for (const attendee of params.addedAttendees ?? []) attendees.set(attendee.email.toLowerCase(), { ...attendee });
    result.attendees = [...attendees.values()].filter(attendee => !removed.has(attendee.email?.toLowerCase() ?? "")).map(attendee => {
      const { optionalAttendee, ...rest } = attendee;
      return optionalAttendee !== undefined ? { ...rest, optional: optionalAttendee } : rest;
    });
  }
  if (params.attachments !== undefined || params.addedAttachments !== undefined || params.removedAttachmentFileUrls !== undefined) {
    const attachments = new Map((params.attachments ?? existing.attachments ?? []).map(item => [item.fileUrl, item]));
    for (const item of params.addedAttachments ?? []) attachments.set(item.fileUrl, item);
    for (const url of params.removedAttachmentFileUrls ?? []) attachments.delete(url);
    result.attachments = [...attachments.values()];
  }
  if (params.googleMeetUrl !== undefined) {
    const uri = params.googleMeetUrl.startsWith("https://") ? params.googleMeetUrl : `https://meet.google.com/${params.googleMeetUrl}`;
    if (!/^https:\/\/meet\.google\.com\/[a-z-]+$/i.test(uri)) throw new Error("Invalid Google Meet URL");
    result.conferenceData = { conferenceSolution: { key: { type: "hangoutsMeet" } }, entryPoints: [{ entryPointType: "video", uri }] };
  } else if (params.addGoogleMeetUrl) result.conferenceData = { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
  if (params.workingLocationProperties) {
    const { type, customLocationLabel, officeLocation } = params.workingLocationProperties;
    const mappedType = type === "CUSTOM_LOCATION" ? "customLocation" : type === "OFFICE_LOCATION" ? "officeLocation" : "homeOffice";
    if (mappedType === "customLocation" && !customLocationLabel) throw new Error("Custom working location requires a label");
    if (mappedType === "officeLocation" && !officeLocation) throw new Error("Office working location requires office details");
    result.workingLocationProperties = { type: mappedType, ...(mappedType === "homeOffice" ? { homeOffice: {} } : {}), ...(customLocationLabel !== undefined ? { customLocation: { label: customLocationLabel } } : {}), ...(officeLocation ? { officeLocation } : {}) };
  }
  return result;
}

export function eventResult(event: EventResource) {
  const eventTypes: Record<string, string> = { default: "DEFAULT", outOfOffice: "OUT_OF_OFFICE", focusTime: "FOCUS_TIME", workingLocation: "WORKING_LOCATION", birthday: "BIRTHDAY", fromGmail: "FROM_GMAIL" };
  const reminders = event.reminders as { useDefault?: boolean; overrides?: unknown[] } | undefined;
  const working = event.workingLocationProperties as { type?: string; customLocation?: { label?: string }; officeLocation?: unknown } | undefined;
  return { ...event, eventId: event.id, startTime: event.start?.dateTime ?? event.start?.date, endTime: event.end?.dateTime ?? event.end?.date, allDay: Boolean(event.start?.date), timeZone: event.start?.timeZone, recurrenceData: event.recurrence, eventType: eventTypes[String(event.eventType)] ?? event.eventType, availability: event.transparency === "transparent" ? "AVAILABILITY_FREE" : "AVAILABILITY_BUSY", attendees: event.attendees?.map(({ optional, ...attendee }) => ({ ...attendee, ...(optional !== undefined ? { optionalAttendee: optional } : {}) })), googleMeetUrl: event.hangoutLink ?? (event.conferenceData as { entryPoints?: Array<{ entryPointType?: string; uri?: string }> } | undefined)?.entryPoints?.find(item => item.entryPointType === "video")?.uri, useDefaultReminders: reminders?.useDefault, overrideReminders: reminders?.overrides, guestPermissions: { guestsCanInviteOthers: event.guestsCanInviteOthers, guestsCanModify: event.guestsCanModify, guestsCanSeeGuests: event.guestsCanSeeOtherGuests }, ...(working ? { workingLocationProperties: { type: working.type === "customLocation" ? "CUSTOM_LOCATION" : working.type === "officeLocation" ? "OFFICE_LOCATION" : "HOME_OFFICE", customLocationLabel: working.customLocation?.label, officeLocation: working.officeLocation } } : {}) };
}
