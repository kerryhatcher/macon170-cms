# Signup form admin CRUD — design

Date: 2026-08-12
Status: approved for planning (revised after review — see "Revision history")
Repos: `macon170-cms` only. No `macon170.com` changes.

## Problem

The original signup-forms design (`2026-08-08-signup-forms-design.md`) sketched
`/admin/signups/:id` as showing form settings alongside the response table, but
only the response table shipped. Today `renderSignupAdminPage` and
`renderSignupAdminDetailPage` (`src/signup-admin-page.ts`) are read-only: a
volunteer can browse forms and manage responses (resend, delete), but creating
or editing a form itself requires calling `POST`/`PUT
/api/signups-admin/v1/forms[/:id]` directly.

This design adds that UI. An opus review of the first draft (which assumed a
purely client-side change) found that the safety guard it depended on cannot
work against the current backend, so this revision includes one backend fix.

## Decisions

| Decision | Choice |
| --- | --- |
| Slot persistence model | **Backend change.** `updateSignupForm` currently replaces the entire slot list wholesale on any difference, cascading every claim on the form — not just claims on the changed row (`signup-store.ts:290-306`, `:409-418`; cascade via `migrations/custom/0004_signups.sql:64`). Change it to a per-row upsert keyed by each slot's existing `id`, so only actually-*removed* slots lose their claims. See "Backend change" below. |
| Event picker source | Reuse the existing `GET /api/calendar-admin/v1/events`. Creating a form (`/admin/signups/new`) now requires `calendar.manage` in addition to `signups.manage`, gated server-side. Editing a form degrades gracefully for a signups-only volunteer — see "Event picker and permission degradation" below. |
| Page structure | Extend `/admin/signups/:id` with a form-settings panel above the existing response table. Add a sibling `/admin/signups/new` route for creation, since the current route only accepts a UUID-shaped id. |
| Slot reordering | Up/down buttons on each row. No drag-and-drop. |
| Destructive slot-edit guard | A client-side confirm dialog, shown only when a slot **removed** from the list (including all slots, if switching form type from `items` to `rsvp`) currently has claims. Editing an existing slot's label, quantity, or notes in place is no longer destructive (see below) and needs no dialog. |
| Form deletion | None added. `state = 'closed'` remains the archive-equivalent, matching the deliberate retention design (forms and slots are kept; only stale responses are purged). |
| Other backend fixes bundled in | A stale/deleted `eventId` currently falls through to a generic `500` (no branch maps the FK violation, `signup-admin.ts:226-232`); map it to a `400` "That event no longer exists." Both are small, targeted changes to the same two files the slot-upsert fix already touches. |

## Backend change: slot upsert by stable id

`signup_slots` rows already have a real `id` (`crypto.randomUUID()` per row,
`signup-store.ts:274`) — the problem is purely that `SignupSlotInput`
(`signups.ts:44-49`) and `updateSignupForm` never make use of it, so the store
can't tell "this is the same item, edited" from "this item is gone and a new
one appeared."

Changes:

- `SignupSlotInput` gains an optional `id?: string`. `validateSignupFormInput`
  passes it through unchanged if present (no format validation beyond it
  being a string — the store reconciles it against reality).
- `updateSignupForm`'s phase 2 (`signup-store.ts:399-...`, unchanged in
  structure and in its two-phase optimistic-concurrency contract) replaces the
  wholesale `DELETE` + reinsert with three sets, computed by comparing
  submitted slot ids against the form's existing slot ids:
  - **Present in both** → `UPDATE` that row's `position`, `label`,
    `quantity_needed`, `notes`. Never touches `signup_claims`.
  - **In submitted, no matching existing id** (new row, `id` omitted or
    unrecognized) → `INSERT` with a fresh uuid, as today.
  - **In existing, absent from submitted** → `DELETE` that row. This is the
    only path that cascades claims, and it is inherent to actually removing an
    item — a family that claimed a deleted item unavoidably loses that claim.
- Because a claim's `label` is joined live from `signup_slots` at read time,
  not denormalized (`signup-store.ts:488-491`), renaming a slot in place
  requires no claim-side update at all — every existing claim automatically
  shows the new label.
- The `slotsReplaced` audit detail (`signup-store.ts:419-...`) becomes
  `slotsChanged: { added, updated, removed }` (counts or ids), so an operator
  can tell which of the three happened, matching the existing audit intent
  more precisely than a single boolean.
- No migration needed — `id` already exists on every row.

This directly fixes the bug the original draft's guard depended on: adding an
item to an open form, or editing a claimed item's label/quantity/notes, no
longer touches any existing claim.

## Routes

