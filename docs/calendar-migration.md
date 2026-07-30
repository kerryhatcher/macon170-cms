# Calendar migration runbook

`calendar-event` is the CMS authoring collection. SonicJS publication status is
the visibility state (`draft`, `published`, or `archived`); `eventStatus` keeps
the family-facing scheduled/tentative/cancelled state. `legacyEventId` and
`adapterRevision` preserve the public iCalendar UID and `SEQUENCE` contract.

The only public CMS route is `GET /api/calendar-projection/v1`. It returns the
versioned, published-only DTO consumed by the public site's adapter. It has no
calendar write route. SonicJS's existing authenticated admin content workflow
remains the sole authoring surface.

## Approved-window import

1. Take read-only JSON exports of `calendar_events` and `event_audit_log` from
   the public database. Keep those legacy tables and records intact.
2. Confirm the CMS collection has synced, then get its collection ID and the
   existing CMS administrator ID through the CMS admin database.
3. Run `bun scripts/prepare-calendar-import.ts snapshot.json COLLECTION_ID ADMIN_USER_ID > /tmp/calendar-import.sql`.
   The generated `INSERT ... ON CONFLICT(id)` statements are idempotent and use
   each immutable legacy event ID as the SonicJS content ID.
4. Apply that SQL only to the CMS D1 database in the approved maintenance
   window. Do not run remote commands as part of this code change.
5. Fetch the CMS projection and run `bun scripts/calendar-comparison-report.ts snapshot.json projection.json`.
   Resolve every difference, including UID/revision mismatches, before shadow
   reads.

## Cutover and rollback

The public Worker defaults to `CALENDAR_READ_SOURCE=legacy`. Set it to `shadow`
to compare the CMS projection while continuing to serve legacy rows. Once the
comparison is clean, an approved deployment can set it to `cms`; adapter
failures then return a clear 502 and never read stale legacy rows. Roll back by
setting it back to `legacy`; do not dual-write. Keep `/api/events`, event
detail URLs, and `/api/calendar.ics` unchanged throughout.
