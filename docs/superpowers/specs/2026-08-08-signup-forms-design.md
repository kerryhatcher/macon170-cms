# Event signup forms — design

Date: 2026-08-08
Status: approved for planning
Repos: `macon170-cms` (backend, primary), `macon170.com` (family-facing pages)

## Problem

Volunteers need two kinds of signup attached to a calendar event:

1. **Attendance intent** — "are you coming to the Lego Derby?" so the pack can
   plan food purchases.
2. **Bring an item** — "we need 3 packs of buns, 2 cases of drinks" so families
   can claim what they will bring.

Families have no CMS accounts, but must be able to change their answer later.

## Decisions

| Decision | Choice |
| --- | --- |
| Identity | Emailed magic link. No family accounts, no roster. |
| Form building | Two fixed shapes. No arbitrary field builder. |
| Dietary restrictions | Standard optional field, volunteer-visible only. |
| Audience | Both types are publicly submittable. No private/allowlist mode. |
| Public visibility | Slot counts only. No names, no dietary notes, no headcount total. |
| Confirmation | Every response emails a confirmation link. |
| Unconfirmed responses | Hold the slot, count publicly, badged in admin, purged after 24 hours. |
| Family-facing UI | Astro at `www.macon170.com`. CMS stays a backend. |
| Storage | Bespoke D1 tables, following the calendar pattern. |
| Durable Objects / KV | Not used. See "Rejected alternatives". |

An RSVP form is an item form with zero items. Both share one identity flow, one
confirmation email, one edit page, and one purge job.

## Data model

New migration `migrations/custom/0004_signups.sql`, following calendar
conventions: TEXT ids, `unixepoch() * 1000` timestamps, CHECK constraints,
`IF NOT EXISTS`.

### `signup_forms`

One row per signup on an event.

- `id`, `revision`, `slug` (unique, public URL segment)
- `event_id` → `calendar_events(id)`
- `form_type` CHECK in (`rsvp`, `items`)
- `title`, `instructions`
- `state` CHECK in (`draft`, `open`, `closed`)
- `closes_at` (nullable ISO string)
- `created_at`, `updated_at`

A form is closed if `state = 'closed'` **or** `closes_at` has passed, so a
volunteer can set a deadline and forget about it.

### `signup_slots`

The items to bring. No rows for `rsvp` forms.

- `id`, `form_id` → `signup_forms(id)` ON DELETE CASCADE
- `position`, `label`, `quantity_needed` CHECK >= 1
- `notes` (nullable, e.g. "gluten-free if possible")
- `created_at`, `updated_at`

### `signup_responses`

One row per email address per form. This is the unit a magic link owns.

- `id`, `form_id` → `signup_forms(id)` ON DELETE CASCADE
- `email`, `family_name`
- `attending` (0/1). Meaningful for `rsvp`, where a family may record regrets.
  For `items` forms it defaults to 1 and is neither collected nor displayed.
- `adults`, `children` (non-negative integers)
- `dietary_notes` (nullable; never leaves the volunteer view)
- `status` CHECK in (`unconfirmed`, `confirmed`), `confirmed_at`
- `token_hash` — SHA-256 of the magic-link token; the raw token exists only in
  the email
- `ip_hash`
- `created_at`, `updated_at`
- `UNIQUE(form_id, email)`

### `signup_claims`

- `id`, `response_id` → `signup_responses(id)` ON DELETE CASCADE
- `slot_id` → `signup_slots(id)`
- `quantity` CHECK >= 1
- `created_at`
- `UNIQUE(response_id, slot_id)`

### `signup_audit`

- `id`, `entity_type`, `entity_id`, `action`
- `actor_id` → `users(id)`, nullable (families act without accounts)
- `detail` JSON, `created_at`

### Deliberate omissions

- **No immutable history table** (unlike `calendar_event_history`). A form's
  item list is low-stakes and short-lived; `revision` alone provides optimistic
  concurrency.
- **`UNIQUE(form_id, email)`** means one family, one response. A family bringing
  buns *and* drinks has one response with two claims and a single edit link.

## Public API

Versioned, camelCase, CORS-restricted to `PUBLIC_SITE_ORIGIN`, matching the
calendar contract.

- `GET /api/signups/v1/forms/:slug` — form, instructions, deadline, state, and
  each slot with `quantityNeeded`, `quantityClaimed`, `quantityRemaining`. An
  `rsvp` form returns an empty slot list. Only `draft` forms 404; `closed` and
  past-deadline forms remain readable so the page can render a closed notice.
  Cached with deterministic ETags via the Cache API, honoring `If-None-Match`.