`request-handler.ts` currently derives `rawFormId` from the path and 404s
anything that isn't UUID-shaped (the check is at `request-handler.ts:326-329`,
using `uuidPattern` defined at `:89-90`; guards `renderSignupAdminDetailPage`).
Add a check for the literal segment `"new"` before that guard, rendering the
detail page in **create mode**: the form-settings panel with default values,
no response table (nothing exists yet to show). A signup form's `id` is
always a `crypto.randomUUID()` (`signup-store.ts:313`) and routing keys on
`id`, never `slug`, so a form slugged `"new"` cannot collide with this route.

Create mode additionally requires `calendar.manage` at the route level (403
with a clear message if absent) — see "Event picker and permission
degradation" below for why this one route can't degrade.

`renderSignupAdminPage` (the list page) gets one addition: a "New form" link
to `/admin/signups/new`. Existing per-row links to `/admin/signups/:id` are
unchanged.

On a successful create (`POST /forms` returns `201`), redirect the browser to
`/admin/signups/:newId`. On a successful edit (`PUT /forms/:id`), re-run the
page's full `load()` (re-fetching the form, its slots, and its responses) and
then show a saved notice — not just the notice — so the response table's
per-slot claimed counts and the in-memory `revision` used for the next save
are never stale. (The calendar page's own `load()` call after a save,
`calendar-admin-page.ts:195`, is the pattern to match; the first draft of this
spec cited the notice but dropped the reload.)

## Form settings panel

Fields, all mapping directly onto `SignupFormInput` (`signups.ts:67-76`):

- **Slug** — text input, client-side pattern/length matching `slugPattern`
  (`signups.ts:159`) for early feedback.
- **Event** — `<select>`, see picker section below.
- **Form type** — radio, `rsvp` / `items`. Toggling to `rsvp` hides the slot
  editor and, on save, removes every existing slot (see guard below, since
  `validateSignupFormInput:238` forces `slots: []` for `rsvp`).
- **Title** — text input, 2–120 chars.
- **Instructions** — textarea, ≤2000 chars, optional.
- **State** — `<select>`, `draft` / `open` / `closed`.
- **Closes at** — optional `datetime-local`, converted to/from UTC the same
  way `calendar-admin-page.ts:124-129` handles `startsAt`/`endsAt`.

Edit mode sends `expectedRevision` from the loaded form. Every error response
renders `payload.error.message` from the server directly, the same as the
calendar page's `request()` helper (`calendar-admin-page.ts:121`) already
does — **not** a fixed string. This matters because `SignupConflictError`
covers two different situations with two different messages (stale revision
vs. slug already taken, `signup-store.ts:341-343` and `:364`), and only the
server can say which one happened.

No further backend changes are required for this panel beyond the ones above.

## Event picker and permission degradation

The picker calls `GET /api/calendar-admin/v1/events`, which returns `id`,
`slug`, `title`, `startsAt` for every event including drafts and archived ones
(`listCalendarEvents(env, false)`, `request-handler.ts:686-691`) and requires
`calendar.manage` (`request-handler.ts:658-664`). Sort the options
upcoming-first (soonest `startsAt` first) and exclude archived events from the
list, rather than the raw `starts_at ASC` order the endpoint returns, so the
picker doesn't default-open on the oldest archived event on the pack's
calendar.

`/admin/signups*` itself is gated only on `signups.manage`
(`request-handler.ts:319`), so a volunteer can hold that permission without
`calendar.manage`. Two cases:

- **Create (`/admin/signups/new`)**: there is no event to fall back to, and
  `eventId` is required on every save (`signups.ts:272`), so this route
  requires `calendar.manage` up front, server-side, with a 403 explaining
  that permission is needed to attach a signup to an event — not a page that
  silently fails to load its picker.
