# Email broadcasts

Open `/admin/broadcasts` (Email in the CMS header). Create a named list and a
unique lowercase signup slug, save contacts, then select a contact and one or
more lists to add or remove. Adding requires an explicit consent attestation.
The signup link is `/email/signup/<slug>` on the CMS domain. Public subscribers
must check the consent box and confirm their address using a single-use link
that expires after 24 hours. Signup is limited by IP and confirmation emails
are limited to one per contact per list per hour while a confirmation remains pending.
Existing active subscribers are not sent redundant confirmation emails.

Click a list name to edit its name or signup slug, search its contacts, or remove
one or several memberships without deleting contacts from other lists.

Select a list, write a subject and compose the message with the visual HTML
editor. It supports headings, emphasis, colors, lists, alignment, links, and
HTTPS-hosted images. Save draft preserves formatting and lets you reopen and
edit the message later; New draft starts a separate message. Preview email
shows the sanitized result at desktop or mobile width without saving or sending.
Use `{{name}}` for the recipient’s contact name; previews use “friend”. Sending presents the current subscriber
count and requires a deliberate confirmation. Once queued, the audience and
message are frozen. Repeated send requests cannot duplicate recipients.

The statistics show recipient, provider acceptance, delivery, unique open,
bounce, skipped, and uncertain counts. Acceptance is not delivery; delivery
is acceptance by the receiving server, not proof of inbox placement. Open
tracking is approximate and is affected by privacy features and image blocking.
HTML is sanitized on the server with a restricted formatting allowlist; scripts,
embedded forms, unsafe URLs, and arbitrary CSS are removed. A plain-text
alternative is generated automatically. Click tracking is disabled, consistent
with existing CMS email policy.

After the provider accepts a recipient’s message, a public HTML copy becomes
available at `/email/messages/<campaign-UUID>`, linked from the campaign and
from each delivered email. Drafts and campaigns with no accepted sends return
404. The public copy uses “friend” in place of `{{name}}` and omits recipient
addresses and subscription tokens. Text explicitly written into the message
remains public, so review the preview before sending. Sent content is frozen.
Public copies are excluded from search indexing.

## Access

Migration `0007_broadcasts.sql` grants `broadcasts.manage` to administrators.
An active volunteer account must receive that permission through SonicJS's
user permission management before using the page or API. All admin API writes
require same-origin requests and the existing signed CSRF cookie/header.
Public registration, account roles, and existing contact inquiry records are
not changed. Broadcast contacts are separate from CMS login accounts and
inquiry submissions; neither is automatically subscribed.

## Production setup

Apply custom migrations, including `0008_broadcast_html.sql`, before activating
the new Worker. The pinned Quill editor assets are served from this Worker’s
`public/email-editor/` directory; regenerate them with `bun run editor:assets`
when updating Quill. No third-party CDN is needed. Use the existing
`POSTMARK_SERVER_TOKEN` secret and configure these Worker bindings:

| Binding | Value |
| --- | --- |
| `BROADCAST_FROM_EMAIL` | A verified Pack sender address (for example `volunteers@macon170.com`) |
| `BROADCAST_STREAM` | The ID of a **Broadcast** Postmark message stream; never `outbound` |
| `BROADCAST_ORIGIN` | `https://cms.macon170.com` without a trailing slash |
| `BROADCAST_WEBHOOK_SECRET` | A new random secret, stored with Wrangler secrets |
| `BROADCAST_UNSUBSCRIBE_MODE` | Omit or use `postmark`; use `custom` only after Postmark approval |

Keep `JWT_SECRET` configured: it signs public preference and confirmation
links. Rotating it invalidates those links. The existing `SIGNUP_RATE_LIMITER`
is also required for public signup. Sending remains disabled without the
sender, stream, origin, webhook secret, or Postmark token. Public confirmations
use the transactional `outbound` stream; broadcasts use the dedicated stream.

In that broadcast stream, configure a webhook for Delivery, Open, Bounce,
SpamComplaint, and SubscriptionChange events:

- URL: `https://cms.macon170.com/api/broadcast-webhook`
- Custom header: `X-Broadcast-Secret`, equal to the Worker secret
- Disable full message content in bounce events. Request bodies are bounded.

