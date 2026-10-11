import { afterEach, describe, expect, it, vi } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readFileSync } from "node:fs";
import { CalendarClient } from "../client.js";
import { mapEvent, eventResult, resolveTime } from "../event-mapper.js";
import { suggestSlots } from "../time-suggester.js";
import { toolSchemas } from "../models.js";
import calendar from "../index.js";
const fixture = JSON.parse(readFileSync(new URL("./official-schema.json", import.meta.url), "utf8")) as Array<{ name: keyof typeof toolSchemas; inputSchema: Record<string, unknown> }>;
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(object).filter(([key]) => !["additionalProperties", "$schema", "format", "x-google-enum-descriptions", "readOnly"].includes(key)).map(([key, item]) => [key, key === "required" && Array.isArray(item) ? [...item].sort() : normalize(item)]));
}
function expand(value: unknown, defs: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map(item => expand(item, defs));
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (obj.$ref) return expand({ ...defs[String(obj.$ref).split("/").at(-1)!] as object, ...(obj.description ? { description: obj.description } : {}) }, defs);
  return Object.fromEntries(Object.entries(obj).filter(([key, item]) => key !== "$defs" && !(item && typeof item === "object" && (item as Record<string, unknown>).deprecated)).map(([key, item]) => [key, expand(item, defs)]));
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("official tool surface", () => {
  it.each(fixture)("matches $name including nested fields and descriptions", ({ name, inputSchema }) => {
    expect(normalize(zodToJsonSchema(toolSchemas[name], { $refStrategy: "none" }))).toEqual(normalize(expand(inputSchema, inputSchema.$defs as Record<string, unknown> ?? {})));
  });
});
describe("Calendar HTTP boundary", () => {
  it("lists timezone-aware events with filters and pagination", async () => {
    const calls: string[] = [];
    const client = new CalendarClient("token", async input => { calls.push(String(input)); return json(calls.length === 1 ? { timeZone: "Europe/Paris" } : { items: [{ id: "event" }], nextPageToken: "next" }); });
    const result = await client.list_events({ startTime: "2026-10-08T15:00:00", endTime: "2026-10-08T16:00:00", eventType: ["FOCUS_TIME"], pageToken: "page" });
    const url = new URL(calls[1]);
    expect(url.searchParams.get("timeMin")).toBe("2026-10-08T13:00:00.000Z");
    expect(url.searchParams.get("eventTypes")).toBe("focusTime");
    expect(url.searchParams.get("pageToken")).toBe("page");
    expect(result.nextPageToken).toBe("next");
  });
  it("lists events on a readable calendar missing from the user's calendarList", async () => {
    const calls: string[] = [];
    const client = new CalendarClient("token", async input => {
      const url = new URL(String(input)); calls.push(url.pathname + url.search);
      if (url.pathname.includes("/calendarList/")) return json({ error: { status: "NOT_FOUND", message: "Not Found", errors: [{ reason: "notFound" }] } }, 404);
      return json(url.searchParams.get("maxResults") === "1" ? { timeZone: "America/New_York", items: [] } : { items: [{ id: "event" }] });
    });
    const result = await client.list_events({ calendarId: "colleague@example.com", startTime: "2026-10-12T09:00:00", endTime: "2026-10-12T10:00:00" });
    expect(calls[1]).toBe("/calendar/v3/calendars/colleague%40example.com/events?maxResults=1");
    expect(new URL(`https://x${calls[2]}`).searchParams.get("timeMin")).toBe("2026-10-12T13:00:00.000Z");
    expect(result.events).toHaveLength(1);
  });
  it("surfaces Google's HTTP status and reason when a calendar is not accessible", async () => {
    const client = new CalendarClient("token", async () => json({ error: { status: "NOT_FOUND", message: "Not Found", errors: [{ reason: "notFound" }] } }, 404));
    const error = await client.list_events({ calendarId: "nobody@example.com" }).catch(caught => caught);
    expect(error).toMatchObject({ status: 404, reason: "request_failed", message: "Google Calendar request failed (request_failed, HTTP 404: NOT_FOUND notFound - Not Found)" });
  });
  it("creates status events with required properties and guest mapping", async () => {
    let body: Record<string, unknown> = {};
    const client = new CalendarClient("token", async (_, init) => { body = JSON.parse(String(init?.body)); return json(body); });
    await client.create_event({ summary: "Focus", startTime: "2026-10-08T15:00:00", endTime: "2026-10-08T16:00:00", timeZone: "Europe/Paris", eventType: "FOCUS_TIME", guestPermissions: { guestsCanSeeGuests: false } });
    expect(body.focusTimeProperties).toEqual({ autoDeclineMode: "declineNone" });
    expect(body.transparency).toBe("opaque");
    expect(body.guestsCanSeeOtherGuests).toBe(false);
  });
  it("patches only supplied fields, preserving duration and other guests", async () => {
    const bodies: unknown[] = [];
    const client = new CalendarClient("token", async (_, init) => {
      if (init?.body) { bodies.push(JSON.parse(String(init.body))); return json({ id: "event" }); }
      return json({ start: { dateTime: "2026-10-08T10:00:00Z" }, end: { dateTime: "2026-10-08T11:30:00Z" }, attendees: [{ email: "keep@example.com", responseStatus: "accepted" }, { email: "remove@example.com" }] });
    });
    await client.update_event({ eventId: "event", startTime: "2026-10-09T10:00:00", timeZone: "UTC", removedAttendeeEmails: ["REMOVE@example.com"], addedAttendees: [{ email: "new@example.com", optionalAttendee: true }] });
    expect(bodies[0]).toEqual({ start: { dateTime: "2026-10-09T10:00:00.000Z", timeZone: "UTC" }, end: { dateTime: "2026-10-09T11:30:00.000Z", timeZone: "UTC" }, attendees: [{ email: "keep@example.com", responseStatus: "accepted" }, { email: "new@example.com", optional: true }] });
  });
  it("responds as connected attendee and maps notifications", async () => {
    let body: unknown; let url = "";
    const client = new CalendarClient("token", async (input, init) => { if (init?.body) { body = JSON.parse(String(init.body)); url = String(input); return json({}); } return json({ attendees: [{ email: "me@example.com", self: true }, { email: "other@example.com" }] }); });
    await client.respond_to_event({ eventId: "id", responseStatus: "accepted", responseComment: "See you", notificationLevel: "EXTERNAL_ONLY" }, "me@example.com");
    expect(new URL(url).searchParams.get("sendUpdates")).toBe("externalOnly");
    expect(body).toEqual({ attendees: [{ email: "me@example.com", self: true, responseStatus: "accepted", comment: "See you" }, { email: "other@example.com" }] });
  });
  it("never suggests falsely free time when an attendee is inaccessible", async () => {
    const client = new CalendarClient("token", async () => json({ calendars: { "me@example.com": { errors: [{ reason: "notFound" }] } } }));
    await expect(client.suggest_time({ attendeeEmails: ["me@example.com"], startTime: "2026-10-08T10:00:00Z", endTime: "2026-10-08T12:00:00Z", timeZone: "UTC" })).rejects.toThrow("Availability is unavailable");
  });
  it("times out even when fetch ignores abort, and subsequent requests progress", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(json({ items: [] }));
    const client = new CalendarClient("token", fetcher);
    const request = client.list_calendars({});
    const assertion = expect(request).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
    expect(await client.list_calendars({})).toEqual({ calendars: [], nextPageToken: null });
  });
});
describe("event mapping", () => {
  it("round trips all-day recurrence, Meet, reminders, and working location", () => {
    const event = mapEvent({ summary: "Home", startTime: "2026-10-08", endTime: "2026-10-09", allDay: true, eventType: "WORKING_LOCATION", workingLocationProperties: { type: "HOME_OFFICE" }, recurrenceData: ["RRULE:FREQ=WEEKLY"], googleMeetUrl: "abc-defg-hij", overrideReminders: [{ method: "popup", minutes: 10 }] }, "Europe/Paris");
    const result = eventResult(event);
    expect(result.allDay).toBe(true);
    expect(result.recurrenceData).toEqual(["RRULE:FREQ=WEEKLY"]);
    expect(result.googleMeetUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(result.workingLocationProperties?.type).toBe("HOME_OFFICE");
    expect(result.overrideReminders).toEqual([{ method: "popup", minutes: 10 }]);
    expect(event.visibility).toBe("public");
    expect(event.transparency).toBe("transparent");
  });
  it("rejects nonexistent DST times", () => expect(() => resolveTime("2026-03-29T02:30:00", "Europe/Paris")).toThrow("DST"));
});
describe("time suggestions", () => {
  it.each([
    { busy: [{ start: "2026-10-08T10:00:00Z", end: "2026-10-08T11:00:00Z" }, { start: "2026-10-08T10:30:00Z", end: "2026-10-08T11:30:00Z" }], expected: "2026-10-08T11:30:00.000Z" },
    { busy: [{ start: "2026-10-08T09:00:00Z", end: "2026-10-08T10:00:00Z" }], expected: "2026-10-08T10:00:00.000Z" },
    { busy: [{ start: "2026-10-08T10:30:00Z", end: "2026-10-08T13:00:00Z" }], expected: "2026-10-08T10:00:00.000Z" },
  ])("handles busy overlap and window edges", ({ busy, expected }) => expect(suggestSlots(busy, Date.parse("2026-10-08T10:00:00Z"), Date.parse("2026-10-08T12:00:00Z"), 30)[0]?.startTime).toBe(expected));
  it("respects working hours and weekends across DST", () => {
    const result = suggestSlots([], Date.parse("2026-03-28T00:00:00Z"), Date.parse("2026-03-31T00:00:00Z"), 30, "Europe/Paris", { excludeWeekends: true, startHour: "09:00", endHour: "17:00", pageSize: 1 });
    expect(result[0].startTime).toBe("2026-03-30T07:00:00.000Z");
  });
  it("returns no slot below minimum duration", () => expect(suggestSlots([], 0, 29 * 60000, 30)).toEqual([]));
  it.each([
    { start: "2026-10-09T23:45:00Z", expected: 0 },
    { start: "2026-10-09T23:30:00Z", expected: 1 },
  ])("excludes slots crossing into weekends but allows midnight ends", ({ start, expected }) => {
    expect(suggestSlots([], Date.parse(start), Date.parse("2026-10-10T00:30:00Z"), 30, "UTC", { excludeWeekends: true })).toHaveLength(expected);
  });
});
describe("extension identity and auth signals", () => {
  const config = { global: {}, agent: {}, merged: {}, oauth: { connected: true as const, provider: "google", accessToken: "token", account: "me@example.com", scopes: [] } };
  it.each([[401, {}, "expired"], [403, {}, "insufficient_scope"], [429, {}, "rate_limited"], [403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }, "rate_limited"]])("maps HTTP %s without raw errors", async (status, payload, reason) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(payload, status as number)));
    const tools = calendar.getAgentTools({ id: "agent", extensions: { googleCalendar: {} } }, { config: {}, resolveOAuth: async () => config.oauth });
    expect(await (await tools)[0].execute({})).toMatchObject({ connected: false, reason });
  });
  it("includes account and mounts all nine tools with read-only hints", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async input => json(String(input).includes("userinfo") ? { email: "me@example.com" } : { items: [] })));
    const tools = await calendar.getAgentTools({ id: "agent", extensions: { googleCalendar: {} } }, { config: {}, resolveOAuth: async () => config.oauth });
    expect(tools).toHaveLength(9);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(["list_calendars", "list_events", "get_event", "search_events", "suggest_time"].some(name => tool.name === `googleCalendar_${name}`));
    expect(tools.map(tool => tool.name)).toEqual(Object.keys(toolSchemas).map(name => `googleCalendar_${name}`));
    expect(await tools.find(tool => tool.name === "googleCalendar_list_calendars")!.execute({})).toMatchObject({ account: "me@example.com" });
  });
  it("does not mutate on wrong account", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ email: "wrong@example.com" })); vi.stubGlobal("fetch", fetcher);
    const tools = await calendar.getAgentTools({ id: "agent", extensions: { googleCalendar: {} } }, { config: {}, resolveOAuth: async () => config.oauth });
    expect(await tools.find(tool => tool.name === "googleCalendar_delete_event")!.execute({ eventId: "id" })).toMatchObject({ reason: "wrong_account" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("additional HTTP contracts", () => {
  it("paginates descending order across all server pages", async () => {
    const client = new CalendarClient("token", async input => json(String(input).includes("pageToken=next") ? { items: [{ id: "later" }] } : { items: [{ id: "earlier" }], nextPageToken: "next" }));
    const params = { startTime: "2026-10-08T00:00:00Z", endTime: "2026-10-09T00:00:00Z", timeZone: "UTC", orderBy: "startTimeDesc", pageSize: 1 };
    const first = await client.list_events(params);
    expect(first.events[0].eventId).toBe("later");
    expect((await client.list_events({ ...params, pageToken: first.nextPageToken! })).events[0].eventId).toBe("earlier");
  });
  it("adds/removes attachments without dropping retained metadata", async () => {
    let body: unknown;
    const client = new CalendarClient("token", async (_, init) => { if (init?.body) { body = JSON.parse(String(init.body)); return json({}); } return json({ attachments: [{ fileUrl: "keep", title: "kept", mimeType: "text/plain" }, { fileUrl: "remove" }] }); });
    await client.update_event({ eventId: "id", timeZone: "UTC", addedAttachments: [{ fileUrl: "new" }], removedAttachmentFileUrls: ["remove"] });
    expect(body).toEqual({ attachments: [{ fileUrl: "keep", title: "kept", mimeType: "text/plain" }, { fileUrl: "new" }] });
  });
  it.each([["NONE", "none"], ["EXTERNAL_ONLY", "externalOnly"], ["ALL", "all"], [undefined, "all"]] as const)("maps delete notification %s", async (level, expected) => {
    let url = "";
    const client = new CalendarClient("token", async input => { url = String(input); return new Response(null, { status: 204 }); });
    expect(await client.delete_event({ eventId: "id", notificationLevel: level })).toEqual({ deleted: true, eventId: "id" });
    expect(new URL(url).searchParams.get("sendUpdates")).toBe(expected);
  });
  it("times out while reading a hung response body", async () => {
    vi.useFakeTimers();
    const response = new Response(new ReadableStream({ start() {} }), { status: 200 });
    const client = new CalendarClient("token", async () => response);
    const assertion = expect(client.list_calendars({})).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15000); await assertion;
  });
  it("preserves local fractional seconds and rejects impossible dates", () => {
    expect(new Date(resolveTime("2026-10-08T10:00:00.123", "Europe/Paris")).toISOString()).toBe("2026-10-08T08:00:00.123Z");
    expect(() => resolveTime("2026-02-30T10:00:00", "UTC")).toThrow("Invalid timestamp");
  });
  it("passes primary-only search query and paginated calendar listing", async () => {
    const urls: string[] = [];
    const client = new CalendarClient("token", async input => { urls.push(String(input)); return json({ items: [], nextPageToken: "next" }); });
    await client.search_events({ query: "Acme", pageSize: 10, pageToken: "previous" });
    await client.list_calendars({ pageSize: 20, pageToken: "previous" });
    expect(new URL(urls[0]).pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(new URL(urls[0]).searchParams.get("q")).toBe("Acme");
    expect(new URL(urls[1]).searchParams.get("maxResults")).toBe("20");
  });
});

it("responds as token user when shared calendar self belongs to another attendee", async () => {
  let body: unknown;
  const client = new CalendarClient("token", async (_, init) => { if (init?.body) { body = JSON.parse(String(init.body)); return json({}); } return json({ attendees: [{ email: "owner@example.com", self: true }, { email: "ME@example.com" }] }); });
  await client.respond_to_event({ eventId: "id", responseStatus: "declined" }, "me@example.com");
  expect(body).toEqual({ attendees: [{ email: "owner@example.com", self: true }, { email: "ME@example.com", responseStatus: "declined" }] });
});
it("rejects RSVP when calendar self is another account and token user is absent", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ attendees: [{ email: "owner@example.com", self: true }] }));
  await expect(new CalendarClient("token", fetcher).respond_to_event({ eventId: "id", responseStatus: "declined" }, "me@example.com")).rejects.toThrow("not an attendee");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("returns a clear connect link for disconnected and expired grants", async () => {
  const tools = await calendar.getAgentTools({ id: "agent /", extensions: { googleCalendar: {} } }, { config: {} });
  expect(await tools[0].execute({})).toMatchObject({ connected: false, authorizeUrl: "/agents/agent%20%2F/extensions/googleCalendar" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 401)));
  const connectedTools = await calendar.getAgentTools({ id: "agent /", extensions: { googleCalendar: {} } }, { config: {}, resolveOAuth: async () => ({ connected: true, provider: "google", accessToken: "token", scopes: [] }) });
  expect(await connectedTools[0].execute({})).toMatchObject({ reason: "expired", authorizeUrl: "/agents/agent%20%2F/extensions/googleCalendar" });
});
it.each([true, false])("clears old nested time representation on allDay conversion %s", async allDay => {
  const existing = allDay ? { start: { dateTime: "2026-10-08T10:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-10-08T11:00:00Z", timeZone: "UTC" } } : { start: { date: "2026-10-08" }, end: { date: "2026-10-09" } };
  let patched: Record<string, unknown> = {};
  const client = new CalendarClient("token", async (_, init) => {
    if (!init?.body) return json(existing);
    const body = JSON.parse(String(init.body));
    patched = Object.fromEntries(["start", "end"].map(key => { const merged = { ...existing[key as keyof typeof existing], ...body[key] }; for (const field of Object.keys(merged)) if (merged[field] === null) delete merged[field]; return [key, merged]; }));
    return json(patched);
  });
  await client.update_event({ eventId: "id", timeZone: "UTC", allDay, startTime: "2026-10-08T10:00:00", endTime: "2026-10-09T11:00:00" });
  for (const value of Object.values(patched)) expect(Object.keys(value as object).sort()).toEqual(allDay ? ["date"] : ["dateTime", "timeZone"]);
});
