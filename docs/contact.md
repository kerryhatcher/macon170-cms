# Parent contact form runbook

## Architecture

The CMS updates SonicJS’s existing `default-contact-form` record in place. It
does not create a second form. The public Astro page remains Pack-branded and
posts directly to:

- `POST /api/forms/contact/submit`
- `GET /api/forms/contact/schema`

The native administrator URL is replaced by the Pack queue:

- `/admin/forms/default-contact-form/submissions`
- `GET /api/contact-admin/v1/submissions`
- `GET /api/contact-admin/v1/submissions/{id}`
- `PATCH /api/contact-admin/v1/submissions/{id}`

`/forms/contact` redirects to `https://www.macon170.com/contact/`.

## Stored data

The native `form_submissions` row stores only the validated parent name, email,
optional parent phone, optional child grade, topic, and message in
`submission_data`. Restricted source metadata stays in dedicated native/custom
columns: IP address, browser user-agent, referrer, source path, country code,
and timestamps.

Each accepted submission is linked to a draft record in the form-backed
`form_contact` content collection. Draft status prevents the generic public
content API from exposing parent data. The honeypot and Turnstile response
token are never stored.

## Security controls

- Request bodies are bounded at 24 KB, including bodies without a
  `Content-Length` header.
- HTML form and JSON requests share field-length, email, grade, and topic
  validation.
- Only the configured `PUBLIC_SITE_ORIGIN` is accepted, with explicit CORS
  preflight behavior.
- A filled honeypot is silently discarded.
- The Worker rate-limit binding keys on a hash of email plus connecting IP.
- Turnstile is verified server-side with the CMS Worker secret and expected
  hostname and `turnstile-spin-v2` action.
- The SonicJS Turnstile plugin remains disabled and its management routes are
  blocked, so no secret is stored in D1.
- Only active SonicJS users with role `admin` may use the queue.
- Status mutations require same-origin CSRF cookie/header validation.
- Each detail view and status transition creates an audit record.

Queue labels map to SonicJS statuses:

| Queue label | SonicJS status |
| --- | --- |
| New | `pending` |
| In progress | `reviewed` |
| Resolved | `approved` |
| Spam | `spam` |

## Retention

The daily CMS cron deletes contact submissions older than 365 days, their
linked content records, and their audit records. It repairs
`forms.submission_count` after every run, including a no-op run.

The legacy public-site `macon170-submissions` database is out of scope. Do not
migrate or delete its two test rows, reconnect its binding, or dual-write.

## Local setup and validation

Copy `.dev.vars.example` to ignored `.dev.vars`, replace `JWT_SECRET`, and keep
Cloudflare’s always-pass Turnstile test secret for local-only validation.

```bash
bun install --frozen-lockfile
bun run db:migrate:local
bun run type-check
bun run test
```

`bun run test` includes the migration contract: core and custom migrations are
applied to a temporary local D1 database, custom migrations are reapplied as a
no-op, and the form version, fields, disabled plugin inheritance, shadow
collection, custom columns, and audit table are checked.

## Cutover

1. Configure the CMS Worker secret separately:

   ```bash
   bunx wrangler secret put TURNSTILE_SECRET --config wrangler.jsonc
   ```

2. Deploy the CMS and apply its migrations.
3. Run `bun run test:smoke` and verify an actual branded-form submission,
   queue rendering, all four status changes, and audit creation.
4. Deploy the public-site frontend cutover.
5. Browser-test desktop and mobile contact UX and the
   `admin.macon170.com` redirect.

Do not deploy or apply remote migrations until separately approved.

Rollback is a coordinated frontend revert to a separately approved retained
backend. Never dual-write.

## Troubleshooting

- `security` on a valid-looking request: confirm origin, Turnstile hostname,
  and action match the committed settings.
- `temporary`: confirm the CMS `TURNSTILE_SECRET` exists and Siteverify is
  reachable; do not put the secret in D1 or source.
- Queue redirects to login: expected without a CMS session.
- Queue returns `403` after login: verify the user is active and has SonicJS
  role `admin`.
- Status update returns `invalid_csrf`: reload the queue to obtain a fresh
  signed CSRF cookie/token pair.
