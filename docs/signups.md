# Event signups

The CMS owns signup forms, their slots, family responses, the public JSON
contract, and magic-link delivery. Signup records are separate from SonicJS's
generic form tables so slot capacity, family identity, and retention pass
through the same validated controls as the calendar.

## Volunteer workflow

Visit `https://cms.macon170.com/admin/signups`. Access requires an active CMS
account with the `signups.manage` permission. Administrators receive it by
default; an administrator grants it to another volunteer by adding the user
and `perm_signups_manage` permission IDs to `user_permissions`.

`/admin/signups/:id` only accepts a `crypto.randomUUID()`-shaped id, which is
how every signup form id is generated. Anything else, including a stray path
segment, returns a plain 404 before the page template ever renders — except
the literal `/admin/signups/new`, which opens the create form instead of a
specific signup. Creating a form additionally requires the `calendar.manage`
permission, since choosing which event to attach to reuses the calendar
admin's event list; editing an existing form degrades gracefully to a
disabled, unchanged event field for a volunteer who holds `signups.manage`
alone. The signup list page hides its "New form" link from that volunteer and
explains what is missing, rather than letting them click through to a 403.

Each signup is attached to one calendar event and is one of two types:

- **`rsvp`** — attendance intent with adult and child headcounts. No items.
- **`items`** — a list of items with quantities; families claim what they bring.

Forms start as `draft` and are invisible publicly. Set `state` to `open` to
accept responses, `closed` to stop them. A `closesAt` deadline closes the form
automatically without another edit.

Editing an `items` form's slot list reconciles by each item's id: adding a new
item, or editing an existing item's label, quantity, or notes, never touches
any family's claims. **Only removing an item deletes the claims on it** — an
inherent consequence of the item no longer existing, not a side effect of
saving. Switching a form's type from `items` to `rsvp` removes every item and
so deletes every claim on the form. The "updated" audit row records
`slotsChanged: { added, updated, removed }` so an operator can tell exactly
what happened. If claims are lost to a removal, `signup_audit` still has the
"updated" record showing the removed count, and the response's own audit
trail shows what it originally claimed.

**Lowering an item's quantity below what families already claimed is allowed
and nothing warns about it.** Capacity is enforced by triggers on
`signup_claims`, which never fire on a `signup_slots` update, and the admin item
editor does not show how much of each item is already claimed. Save a
`quantityNeeded` of 2 on an item with 5 already claimed and the save succeeds
with the item oversubscribed. The families holding those claims are then locked
out of self-service edits: the public edit path rewrites all of a family's
claims in one batch, the capacity trigger aborts that batch, and the family sees
a 409 `slot_full` ("Someone just claimed that item. Pick another.") on their next edit —
even for an unrelated change like a dietary note. Either raise the quantity back
to at least the claimed total, or have the affected families drop that item.

Saving a form is optimistic-concurrency guarded by `expectedRevision`, the
same as the calendar: the admin page reports a conflict rather than silently
overwriting a change saved since the page loaded. Internally the save is
two-phase — a revision bump lands alone first, and the per-item slot
reconciliation (inserts, in-place updates, and deletes for removed items) plus
the audit row only run if that bump actually matched a row. The accepted
trade-off: if the second phase fails after the first commits, the form is
left on the new revision with the old slot list, which surfaces to the
volunteer as a failed save to retry, not as another volunteer's edit getting
silently destroyed.

## Publishing the link to families

The public signup page is `https://www.macon170.com/signups/?form=<slug>`, where
`<slug>` is the form's slug.

**There is no automatic link from the event page.** The public API has no
event-to-form lookup, so the event page cannot discover its own signup form.
Paste the signup URL into the calendar event's **Registration URL** field —
`/events/?event=<event-slug>` already renders that field as a link, so families
reach the signup from the calendar with no further work.

The magic-link edit page is `https://www.macon170.com/signups/edit/?token=…`.
The CMS emails it. **Never build one of those URLs by hand and never paste one
into a chat, an email, or a document:** the token in it lets whoever holds it
read and change that family's response, including a child's dietary notes. If a
family loses its link, have them submit the form again with the same email
address — that rotates the token and re-sends the link.

