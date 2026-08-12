# Signup form admin CRUD — design

Date: 2026-08-12
Status: approved for planning
Repos: `macon170-cms` only. No `macon170.com` changes.

## Problem

The original signup-forms design (`2026-08-08-signup-forms-design.md`) sketched
`/admin/signups/:id` as showing form settings alongside the response table, but
only the response table shipped. Today `renderSignupAdminPage` and
`renderSignupAdminDetailPage` (`src/signup-admin-page.ts`) are read-only: a
volunteer can browse forms and manage responses (resend, delete), but creating
or editing a form itself requires calling `POST`/`PUT
/api/signups-admin/v1/forms[/:id]` directly, since those endpoints already
exist and already accept the full shape. There is no UI for it.

This design adds that UI. It does not touch the backend contract.

## Decisions

| Decision | Choice |
| --- | --- |
| Event picker source | Reuse the existing `GET /api/calendar-admin/v1/events`. Volunteers creating or editing signup forms now also need `calendar.manage`, in addition to `signups.manage`. Both are already granted to the default `admin` role. |
| Page structure | Extend `/admin/signups/:id` with a form-settings panel above the existing response table. Add a sibling `/admin/signups/new` route for creation, since the current route only accepts a UUID-shaped id. |
| Slot reordering | Up/down buttons on each row. No drag-and-drop. |
| Destructive slot-edit guard | A client-side confirm dialog, shown only when a changed or removed slot currently has claims, naming the affected items and claim counts before the `PUT` is sent. |
| Form deletion | None added. `state = 'closed'` remains the archive-equivalent, matching the deliberate retention design (forms and slots are kept; only stale responses are purged). |
| Backend API changes | None. `POST /api/signups-admin/v1/forms` and `PUT .../forms/:id` already validate and persist the full shape via `validateSignupFormInput`. |

## Routes

`request-handler.ts` currently derives `rawFormId` from the path and 404s
anything that isn't UUID-shaped (`request-handler.ts:317`, guarding
`renderSignupAdminDetailPage`). Add a check for the literal segment `"new"`
before that guard, rendering the detail page in **create mode**: the
form-settings panel with default values, no response table (nothing exists
yet to show).

`renderSignupAdminPage` (the list page) gets one addition: a "New form" link
to `/admin/signups/new`. Existing per-row links to `/admin/signups/:id` are
unchanged.

On a successful create (`POST /forms` returns `201`), redirect the browser to
`/admin/signups/:newId`. On a successful edit (`PUT /forms/:id`), re-render in
place with a saved notice — the same pattern `calendar-admin-page.ts:194` uses
— rather than navigating away.

## Form settings panel

Fields, all mapping directly onto `SignupFormInput` (`signups.ts:67-76`):

- **Slug** — text input, client-side pattern/length matching `slugPattern`
  (`signups.ts:159`) for early feedback.
- **Event** — `<select>` populated from `GET /api/calendar-admin/v1/events`,
  fetching *all* events, not only published ones, since a form may need to
  attach to a draft event before it is announced.
- **Form type** — radio, `rsvp` / `items`. Toggling shows or hides the slot
  editor (section below).
- **Title** — text input, 2–120 chars.
- **Instructions** — textarea, ≤2000 chars, optional.
- **State** — `<select>`, `draft` / `open` / `closed`.
- **Closes at** — optional `datetime-local`, converted to/from UTC the same
  way `calendar-admin-page.ts:124-129` handles `startsAt`/`endsAt`.

Edit mode sends `expectedRevision` from the loaded form. A `409` (stale
revision, or a slug collision surfaced as a conflict) renders as an inline
notice — "This signup changed since it was loaded — reload and reapply your
edit" — never a silent overwrite, matching the calendar page's handling of the
same error shape.

No backend changes are required for this panel. Every field it collects is
already accepted and validated by the existing admin API.

## Slot editor (items forms only) and the destructive-edit guard

Repeatable rows: label, quantity needed, notes, a "Remove" button per row, an
"Add item" button, and up/down buttons to reorder (position is row index).
Each existing row shows its current claimed count, computed client-side from
the `responses[].claims` data the detail page already fetches — the same
computation `signup-admin-page.ts:134-141` uses for the per-slot summary line.
Newly added rows show no count.

`docs/signups.md:28-34` documents the backend rule: `signup_slots` is replaced
wholesale, cascading every affected claim, whenever the submitted slot list
differs from the stored one in any row's label, order, quantity, or notes —
including the case where switching form type from `items` to `rsvp` removes
all slots. The editor mirrors that same diff client-side before submitting.
If the diff touches any slot that currently has claims, show a confirm dialog
naming the affected items and their claim counts, e.g.:

> Removing "Hot dogs" deletes 3 families' claims for it. Continue?

Only proceed to `PUT` on confirmation. If no changed or removed slot has
claims, save immediately — no dialog.

## Validation and error handling

Client-side constraints mirror the server's (slug pattern/length, title
2–120, instructions ≤2000, slot label ≤120, quantity 1–500) for early
feedback only. `validateSignupFormInput` (`signups.ts:221-289`) remains the
source of truth; every request still round-trips through it regardless of
what the form UI allowed to be typed. Request plumbing (CSRF header, JSON
body, `credentials: same-origin`, error message from `payload.error.message`)
reuses the pattern already in `calendar-admin-page.ts`'s inline `request()`
helper.

## Testing

Extends `signup-admin-page.test.ts` (currently two script-injection-escaping
cases) with:

- The settings panel renders in both create and edit mode without
  double-escaping the CSRF token or the loaded form/event data through the
  existing `scriptSafeJson` choke point.
- Create-mode output omits the response table entirely.
- The slot-diff function (pure, extracted so it's testable outside the inline
  `<script>`) flags a slot as "affected" only when its label, position,
  quantity, or notes changed or it was removed, and only surfaces the
  claim-loss warning when that slot's claim count is greater than zero.

No backend or API test changes: `signup-admin.ts`, `signup-store.ts`, and
`signups.ts` are unchanged and already covered by their existing suites.

## Out of scope

- Hard deletion of a form. `state = 'closed'` is the intended end-of-life
  action; forms and slots are retained deliberately so a volunteer can reuse
  last year's shopping list.
- CSV import or export of slots.
- Any change to the `signups.manage` / `calendar.manage` permission split.
  Per the event-picker decision above, creating or editing a signup form now
  also requires `calendar.manage`. A future signups-only volunteer role would
  need both permissions granted, not just `signups.manage`.
