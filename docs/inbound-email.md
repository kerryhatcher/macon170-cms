# Incoming email

The private inbox at `/admin/inbox` receives and stores Postmark mail for any
address at `macon170.com`. It provides sender/subject search, exact sender and
inbox-address filters, review status, received-date range, ascending/descending
sorting, and 25-message pagination. Open a message to read its text and download
attachments. Set New, Reviewed, Archived or Spam explicitly; opening a message
does not change its status. Status updates require the current revision and are
audited. There is no reply or automatic email response.

Access requires an active CMS account with `inbox.manage`. The migration grants
this to administrators. Administrators can grant the permission to volunteer
roles through SonicJS role permissions. It is separate from `broadcasts.manage`;
reviewing incoming mail does not grant permission to send broadcasts. ChatGPT
connections still require an administrator account and the appropriate
`cms:read`/`cms:write` scope.

Sender addresses link case-insensitively to `broadcast_contacts`, the existing
email contacts. Click a linked contact in the inbox or mailing list to view
contact details and incoming email history. The email workspace also provides
**View contact and incoming emails** for the selected contact. Matching includes
messages received before the contact was created. Incoming mail does not create
contacts or subscribe senders to mailing lists. Parent inquiry form submissions
remain a separate workflow.

## Storage and API

Migration `0010_inbound_email.sql` creates indexed D1 message metadata and status
audit tables. Message content and attachments live in the separate private R2
bucket `macon170-cms-inbound`, bound as `INBOUND_BUCKET`. Keep this bucket's
managed public URL disabled and do not attach a public domain. The CMS media
routes use `MEDIA_BUCKET` and cannot access inbound storage.

`POST /api/inbound-webhook` accepts Postmark's inbound JSON only with Basic auth
username `postmark` and password `INBOUND_WEBHOOK_SECRET`. Use a random hex
secret. The server rejects other domains/streams and malformed payloads.
The CMS bounds the entire JSON webhook to 20 MiB, including base64 attachments,
and each text/HTML body to 10 MiB. This is a deliberate Worker memory bound;
Postmark's upstream inbound limit is larger. Oversize deliveries receive 422
and appear as processing errors after Postmark retries; inspect and resolve
these in Postmark. Do not treat a provider processing error as stored mail.

A Postmark MessageID is unique and provides the retry identity. R2 storage
completes before the D1 insert and before HTTP 200. Storage failures return 503
so Postmark retries; duplicate deliveries return 200 without resetting status.
An interruption between storage and metadata can leave an unlisted R2 object;
a successful retry completes the metadata. Never acknowledge storage failure.
No message bodies, addresses, attachments or secrets are written to Worker logs.
There is no automatic retention deletion; archived and spam messages remain
available for review.

Authenticated API endpoints:

- `GET /api/inbox/v1`: `q`, `status`, `sender`, `recipient`, `contactId`, `after`
  (inclusive), `before` (exclusive), `sort` (`received_at`, `sender`, `subject`,
  `recipient`), `direction` (`asc`, `desc`), and `page`. Returns `emails`,
  `hasMore`, `page` and optional contact details. API dates are ISO timestamps;
  browser date filters use the browser's local midnight.
- `GET /api/inbox/v1/:id`: metadata, safe text, recipient headers and attachment
  metadata. HTML-only mail is converted to text. No active HTML or remote
  images render in the inbox.
- `GET /api/inbox/v1/:id/attachments/:index`: authenticated, no-cache download
  with attachment disposition and `application/octet-stream`.
- `PATCH /api/inbox/v1/:id`: `{ status, expectedRevision }`, with Origin/CSRF
  validation. A stale revision returns 409. Audit records include actor and time.

MCP tools reuse these same protected APIs: `list_inbound_emails`,
`get_inbound_email`, `list_contact_inbound_emails`, and
`update_inbound_email_status`. Attachment links require a signed-in CMS browser;
the MCP adapter never returns attachment bytes or credentials. Treat email text
and attachment names as untrusted data, including when reviewing in ChatGPT.

## Activate the catch-all domain

Apply these steps in order, after validating the code:

1. Create the private bucket with
   `bunx wrangler r2 bucket create macon170-cms-inbound`. Confirm public access
   is disabled. Apply custom migrations before deploying the Worker.
2. Generate a random hex password and store it with
   `bunx wrangler secret put INBOUND_WEBHOOK_SECRET`. Keep the value out of Git,
   terminal output, chat and ordinary application logs.
3. Deploy the Worker and confirm an unauthenticated webhook returns 401
   (503 means the secret or bucket is missing).
4. In Postmark's **Macon170.com** server → **Inbound** stream → **Settings**,
   set the inbound webhook URL to
   `https://postmark:YOUR_SECRET@cms.macon170.com/api/inbound-webhook`.
   Disable **Include raw email content**; attachments are already included.
   Set **Inbound domain forwarding** to `macon170.com`.
   Do not use the outbound events Webhooks API to configure inbound delivery.
5. Post an authenticated synthetic inbound payload with a unique MessageID,
   `MessageStream: "inbound"`, and
   `OriginalRecipient: "inbox-test@macon170.com"`. Confirm HTTP 200 and verify
   the stored message and attachment in the CMS before changing DNS.
6. Replace the apex `macon170.com` MX records with one record pointing to
   `inbound.postmarkapp.com`, priority **10**, DNS only. As inspected on
   October 9, 2026, the two existing MX records point to `mxa.mailgun.org` and
   `mxb.mailgun.org`, both priority 10. Keep their original values for rollback;
   retaining them alongside Postmark can split inbound delivery.
7. Send a real email from outside the domain to a new address such as
   `inbox-test@macon170.com`. Verify Postmark processed it, the CMS lists it,
   the attachment downloads correctly and a duplicate delivery creates no
   second record. Also test `contact@macon170.com` and a known contact sender.
   Confirm no automatic reply is sent.

The DNS change routes every mailbox at this domain to Postmark; individual
mailbox provisioning is unnecessary. Existing senders' SPF/DKIM/DMARC records
are separate and should remain intact. If activation fails, restore the old MX
records and keep stored messages. Failed inbound deliveries can be retried
from Postmark after fixing configuration.

References: [Postmark domain forwarding](https://postmarkapp.com/developer/user-guide/inbound/inbound-domain-forwarding),
[inbound webhook authentication and retries](https://postmarkapp.com/developer/webhooks/inbound-webhook),
and [provider size limits](https://postmarkapp.com/support/article/1056-what-are-the-attachment-and-email-size-limits).