## Public API

All JSON is camelCase and includes `version: "v1"`.

- `GET /api/signups/v1/forms/:slug` — form, deadline, closed flag, and per-slot
  `quantityNeeded`, `quantityClaimed`, `quantityRemaining`. Draft forms 404;
  closed forms stay readable. Never returns names, emails, dietary notes, or
  headcounts.
- `POST /api/signups/v1/forms/:slug/responses` — family submits; the response
  is created `unconfirmed` and a magic link is emailed.
- `GET /api/signups/v1/responses/:token` — loads the response.
- `PATCH /api/signups/v1/responses/:token` — updates headcount, dietary note,
  or claims.
- `DELETE /api/signups/v1/responses/:token` — withdraws.

A response is confirmed on the first valid use of its token by **any** of the
three token-route methods above, not just `GET`. This is deliberate:
clicking the emailed link at all proves the family controls that mailbox, and
confirming on `PATCH` specifically is what stops the 24-hour unconfirmed purge
from deleting a response a family is actively editing rather than merely
viewing.

The token route is a bearer-gated self-service surface, and it is the one
deliberate carve-out from the rule that public signup responses never expose
family names, emails, dietary notes, or headcounts: `GET`/`PATCH` on
`/responses/:token` return exactly that data, because the whole point of the
route is letting a family that holds the token see and edit their own
response. The rule against exposing that data governs the unauthenticated
form projection above (`GET /forms/:slug`); it does not apply to the
token-authenticated response itself.

Submitting again with an email that already responded is **not** an error: it
rotates that response's token and emails a fresh link. This is the "I lost my
link" recovery path and it keeps the endpoint from revealing whether an
address already signed up.

The management API lives under `/api/signups-admin/v1`. It is same-origin,
requires authentication and `signups.manage`, requires the signed CSRF
cookie/header pair for mutations, and uses `expectedRevision` for form
updates:

- `GET /api/signups-admin/v1/session`
- `GET /api/signups-admin/v1/forms`
- `POST /api/signups-admin/v1/forms`
- `GET|PUT /api/signups-admin/v1/forms/:id`
- `DELETE /api/signups-admin/v1/responses/:id`
- `POST /api/signups-admin/v1/responses/:id/resend`

## Stored data

`signup_responses` holds the registering adult's email, name (in the legacy
`family_name` column), private phone number, attendance flag, adult and child
counts, an optional dietary note, confirmation status, the SHA-256 of
the magic-link token, and a hash of the submitting IP. The raw token is never
stored — it exists only in the email. Dietary notes, names, and emails are
returned by the admin API and by the family's own token route, and by nothing
else.

## Security controls

- Request bodies are bounded at 8 KB, including bodies with no
  `Content-Length`.
- Writes require the configured `PUBLIC_SITE_ORIGIN`, with explicit preflight
  behavior. Reads are allowed cross-origin.
- A filled honeypot returns success and stores nothing.
- `SIGNUP_RATE_LIMITER` is checked twice per submission: once on a hash of the
  connecting IP, and once on a hash of email plus connecting IP. Both buckets
  must have budget. The IP-only bucket is what caps volume from one source,
  since the email arrives in the request body and could otherwise be varied to
  reset the budget.
- Turnstile is verified server-side against the CMS secret, expected
  hostnames, and expected action, and fails closed: a siteverify response
  missing either the action or the hostname is treated as a failure, not
  skipped.
- Unknown, malformed, and deleted tokens all return the same generic 404.
- Slot capacity is enforced entirely in the schema, not in application code:
  the `signup_claims_capacity_insert` and `signup_claims_capacity_update`
  triggers abort the enclosing D1 batch with `signup slot is full` on any
  insert or update that would oversubscribe a slot. Because the invariant
  lives in the trigger, every write path — public submission, public edit,
  and any future path — is covered without having to reimplement the check.
  The API translates the abort into a 409 with refreshed availability.