- `POST /api/signups/v1/forms/:slug/responses` — family submits. Honeypot,
  Turnstile, and rate limiting apply. Creates the response as `unconfirmed` and
  emails the magic link.
- `GET /api/signups/v1/responses/:token` — loads the response for the edit page.
  **Confirmation happens on the first valid use of a token by any method:** an
  `unconfirmed` response flips to `confirmed` and stamps `confirmed_at`, exactly
  once. Clicking the emailed link is a `GET`, so that is the usual path.
- `PATCH /api/signups/v1/responses/:token` — change headcount, dietary note, or
  claims.
- `DELETE /api/signups/v1/responses/:token` — withdraw.

The token is 32 random bytes, base64url. Only its SHA-256 is stored, reusing the
digest helpers in `calendar.ts` and `contact.ts`. It does not expire; it is the
family's handle on their own response for as long as the form exists. The Astro
edit page sets `Referrer-Policy: no-referrer`.

### Duplicate submit is the recovery path

Submitting again with an email that already responded does **not** error. It
re-sends that response's existing edit link and returns the same neutral "check
your email" message as a first-time submit. This serves two purposes: it is the
"I lost my link" recovery path, and it prevents the endpoint from revealing
whether an address has already signed up.

### Infrastructure reuse

- Turnstile: existing `TURNSTILE_SECRET`, expected hostnames, and action. No new
  secrets.
- Rate limiting: a **new** `SIGNUP_RATE_LIMITER` binding, not shared with
  `CONTACT_RATE_LIMITER`, so a signup rush cannot lock out the contact form.
- Email: existing `EMAIL` binding and the `EmailMessageBuilder` shape in
  `request-handler.ts`. One template serves both the initial link and re-sends.

## Volunteer admin surface

### Permission

New `signups.manage`, seeded like `perm_calendar_manage` in the same migration:
inserted into `permissions`, granted to role `admin` by default, grantable per
user through `user_permissions`. Separate from `calendar.manage` because the
volunteer coordinating hot dogs is not necessarily trusted to publish and
archive the pack calendar.

### Pages

Server-rendered, following `calendar-admin-page.ts`.

- **`/admin/signups`** — every form grouped by event, with state, deadline, and
  response count.
- **`/admin/signups/:id`** — form settings (title, instructions, type, deadline,
  open/closed), the slot list with quantities for `items` forms, and the
  response table.

The response table carries family name, email, attending yes/no, adults,
children, dietary notes, claimed items, a status badge distinguishing
**Unconfirmed** from **Confirmed**, and signup time. Above it, the shopping
numbers: total adults, total children, total attending families, and per-slot
claimed-versus-needed. Dietary notes appear only here.

Volunteer actions on a response: delete it, and re-send the magic link. Each
writes a `signup_audit` row with the acting user.

### Management API

`/api/signups-admin/v1`, same-origin only, requiring authentication plus
`signups.manage`, the signed CSRF cookie/header pair for all mutations, and
`expectedRevision` on form updates so concurrent volunteer edits produce a
conflict rather than a silent overwrite. Identical to the calendar admin
contract.

### Skipped

Volunteers cannot create or edit a response on a family's behalf. No CSV export.
Add either when a volunteer asks.

## Concurrency and error handling

### The claim race

Two families claiming the last slot is the one real correctness problem. Instead
of read-then-write, the claim insert is a **single conditional statement**: it
inserts only where the slot's existing claimed total plus the requested quantity
remains within `quantity_needed`. Zero rows written means someone won the race,
and the API returns `409` with refreshed slot availability so the page can
re-render. Atomic by definition, no transaction, no locking, no retry loop.

### Controls

- Request bodies bounded at 8 KB, including bodies with no `Content-Length`.
- A filled honeypot returns success and stores nothing.
- Turnstile failures return the generic `security` error.
- Rate-limit rejections return `temporary`, keyed on a hash of email plus
  connecting IP.
- Submissions to a `draft`, `closed`, or past-deadline form are rejected
  server-side at write time, never trusted from page state.
- Unknown, malformed, and already-deleted tokens all return an identical generic
  `404`. Nothing about token handling is an oracle.
- Field validation shared between the HTML form post and the JSON path: email
  shape, name and note lengths, non-negative headcounts, quantity bounds.

### Email delivery failure

If the response saves but the email does not send, the row stays and the API
returns `502`, telling the family the signup was saved but the link could not be
emailed, and to submit again to have it re-sent. Safe because duplicate submit
re-sends the existing link, so the flow heals itself and no signup is lost to a
transient email outage.

## Retention and cron

