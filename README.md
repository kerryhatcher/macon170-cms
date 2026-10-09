# Pack 170 CMS

The isolated content-management backend for Pack 170. It runs as the `macon170-cms` Cloudflare Worker at `https://cms.macon170.com` and owns its own D1 database (`macon170-cms`) and R2 media bucket (`macon170-cms-media`). It has no binding to, and makes no changes to, the public site's Worker or database.

Its SonicJS collection is the **Volunteer leadership roster**. Calendar events
use a dedicated, permissioned CMS workflow documented in
[docs/calendar.md](docs/calendar.md). Each roster record is a role; names may
be blank for vacant roles. Publish only records approved for display.
Parent inquiries use SonicJS’s existing `contact` form and native
`form_submissions` model through the hardened workflow in
[docs/contact.md](docs/contact.md). Event signups — attendance intent and
item claims attached to a calendar event — use the workflow documented in
[docs/signups.md](docs/signups.md).

## Getting Started

### Prerequisites

- Node.js 22.13 or higher (the integration tests use built-in SQLite)
- A Cloudflare account (free tier works great)
- Wrangler CLI (installed with dependencies)

### Installation

1. **Install dependencies:**

   ```bash
   bun install --frozen-lockfile
   ```

2. **Create the CMS D1 database:**

   ```bash
   npx wrangler d1 create macon170-cms
   ```

   Copy the returned `database_id` into `wrangler.jsonc`.

3. **Create your R2 bucket:**

   ```bash
   npx wrangler r2 bucket create macon170-cms-media
   ```

4. **Configure local-only environment variables:**

   ```bash
   cp .dev.vars.example .dev.vars
   ```

   Replace `JWT_SECRET` in the ignored `.dev.vars` file with a unique local
   secret. The example uses Cloudflare’s always-pass Turnstile test secret,
   never the production value. The default CORS origins permit the Astro dev
   server on this computer and the LAN hostname:

   ```dotenv
   CORS_ORIGINS=http://localhost:41771,http://kudzu:41771
   ```

   The committed Worker configuration permits only `https://www.macon170.com` in production.

5. **Start the development server:**

   ```bash
   just run
   ```

   This applies all pending local D1 migrations before starting Wrangler, so it
   is safe to use as the normal development entry point. In a second terminal,
   add the current roster to the local D1 database:

   ```bash
   bun run db:seed:local
   ```

6. **Open your browser:**
   Navigate to `http://kudzu:41772/admin` for SonicJS administration or
   `http://kudzu:41772/admin/calendar` for calendar management.

## Project Structure

```
cms/
├── src/
│   ├── collections/          # Your content type definitions
│   │   └── leadership-roster.collection.ts
│   └── index.ts             # Application entry point
├── wrangler.jsonc           # Cloudflare Worker configuration
├── package.json
└── tsconfig.json
```

## Available Scripts

- `just run` - Apply pending local migrations and start the development server
- `bun run dev` - Start the development server without applying migrations
- `bun run deploy` - Deploy to Cloudflare
- `bun run db:migrate` - Run migrations on production database
- `bun run db:migrate:local` - Run migrations locally
- `bun run test:smoke` - Check deployed calendar and contact contracts, CORS, rejection, and login protection
- `bun run type-check` - Check TypeScript types
- `bun run test` - Run unit/security tests and the idempotent local migration contract

## Admin access

SonicJS owns its user accounts in the CMS D1 database. The public registration and SonicJS development seed routes are disabled. Provision the initial administrator with a one-time, secret-backed operational procedure before inviting editors; never add a password or password hash to source control.

## Content API

The roster collection is served by SonicJS at `/api/content/leadership-roster`. Frontend integration is intentionally out of scope for this backend-only phase.

The CMS serves the published calendar at `/api/calendar/v1/events`,
`/api/calendar/v1/events/:slug`, and `/api/calendar/v1/calendar.ics`. These are
read-only public endpoints; all calendar writes require SonicJS authentication,
CSRF protection, and `calendar.manage`.

`GET /api/version` exposes the deployed commit in a no-cache JSON response.
Continuous delivery injects the merge commit SHA, waits until that exact
version reaches the custom domain, and then runs the calendar/contact smoke suite with
bounded exponential-backoff retries. Local development reports `development`.

The public Pack-branded form posts to `/api/forms/contact/submit`;
`/api/forms/contact/schema` remains public. Only active CMS administrators may
open `/admin/contact-form` or use the versioned
`/api/contact-admin/v1/submissions` queue API. The standalone SonicJS renderer
redirects to `https://www.macon170.com/contact/`.

## Deployment

1. **Login to Cloudflare:**

   ```bash
   npx wrangler login
   ```

2. **Deploy the CMS Worker:**

   ```bash
   bun run deploy
   ```

3. **Run the CMS migrations on production:**
   ```bash
   bun run db:migrate
   ```

Both migration commands apply SonicJS's packaged migrations followed by every
unapplied Pack-specific migration in `migrations/custom/`. Add future custom
schema changes there as new, sequentially numbered SQL files; do not edit a
migration after it has been applied.

