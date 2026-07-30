# Pack calendar

The CMS owns calendar records, calendar administration, the public JSON
contract, and the iCalendar feed. Calendar records are intentionally separate
from SonicJS's generic content tables so every mutation passes through the same
validation, authorization, optimistic-concurrency, and history controls.

## Volunteer workflow

Visit `https://cms.macon170.com/admin/calendar`. SonicJS authentication redirects
back to the calendar after sign-in. Access requires an active CMS account with
the `calendar.manage` permission. Administrators receive that permission by
default; an administrator can explicitly grant it to another user by adding the
user and `perm_calendar_manage` permission IDs to `user_permissions`.

New events begin as drafts. Saving a change, publishing, or archiving increments
the event revision and writes an immutable snapshot. The editor reports a
conflict rather than overwriting a change made since the event was loaded.
Cancellation is an event status, independent of draft/published/archived state.
There is no hard-delete route.

## Public API

All JSON uses camelCase and includes `version: "v1"`.

- `GET /api/calendar/v1/events` returns `{ version, events }` for published
  events that have not ended, ordered by start time.
- `GET /api/calendar/v1/events/:slug` returns `{ version, event }`.
- `GET|HEAD /api/calendar/v1/calendar.ics` returns the subscription feed.

Only published events are public. Published cancellations remain visible so
families and calendar clients receive the cancellation. Responses are cached
for five minutes, carry deterministic ETags, and honor `If-None-Match`. The
configured `CORS_ORIGINS` may read the JSON without credentials.

The management API lives under `/api/calendar-admin/v1`. It is same-origin,
requires SonicJS authentication and `calendar.manage`, requires the signed CSRF
cookie/header pair for mutations, and uses `expectedRevision` for changes.

## Local migration and recovery

`bun run db:migrate:local` applies SonicJS migrations followed by every
unapplied Pack-specific migration in `migrations/custom/`. Production uses the
same two tracked migration ledgers through `bun run db:migrate`. Add new custom
schema changes as sequentially numbered SQL files; never edit an applied
migration. Production migrations must run only in an approved deployment
window.

The history table is append-only and contains a complete snapshot for every
revision. To recover from an incorrect change:

1. Read the desired snapshot from `calendar_event_history`.
2. Re-enter those values through the calendar editor; do not update tables
   directly or delete later history.
3. Publish the corrected event if it should be public.

This implementation starts with an empty CMS calendar. It does not import,
translate, query, or delete the public site's legacy calendar or audit tables.
