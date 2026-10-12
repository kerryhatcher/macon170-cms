# Event payment link

## Goal

Let a volunteer attach a Stripe payment link to a calendar event so families can
pay from the pack site. First use: the Fall Campout
(`https://buy.stripe.com/9B68wOdMpef0c9rfKpdjO00`).

Families should find the link in two places: on the event page, and in the
signup flow (success notice and confirmation email) when the event has a signup
form.

## Out of scope

- Changing how signup forms are linked to events. `registrationUrl` stays a
  free-text field that volunteers paste a signup URL into. Reworking that into a
  form selection is a separate story.
- Tracking who has paid. The Stripe dashboard is the record.
- Per-family amounts, quantities, or restricting the link to Stripe domains.

## Design

A new nullable `payment_url` column on `calendar_events`, parallel to
`registration_url` but kept separate because `registrationUrl` already holds the
signup link.

### CMS (`macon170-cms`, lands and deploys first)

- **Migration** `migrations/custom/0011_calendar_payment_url.sql`:
  `ALTER TABLE calendar_events ADD COLUMN payment_url TEXT;`. Nullable, no
  backfill. Must be applied to remote D1 before the code that reads it deploys.
- **Contract** (`src/calendar.ts`): add `paymentUrl: string | null` to the input
  and event types, the row mapping, the insert and update SQL, and the history
  snapshot. Validation follows `registrationUrl` (max 2000 chars) but requires
  the `https:` scheme, not just http(s).
- **Admin editor** (`src/calendar-admin-page.ts`): add a "Payment URL"
  `type="url"` input beside "Registration URL" and carry it in the save payload.
- **MCP tools** (`src/mcp/tools.ts`): accept `paymentUrl` wherever
  `registrationUrl` is accepted, so the ChatGPT/MCP plugin can set it. Update
  `plugins/macon170/skills/manage-pack/SKILL.md` if it lists event fields.
- **Public signup projection** (`src/signup-store.ts`, `getPublicSignupForm`):
  select `calendar_events.payment_url` and return it as `event.paymentUrl`
  (`string | null`) alongside the existing `slug`, `title`, `startsAt`. Update
  the `PublicSignupForm` type in `src/signups.ts`.
- **Email** (`src/signup-email.ts`): add optional `paymentUrl` and `eventTitle`
  to `SignupEmailOptions`. When `paymentUrl` is set, the text body gets a line
  with the link and the HTML body gets a "Pay for {event}" button. Output is
  unchanged when it is null. The three call sites that build these options
  (`src/signup-public.ts:386`, `src/signup-admin.ts:209`,
  `src/signup-store.ts:586`) read the event's `payment_url` and event title.
  The HTML escapes both values like the existing fields.
- **Docs**: `docs/calendar.md` documents the field. `docs/signups.md` notes the
  payment line in the confirmation email.

### Frontend (`macon170.com`, after the CMS deploy)

- `src/lib/calendar-client.ts`: parse `paymentUrl` with the existing
  `nullableWebUrl` helper. Update the event type in `src/data/pack.ts`.
- `src/pages/events/index.astro`: render a separate "Pay now" button next to the
  registration action when `paymentUrl` is present. A link that fails
  `webUrl()` gets the same "could not be opened" treatment as registration. The
  "Still being confirmed" list is not changed; payment is optional, so a missing
  link is not "pending".
- `src/lib/signup-client.ts` and `src/pages/signups/index.astro`: parse
  `event.paymentUrl` from the form projection. The success notice shows a "Pay
  now" link when set.
- Tests: `calendar-client.test.ts` and `signup-client.test.ts` cover present,
  null, and invalid values (including a non-https URL). Update the events and
  signup e2e specs for the new button and notice.

## Testing

CMS: unit tests for validation (https required, null allowed, over-length
rejected); integration tests that create and update an event with `paymentUrl`
and read it back through the public calendar API and the history snapshot; email
render tests with and without a payment link (text, HTML, escaping);
`scripts/test-signup-migrations.mjs` confirms `0011` applies cleanly and
re-applies as a no-op. Frontend: the parser and e2e tests above.

## Rollout

1. Work in `worktrees/` branches in each submodule, never the primary checkouts.
2. Merge and deploy the CMS, applying migration `0011` to remote D1 in an
   approved window.
3. Merge the frontend change.
4. Bump both submodule pointers in the meta repo in one commit.
5. A volunteer opens the Fall Campout in the admin editor, pastes the Stripe
   link into "Payment URL", and saves.

The frontend parser expects `paymentUrl` in the CMS responses, so the CMS must
be deployed before the frontend builds.

## Decisions made in the spec

The payment line in the confirmation email sits below the confirm-your-signup
button, so it does not bury the confirmation link.
