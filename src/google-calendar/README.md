# Google Calendar extension

Google Calendar events and availability via host-managed Google OAuth. Enable
`googleCalendar: {}` under an agent's `extensions`, then connect from its Google
Calendar settings using **Just me** or **Whole team**. Only admins can configure
the team connection; the host uses the requester's personal connection first,
then the team's connection. Gmail, Drive, and Calendar on the same agent share
the host's Google provider connection.

Reuse `oauth.providers.google` from Gmail or Drive. Enable the Google Calendar
API in that OAuth client's Google Cloud project and approve these scopes:
`calendar.events`, `calendar.calendarlist.readonly`, `calendar.freebusy`, and
`userinfo.email` (under `https://www.googleapis.com/auth/`). Reconnect when adding
Calendar permissions to an existing Google connection. No credentials belong
in the extension configuration; this extension stores no tokens or calendar data.

## Install

```bash
pnpm install
pnpm build
ln -sfn "$PWD/dist/google-calendar" "$YOPLAI_HOME/extensions/google-calendar"
```

Set `YOPLAI_HOME` to your host's configuration directory before installing.

## Tools

Names mount with the `googleCalendar_` prefix. The first five tools are read-only.

| Name | Behavior |
| --- | --- |
| `list_calendars` | List accessible calendars with pagination |
| `list_events` | List events by time range, text, and event type |
| `get_event` | Read one event |
| `search_events` | Search the primary calendar with free-text `query` |
| `suggest_time` | Rank free slots across attendees using duration and preferences |
| `create_event` | Create timed, all-day, recurring, or special events, optionally with Meet |
| `update_event` | Patch specified fields; moving only the start preserves duration |
| `delete_event` | Delete an event |
| `respond_to_event` | Accept, decline, or tentatively accept an invitation with a comment |

`calendarId` defaults to `primary`. Local times use the selected calendar's time
zone unless `timeZone` is specified. All-day end dates are exclusive, following
the Calendar API. `notificationLevel` maps `NONE`, `EXTERNAL_ONLY`, and `ALL` to
Google's `sendUpdates`. Every successful result includes `account`.

Tools report structured Google connection signals for `not_connected`,
`expired`, `insufficient_scope`, `wrong_account`, and `rate_limited`; reconnect
guidance includes the host-provided authorization link when available.
Suggestions use Calendar API free/busy data and a local ranking function,
not Google's private suggestion logic. No calendar creation, ACL management,
settings changes, background sync, or official MCP proxying is included.

Google REST does not provide descending event order. `orderBy: startTimeDesc`
reads the complete requested time range before returning a descending page;
subsequent pages repeat that read without storing calendar data. Working-hour
and weekend preferences constrain suggested slots, which are ordered earliest
first. Unavailable attendee free/busy data produces an error rather than a
potentially conflicting suggestion.