Three passes added to the existing `17 3 * * *` daily cron. All idempotent and
safe on a no-op run.

1. **Unconfirmed purge** — delete `unconfirmed` responses older than 24 hours.
   Claims cascade, releasing the held slot; the public count drops on the next
   read. This is what makes "unconfirmed holds the slot" safe.
2. **Response retention** — for forms whose event ended more than 90 days ago,
   delete responses and claims but **keep the form and its slots**. Names,
   emails, and dietary notes have no value three months on; the shopping list is
   exactly what a volunteer wants when setting up the same event next year.
3. **Audit retention** — `signup_audit` rows older than 365 days, matching the
   contact audit window.

Each pass logs its deleted-row count, including zero, so a broken cron is
visible in Workers logs.

No counter-repair step is needed. Every count — claimed, remaining, headcount
totals — is computed from rows at read time, so there is no denormalized value
that can drift.

## Testing

Three layers already present in the repo: `vitest` unit tests beside the source,
the migration contract script (pattern of `scripts/test-contact-migrations.mjs`),
a smoke script, plus Playwright e2e on the frontend.

Tests that matter:

- **The race** — two concurrent claims for the last slot: exactly one succeeds,
  the other gets `409` with refreshed availability.
- **Privacy** — the public form response contains no email, no family name, no
  dietary note, and no headcount total, for a form holding responses of every
  status. This is the regression guard against a future serializer change.
- **Token handling** — the raw token never appears in D1; unknown and deleted
  tokens return identical generic `404`s; a valid token confirms an
  `unconfirmed` response exactly once.
- **Duplicate submit** — same email twice creates one row, re-sends the existing
  link, returns the same neutral message as a first submit.
- **Closed forms** — draft, closed, and past-deadline forms reject well-formed
  writes.
- **Abuse controls** — honeypot returns success and stores nothing; Turnstile
  failure returns `security`; oversized and `Content-Length`-less bodies are
  rejected.
- **Authorization** — admin API returns 403 without `signups.manage`; mutations
  fail with `invalid_csrf` absent the cookie/header pair.
- **Cron** — a 25-hour-old unconfirmed response is purged and its slot returns
  to available; a 91-day-old event's responses are deleted while its form and
  slots survive.
- **Migration contract** — core plus custom migrations apply to a temp local D1,
  custom migrations reapply as a no-op, and the new tables, permission rows, and
  CHECK constraints are verified.

## Rollout

Coordinated sequence per the workspace `AGENTS.md`. CMS first, because the
frontend build reads from a live CMS.

1. CMS: migration `0004_signups.sql` and code. Run `type-check`, `test`,
   `deploy:dry`.
2. Add the `SIGNUP_RATE_LIMITER` binding to `wrangler.jsonc`. No new secrets.
3. Deploy the CMS and apply remote migrations in an approved window. Run smoke
   against production.
4. Frontend: Astro signup and edit pages, Playwright e2e green, then deploy.
5. Bump both submodule pointers in the meta repo in one commit.

Migrations are forward-only. Rollback is a frontend revert to the retained
backend, never a schema reversal.

## Rejected alternatives

- **Generic form builder.** Volunteers defining arbitrary fields is a product in
  itself, larger than the rest of the feature. The two fixed shapes cover both
  stated use cases.
- **Two independent feature stacks** (separate `rsvp_*` and `item_signup_*`
  tables). Would duplicate magic-link issuance, confirmation, the purge job, and
  the admin table, then require fixing every bug twice. The second use case is a
  variation on the first.
- **SonicJS native forms and `form_submissions`** (the contact-form approach).
  Slots, quantities-needed, and remaining-count arithmetic have no home in the
  generic model, forcing structured claim data into `submission_data` JSON and
  availability into a submission scan. That fights the framework precisely where
  correctness matters.
- **Family CMS accounts.** Real access control, but it means running invites,
  password resets, and support for every pack family.
- **Bookmark-only edit links with no email.** Cheapest, but losing the link is
  unrecoverable without an admin.
- **Workers KV.** The only tempting use is caching the public form GET, but KV is
  eventually consistent, and a stale "1 remaining" that is actually 0 is the
  exact bug item signups exist to prevent. The Cache API with ETags revalidates
  on change and is already the calendar's pattern.
- **A Durable Object per slot.** Its value is serializing writes to one hot key,
  but the conditional insert already closes the race. It would add a second
  source of truth to reconcile with D1, a new failure mode, and per-request
  latency, and would be the only DO in the codebase. Pack scale is roughly 40
  families and a few writes per minute. A DO would earn its place only for a
  future real-time feature (live slot updates over WebSocket), which can be added
  later without changing this data model.
