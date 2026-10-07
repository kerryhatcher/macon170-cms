# Volunteer invitation Mailgun repair

## Goal and design

Send new and resent volunteer invitations through the Mailgun configuration
already used by signup confirmations. Production Cloudflare Email Sending is
not configured. Preserve SonicJS account creation, token rotation, acceptance,
authorization, and the existing 502 response when a saved invitation cannot send.

Use a small shared `src/mailgun.ts` transport for multipart HTTP delivery, basic
authentication, sender/recipient, text and HTML, optional Reply-To, and disabled
tracking. Keep invitation rendering in `request-handler.ts` and signup rendering
in `signup-email.ts`. Only configured Mailgun requests are sent; never log message
bodies, credentials, recipients, or invitation tokens. Log sanitized failure
categories and provider status codes. No automatic send retries.

## Implementation and verification

- [x] Change route tests to require Mailgun credentials and assert outgoing HTTP
  requests, safe success/failure responses, and missing configuration rejection.
- [x] Update the real SonicJS/SQLite integration test to mock only outbound fetch.
  Verify failed delivery leaves an inactive account and resend rotates its token,
  targets the stored recipient, sends through Mailgun, and remains token-safe.
- [x] Run the changed tests and observe the expected failures before implementation.
- [x] Extract the shared Mailgun transport; use it from signup and invitation paths.
  Reject provider redirects and sanitize network errors before logging.
- [x] Remove the unused Cloudflare email binding and regenerate Worker types;
  update current operator docs and the local environment example.
- [x] Run type checking, all repository tests, and the Worker dry-run bundle.
  Review the final diff. All 225 tests and both migration suites pass.

Commit the focused fix with configured hooks enabled after these checks pass.

## Release

Prepare the implementation for review. Production deployment and resending the
real pending invitation are separate actions; do not send any real email during
automated validation. No schema or DNS changes are needed. After deployment,
use the existing admin resend operation for the pending account.