- **Edit (`/admin/signups/:id`)**: the loaded `SignupFormDetail` already
  carries `eventId` (not `eventTitle` — that join only exists on the list
  endpoint, `signup-store.ts:176-183`), so seed the `<select>` with that
  single value before the picker fetch even starts. If
  `GET /api/calendar-admin/v1/events` then 403s, leave that one preselected
  option in place, disable the control, and show an inline notice ("Changing
  the event requires the calendar.manage permission — ask an administrator")
  next to it. Every other field remains editable and a title/instructions/
  state-only save still works, since the disabled select still submits the
  seeded `eventId`.

## Slot editor (items forms only) and the destructive-edit guard

Repeatable rows: label, quantity needed, notes, an `id` carried in a hidden
field (present for existing rows, absent for new ones), a "Remove" button per
row, an "Add item" button, and up/down buttons to reorder.

Because of the backend upsert fix above, the only slot edit that can lose a
claim is **removing a row that has claims**, or switching form type away from
`items` (which removes every row). Editing an existing row's label, quantity,
or notes in place never touches `signup_claims`, so no dialog is needed for
that case.

Guard logic:

- On load, compute each existing slot's **claimed-by count** — the number of
  *distinct families* with a claim on that slot, from `responses[].claims`
  (`signup-admin-page.ts:134-141` sums *quantity*; this is a related but
  different number — count responses, not quantity, since "3 families" is
  what the confirmation should say).
- Before submitting, diff the current row set against the loaded one **by
  id**: any loaded slot id absent from the current rows is a removal.
- If any removed slot has a claimed-by count > 0, show a confirm dialog
  naming each such slot and its count, e.g.:

  > Removing "Hot dogs" deletes 3 families' claims for it. Continue?

  Only proceed to `PUT` on confirmation. If no removed slot has claims (or
  none were removed), save immediately — no dialog.
- Client-side validation mirrors the server's remaining slot-list rules:
  at least one slot for an `items` form (`signups.ts:261-267`), at most 60
  slots (`:268`), label ≤120 chars, notes ≤300 chars (`:258`), quantity
  needed 1–500.

## Validation and error handling

Client-side constraints mirror the server's (slug pattern/length, title
2–120, instructions ≤2000, the slot-list rules above) for early feedback
only. `validateSignupFormInput` (`signups.ts:221-289`) remains the source of
truth; every request still round-trips through it regardless of what the form
UI allowed to be typed. Request plumbing (CSRF header, JSON body,
`credentials: same-origin`) reuses the pattern already in
`calendar-admin-page.ts`'s inline `request()` helper; error display renders
the server's message verbatim, per the settings-panel section above.

## Documentation

`docs/signups.md:28-34` currently tells volunteers "add new items instead of
reordering or renaming existing ones once a form is open" — that line is
being fixed by this work, not just described by it, so it needs to change to
reflect what becomes true: adding, renaming, or requantifying an item in
place never affects existing claims; only removing an item deletes the claims
on it. `docs/signups.md:15-17` (the `/admin/signups/:id` UUID-only routing
note) and `:106-108` (management API surface) also need a line for the new
`/admin/signups/new` route and its extra `calendar.manage` requirement.

## Testing

**Backend** (`signup-store.test.ts`, `signups.test.ts`):

- Adding a new slot to an `items` form with existing claims leaves every
  existing claim intact.
- Editing a claimed slot's label/quantity/notes leaves its claims intact, and
  a subsequent read of those claims reflects the new label.
- Removing a slot deletes only the claims on that slot; claims on other slots
  are untouched.
- Switching form type from `items` to `rsvp` removes every slot and cascades
  every claim (the one case that's still fully destructive, by nature).
- The existing optimistic-concurrency behavior (phase-1 revision bump gating
  phase-2 slot statements) is unchanged and still covered by existing tests;
  add a case confirming a losing concurrent update's slot changes never apply.
- A stale/deleted `eventId` on create or update returns `400`, not `500`.

**Admin UI** (`signup-admin-page.test.ts`, currently two script-injection
cases):

- Settings panel renders in both create and edit mode without
  double-escaping the CSRF token or loaded form/event data through the
  existing `scriptSafeJson` choke point.
- Create-mode output omits the response table entirely.
- The slot-diff function (pure, extracted for testability) flags a slot as
  "affected" only when it is absent from the current rows (removed), never
  for an in-place edit, and only surfaces the warning when that slot's
  claimed-by count is greater than zero.
- Edit-mode rendering seeds the event select from the loaded `eventId` before
  any picker fetch resolves, and degrades (disabled + notice) if that fetch
  403s, without breaking the rest of the form.

## Out of scope

- Hard deletion of a form. `state = 'closed'` is the intended end-of-life
  action; forms and slots are retained deliberately so a volunteer can reuse
  last year's shopping list.
- CSV import or export of slots.
- Any change to the `signups.manage` / `calendar.manage` permission split
  itself. Creating a form requires both permissions (enforced server-side);
  editing degrades for a signups-only volunteer as described above rather
  than widening what `signups.manage` alone can do.

## Revision history

- 2026-08-12 (original): client-only design, assumed the existing
  `PUT /forms/:id` slot-replacement behavior was safe to guard against
  client-side.
- 2026-08-12 (this revision): an opus review found the guard couldn't work as
  designed — the backend replaces the entire slot list on any change,
  cascading claims unrelated to the edited row, contradicting
  `docs/signups.md`'s own operator-facing claim. Added the slot-upsert
  backend fix, the permission-degradation design for the event picker, and
  corrected several smaller inaccuracies (409 message handling, citation line
  numbers, missing client-side constraints, stale-`eventId` error mapping).