## Retention

The daily CMS cron runs three passes:

1. `unconfirmed` responses older than 24 hours are deleted; their claims
   cascade and the slot becomes available again.
2. Responses for forms whose event ended more than 90 days ago are deleted.
   Forms and slots are kept deliberately, so a volunteer can reuse last
   year's shopping list; only the response and claim rows for those old
   events are removed.
3. `signup_audit` rows older than 365 days are deleted.

Each pass logs its deleted-row count, including zero.

Contact retention and signup retention run as separate passes in the same cron
invocation, each wrapped so a failure in one is logged under its own event
(`contact_retention_failed`, `signup_retention_failed`) and does not stop the
other from running. The invocation still fails after both have run, so a real
error is still visible in Worker observability. If the Worker is deployed
before `0004_signups.sql` is applied, expect `signup_retention_failed` on the
nightly run until the migration lands.

## Email delivery and staged phone rollout

Signup confirmation and resend messages use Mailgun's HTTP API with text and
HTML bodies. `MAILGUN_API_KEY` is a domain-restricted Worker secret; the sending
domain and sender are non-secret Worker variables. Each message explicitly
disables open and click tracking and preserves the configured Reply-To address.
SonicJS volunteer invitations continue to use the Cloudflare `EMAIL` binding.

Deploy the nullable phone migration and compatibility code first. After the
frontend phone field is live, set the preserved `SIGNUP_REQUIRE_PHONE` Worker
secret to `true`; absent or any other value keeps compatibility mode enabled.

## Local setup and validation

```bash
bun install --frozen-lockfile
bun run db:migrate:local
bun run type-check
bun run test
```

`bun run test` includes `scripts/test-signup-migrations.mjs`, which applies
core and custom migrations to a temporary local D1 database, reapplies the
custom migrations as a no-op, and asserts the tables, capacity triggers,
permission rows, over-subscription abort, and claim cascade.

## Cutover

1. Confirm `SIGNUP_RATE_LIMITER` is present in `wrangler.jsonc` and provision
   the domain-restricted `MAILGUN_API_KEY` Worker secret.
2. Deploy the CMS and apply its migrations in an approved window.
3. Verify `/admin/signups` renders for an administrator and returns 403 for a
   user without `signups.manage`.
4. Create one `items` form against a test event, submit a response from the
   public API, confirm the email arrives, follow the link, and change the
   claim.
5. Deploy the public-site frontend once its own plan is complete.

Do not deploy or apply remote migrations until separately approved.

## Troubleshooting

- `409` with code `slot_full`: expected when a slot filled between page load
  and submit. The response body carries the refreshed form; re-render it.
- `502` on submit: the response saved but email delivery failed. The family
  submits again to resend; check the Mailgun secret, domain, and sender address.
- `security` on a valid-looking request: confirm the request `Origin`
  matches `PUBLIC_SITE_ORIGIN` and that the Turnstile hostname and action
  match the committed settings.
- Admin queue redirects to login: expected without a CMS session.
- Admin queue returns 403 after login: verify the user is active and holds
  `signups.manage`.
- Mutation returns `invalid_csrf`: reload the page for a fresh signed
  cookie/token pair.
- A volunteer reports claims disappeared: an item was removed from the form (or
  the form's type was switched from `items` to `rsvp`, which removes every
  item) — either cascades the claims on the removed item(s). Editing an item's
  label, quantity, or notes in place never does this. Recover the claimed items
  from `signup_audit`.

- A family gets 409 `slot_full` editing a response they already saved, with no
  new claim: the item's `quantityNeeded` was lowered below what is already
  claimed. Raise the quantity back, or have the family drop that item. See the
  oversubscription note under [Volunteer workflow](#volunteer-workflow).
- Resend or a repeat public submission returns 404: the response was deleted
  between the lookup and the token rotation, so no link was emailed. That is
  the intended outcome; a link whose hash was never stored could never work.
  The family can submit the public form again to create a fresh response.