## Continuous delivery

GitHub Actions validates pull requests and deploys only pushes to `main`. Configure these `production` environment secrets before the first automated deployment:

- `CLOUDFLARE_API_TOKEN` — deployment token for the Pack 170 Cloudflare account
- `CLOUDFLARE_ACCOUNT_ID` — Pack 170 Cloudflare account ID

The production `JWT_SECRET`, `TURNSTILE_SECRET`, and `POSTMARK_SERVER_TOKEN`
stay in the Worker as Cloudflare secrets; ordinary deployments
preserve them and do not copy their values into GitHub. Postmark sends event
signup confirmations and volunteer invitations, including resend messages.

## Volunteer invitations

The CMS uses SonicJS's built-in user invitation and account-acceptance flow.
An administrator opens `/admin/users/invite`, selects the least-privileged
role, and sends a seven-day account-setup link. The recipient creates their
own password; public registration remains disabled.

Delivery uses the same verified Postmark domain and Macon170.com Server API Token
(`POSTMARK_SERVER_TOKEN` Worker secret) as signup confirmations.
The Postmark account must be approved for live sending, and `INVITE_FROM_EMAIL`
must be configured; `INVITE_FROM_NAME` and
`INVITE_REPLY_TO` control the sender name and replies. Messages explicitly enable
open tracking with `TrackOpens: true` by the owner's choice, while link tracking
remains disabled for account-setup links (`TrackLinks: "None"`). The same tracking
policy applies to signup confirmations and resend messages. Open tracking does
not depend on the server-level default being enabled. To disable it for future
messages, change the app's flag to `false` and turn off Open tracking in the
Postmark server's Settings → Tracking; the server setting overrides a `false`
per-message flag when enabled. Neither change alters previously sent messages. See
[Postmark's per-email tracking documentation](https://postmarkapp.com/developer/user-guide/tracking-opens/tracking-opens-per-email).
Do not configure the SonicJS Resend plugin or place
a provider API key in the CMS database. Messages explicitly use the transactional
`outbound` stream. `POSTMARK_API_TEST` only validates requests without sending;
the CMS rejects that token in production before creating an invitation.

If delivery fails after account creation, the account remains inactive.
Resolve the Postmark configuration or provider error, then open `/admin/users/invite`
and use **Resend invitation** beside the existing volunteer under **Pending invitations**.
This preserves the stored recipient and role; it does not create another account
or activate the volunteer. The page shows up to 100 pending invitations and never
includes setup tokens. Refresh the list after creating an invitation.
The control uses the authenticated admin endpoint `POST /admin/resend-invitation/:id`, with
the same Origin and CSRF protection as invitation creation. Do not create
another account. Resend replaces the previous invitation token. Worker logs record
`invite_delivery_failed` and the provider HTTP status, without email contents
or tokens. A null status means a network failure or an unconfirmed/malformed
provider response. Success requires an HTTP success response with `ErrorCode: 0`
and a nonempty `MessageID`. Check Postmark Activity to verify delivery; acceptance
does not prove inbox placement. Sends are not automatically retried, because an
ambiguous response could otherwise send duplicate setup links. A 15-second
deadline covers both the provider request and its response body. Check Activity
before manually retrying an ambiguous failure.

SonicJS 2.19.0 omits the required `users.username` column when creating an
invitation. The Bun patch in `patches/` supplies a unique temporary username;
the acceptance flow replaces it with the recipient's chosen username. Keep
installing with `bun install --frozen-lockfile` so this patch is applied.
`src/invitation.integration.test.ts` exercises the installed SonicJS routes
against its SQLite schema, including invitation creation and acceptance.
Remove the patch only after an upstream release passes these tests unpatched.

The deployment smoke runner checks the calendar plus contact schema version,
CORS/preflight, missing-token rejection, and queue login redirect. It accepts `EXPECTED_VERSION`,
`VERSION_MAX_ATTEMPTS`, and `SMOKE_MAX_ATTEMPTS`. CI sets the expected version
to the workflow commit; local smoke runs omit it and test the currently served
deployment directly.

## Documentation

- [SonicJS Documentation](https://sonicjs.com)
- [Collection Configuration](https://sonicjs.com/collections)
- [Plugin Development](https://sonicjs.com/plugins)
- [API Reference](https://sonicjs.com/api)

## Support

- [GitHub Issues](https://github.com/lane711/sonicjs/issues)
- [Discord Community](https://discord.gg/8bMy6bv3sZ)
- [Documentation](https://sonicjs.com)

## License

MIT

## Email broadcasts

Use `/admin/broadcasts` to manage named mailing lists and contacts, publish list
signup links, draft messages, and review delivery/open/bounce statistics.
Volunteers require `broadcasts.manage`. Public signup uses email confirmation;
every broadcast includes subscription controls. See [broadcast setup and
operations](docs/broadcasts.md) for the required Postmark stream, webhook,
Google sender requirements, and delivery/suppression behavior.