Webhooks must retain the recipient address, MessageID, MessageStream, and
Metadata. Events are matched to stored recipients, including metadata matching
when the webhook arrives before the send response. Repeated notifications do
not inflate unique statistics. Wrong streams are ignored; invalid secrets are
rejected. Provider/database failures return non-success responses for retry.

Postmark-managed unsubscribe is the default. It supplies the RFC 8058 headers
and replaces the explicit unsubscribe placeholder in both email bodies. That
option unsubscribes the address from the entire broadcast stream; the
SubscriptionChange webhook mirrors suppression into the CMS. Every message
also links to the CMS preferences page, where recipients can leave individual
lists, multiple lists, or all current and future broadcasts without logging in.
See [Postmark's header documentation](https://postmarkapp.com/support/article/1299-how-to-include-a-list-unsubscribe-header).

For list-specific mailbox one-click unsubscribe, first obtain Postmark approval
for custom unsubscribe handling and enable it on the stream. Then set
`BROADCAST_UNSUBSCRIBE_MODE=custom`. The CMS supplies a signed HTTPS URL and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Its POST endpoint immediately
unsubscribes the originating list without cookies, login, or another click.
GET displays a confirmation page and never changes memberships.

## Google sender readiness

Follow [Google's sender guidelines](https://support.google.com/mail/answer/81126?hl=en)
before live sending. Verify SPF and DKIM for the Pack domain, publish DMARC,
and check From-domain alignment. Google requires SPF or DKIM for all senders;
bulk senders require both plus DMARC. Use a 2048-bit DKIM key where supported.
Confirm Postmark's delivery path uses TLS and valid forward/reverse DNS.
Inspect a real received message's authentication results and unsubscribe
headers, including DKIM coverage of one-click headers. Application tests do
not verify DNS or the final delivered message.

Send only to consenting recipients, keep subjects and sender identity accurate,
and increase volume gradually. Monitor Google Postmaster Tools: target spam
rates below 0.1% and avoid reaching 0.3%. The CMS's open statistics do not prove
deliverability. One-click unsubscribe and the visible footer are included even
at the Pack's small sending volume.

## Delivery and suppression behavior

A once-per-minute scheduled handler drains the D1 outbox, up to ten recipients
per invocation. It atomically claims each recipient and rechecks current
membership and suppression before sending. The separate nightly retention
schedule continues unchanged. Expired signup confirmation records are removed
by the delivery schedule.

Two distinct bounced broadcast messages mark the contact `bounced` and change
all memberships to `unsubscribed`. Repeated webhook deliveries for the same
message count once. Postmark may suppress a hard-bounced address after its
first bounce: SubscriptionChange records this as `suppressed`, preventing
further delivery before the CMS two-bounce threshold is reached. Complaints
immediately suppress the address and unsubscribe all memberships.

An individual opt-out is preserved even when a volunteer tries to remove and
re-add the membership. The contact must use the public confirmation flow to
rejoin that list. Global opt-outs and provider suppressions cannot be overridden
in the UI. Resolve provider suppression and obtain renewed consent before any
operator-assisted reactivation; there is deliberately no bulk reset control.

Provider timeouts, rejection responses, and malformed responses are recorded
as `unknown`; a crashed send claim becomes `unknown` after ten minutes. There
is no automatic retry of these outcomes because the provider may have already
accepted the message. Check Postmark Activity against `broadcast_recipients`
(email, campaign ID, message ID) before a manual follow-up. Valid subsequent
webhooks can resolve unknown status. A completed campaign can include unknown
or skipped recipients; completion describes outbox processing.

The page displays the latest 200 campaigns, first 5,000 contacts, and first
20,000 active memberships. It is intended for Pack-scale lists. Recipient
history and suppression tombstones are retained so later webhooks and opt-outs
remain effective. Do not delete suppressed contact records as routine cleanup.

## Validation

`src/broadcasts.integration.test.ts` exercises the real migration with SQLite,
transactional batches, authorization/CSRF, opt-in and opt-out, send idempotency,
provider failures, webhook deduplication, and suppression. Provider requests are
mocked; tests do not send live email. Run `bun run test` and
`bun run type-check`. Verify the configured stream and webhook with a controlled
recipient before sending a real list.
