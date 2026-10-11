import type { z } from "zod";
import { toolSchemas } from "./models.js";
import { eventResult, mapEvent, resolveTime, type EventResource } from "./event-mapper.js";
import { suggestSlots, type BusyInterval } from "./time-suggester.js";
type Params<K extends keyof typeof toolSchemas> = z.infer<(typeof toolSchemas)[K]>;
function validatePageSize(size?: number) { if (size !== undefined && (!Number.isInteger(size) || size < 1 || size > 250)) throw new Error("pageSize must be between 1 and 250"); }
const BASE = "https://www.googleapis.com/calendar/v3";
export class CalendarRequestError extends Error {
  constructor(readonly status: number, readonly reason: string, detail = "") { super(`Google Calendar request failed (${reason}, HTTP ${status}${detail ? `: ${detail}` : ""})`); }
}
export class CalendarClient {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async account(): Promise<string> { const data = await this.request("https://www.googleapis.com/oauth2/v2/userinfo"); return String(data.email ?? ""); }
  private path(calendarId = "primary", eventId?: string) { return `/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`; }
  private async zone(calendarId = "primary", explicit?: string): Promise<string> {
    if (explicit) { new Intl.DateTimeFormat("en", { timeZone: explicit }); return explicit; }
    // calendarList only holds calendars the user added to their list; other readable calendars 404 there, but events.list reports their time zone.
    const calendar = await this.request(`/users/me/calendarList/${encodeURIComponent(calendarId)}`).catch(error => {
      if (error instanceof CalendarRequestError && error.status === 404) return this.request(`${this.path(calendarId)}?maxResults=1`);
      throw error;
    });
    if (typeof calendar.timeZone !== "string") throw new Error("Calendar did not return a time zone");
    return calendar.timeZone;
  }
  async list_calendars(params: Params<"list_calendars">) {
    validatePageSize(params.pageSize);
    const data = await this.request(`/users/me/calendarList?${this.query({ maxResults: params.pageSize ?? 100, pageToken: params.pageToken })}`);
    return { calendars: data.items ?? [], nextPageToken: typeof data.nextPageToken === "string" ? data.nextPageToken : null };
  }
  async list_events(params: Params<"list_events">) {
    validatePageSize(params.pageSize);
    const timeZone = await this.zone(params.calendarId, params.timeZone);
    const start = params.startTime ? resolveTime(params.startTime, timeZone) : Date.now();
    const end = params.endTime ? resolveTime(params.endTime, timeZone) : start + 7 * 86400000;
    if (end <= start) throw new Error("endTime must be after startTime");
    const order = params.orderBy;
    if (order && !["default", "startTime", "startTimeDesc", "lastModified"].includes(order)) throw new Error("Unsupported orderBy");
    const query = this.query({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), timeZone, q: params.fullText, orderBy: order === "lastModified" ? "updated" : ["startTime", "startTimeDesc"].includes(order ?? "") ? "startTime" : undefined, singleEvents: true, maxResults: params.pageSize ?? 100, pageToken: order === "startTimeDesc" ? undefined : params.pageToken });
    const eventTypes: Record<string, string> = { EVENT_TYPE_UNSPECIFIED: "default", DEFAULT: "default", OUT_OF_OFFICE: "outOfOffice", FOCUS_TIME: "focusTime", WORKING_LOCATION: "workingLocation", BIRTHDAY: "birthday", FROM_GMAIL: "fromGmail" };
    for (const type of params.eventType?.length ? params.eventType : ["DEFAULT", "OUT_OF_OFFICE", "FOCUS_TIME", "FROM_GMAIL"]) query.append("eventTypes", eventTypes[type]);
    if (order === "startTimeDesc") {
      const offset = params.pageToken ? Number(params.pageToken.replace(/^calendar-desc:/, "")) : 0;
      if (params.pageToken && !/^calendar-desc:\d+$/.test(params.pageToken) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid descending page token");
      const events: EventResource[] = [];
      let next: string | undefined;
      do {
        if (next) query.set("pageToken", next);
        const page = await this.request(`${this.path(params.calendarId)}?${query}`);
        events.push(...(page.items as EventResource[] ?? []));
        next = page.nextPageToken as string | undefined;
      } while (next);
      events.reverse();
      const pageSize = params.pageSize ?? 100;
      return { events: events.slice(offset, offset + pageSize).map(eventResult), nextPageToken: offset + pageSize < events.length ? `calendar-desc:${offset + pageSize}` : null };
    }
    const data = await this.request(`${this.path(params.calendarId)}?${query}`);
    return { events: (data.items as EventResource[] ?? []).map(eventResult), nextPageToken: typeof data.nextPageToken === "string" ? data.nextPageToken : null };
  }
  async search_events(params: Params<"search_events">) {
    validatePageSize(params.pageSize);
    const data = await this.request(`${this.path()}?${this.query({ q: params.query, maxResults: params.pageSize ?? 100, pageToken: params.pageToken })}`);
    return { events: (data.items as EventResource[] ?? []).map(eventResult), nextPageToken: typeof data.nextPageToken === "string" ? data.nextPageToken : null };
  }
  async get_event(params: Params<"get_event">) { return eventResult(await this.request(this.path(params.calendarId, params.eventId)) as EventResource); }
  async suggest_time(params: Params<"suggest_time">) {
    if (!params.attendeeEmails.length) throw new Error("At least one attendee is required");
    const timeZone = await this.zone("primary", params.timeZone);
    const start = resolveTime(params.startTime, timeZone), end = resolveTime(params.endTime, timeZone);
    if (end <= start) throw new Error("endTime must be after startTime");
    const data = await this.request("/freeBusy", { method: "POST", body: JSON.stringify({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), timeZone, items: params.attendeeEmails.map(id => ({ id })) }) });
    const calendars = data.calendars as Record<string, { busy?: BusyInterval[]; errors?: unknown[] }> | undefined;
    for (const email of params.attendeeEmails) if (!calendars?.[email] || calendars[email].errors?.length) throw new Error(`Availability is unavailable for ${email}; no suggestions were generated`);
    return { slots: suggestSlots(Object.values(calendars ?? {}).flatMap(calendar => calendar.busy ?? []), start, end, params.durationMinutes ?? 30, timeZone, params.preferences) };
  }
  async create_event(params: Params<"create_event">, account?: string) {
    const timeZone = await this.zone(params.calendarId, params.timeZone);
    if ((!params.calendarId || params.calendarId === "primary") && params.attendees?.length && account && !params.attendees.some(item => item.email.toLowerCase() === account.toLowerCase())) params = { ...params, attendees: [...params.attendees, { email: account }] };
    const body = mapEvent(params, timeZone);
    return eventResult(await this.request(`${this.path(params.calendarId)}?${this.mutationQuery(params.notificationLevel)}`, { method: "POST", body: JSON.stringify(body) }) as EventResource);
  }
  async update_event(params: Params<"update_event">) {
    const existing = await this.request(this.path(params.calendarId, params.eventId)) as EventResource;
    const timeZone = await this.zone(params.calendarId, params.timeZone);
    const body = mapEvent(params, timeZone, existing);
    return eventResult(await this.request(`${this.path(params.calendarId, params.eventId)}?${this.mutationQuery(params.notificationLevel)}`, { method: "PATCH", body: JSON.stringify(body) }) as EventResource);
  }
  async delete_event(params: Params<"delete_event">) { await this.request(`${this.path(params.calendarId, params.eventId)}?${this.mutationQuery(params.notificationLevel)}`, { method: "DELETE" }); return { deleted: true, eventId: params.eventId }; }
  async respond_to_event(params: Params<"respond_to_event">, account: string) {
    if (!["accepted", "declined", "tentative"].includes(params.responseStatus)) throw new Error("responseStatus must be accepted, declined, or tentative");
    const existing = await this.request(this.path(params.calendarId, params.eventId)) as EventResource;
    const own = existing.attendees?.find(item => item.email?.toLowerCase() === account.toLowerCase());
    if (!own) throw new Error("The connected account is not an attendee of this event");
    const attendees = existing.attendees?.map(item => item === own ? { ...item, responseStatus: params.responseStatus, ...(params.responseComment !== undefined ? { comment: params.responseComment } : {}) } : item);
    return eventResult(await this.request(`${this.path(params.calendarId, params.eventId)}?${this.mutationQuery(params.notificationLevel)}`, { method: "PATCH", body: JSON.stringify({ attendees }) }) as EventResource);
  }
  private mutationQuery(level?: string) { return this.query({ sendUpdates: level === "NONE" ? "none" : level === "EXTERNAL_ONLY" ? "externalOnly" : "all", conferenceDataVersion: 1, supportsAttachments: true }); }
  private query(values: Record<string, unknown>) { const result = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value !== undefined) result.set(key, String(value)); return result; }
  private async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Google Calendar request timed out; retry later")); }, 15000); });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await this.fetchImpl(path.startsWith("https://") ? path : `${BASE}${path}`, { ...init, signal: controller.signal, headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) } });
        if (!response.ok) {
          let reason = "", detail = "";
          try { const payload = await response.json() as { error?: { status?: string; message?: string; errors?: Array<{ reason?: string }> } }; reason = `${payload.error?.status ?? ""} ${payload.error?.errors?.map(item => item.reason).join(" ") ?? ""}`; detail = [reason.trim(), payload.error?.message].filter(Boolean).join(" - "); } catch { /* An empty response still maps from its HTTP status. */ }
          const mapped = response.status === 401 ? "expired" : response.status === 429 || response.status === 403 && /rate.?limit|quota|daily.?limit|resource_exhausted/i.test(reason) ? "rate_limited" : response.status === 403 ? "insufficient_scope" : "request_failed";
          throw new CalendarRequestError(response.status, mapped, detail);
        }
        if (response.status === 204) return {};
        return await response.json() as Record<string, unknown>;
      })()]);
    } finally { clearTimeout(timer); }
  }
}
