# Pack 170 ChatGPT plugin

The saved private plugin is [Pack 170](https://chatgpt.com/plugins/plugins_6ac97b8340a88191a80b8dfd27c0bb08).
Its plugin ID is `plugins_6ac97b8340a88191a80b8dfd27c0bb08`; the initial release is
`pluginrel_6ac97b83d7a48191a837ac7785790531`. Version 1.0.1 is saved as
`pluginrel_6ac97c69e7688191ad611d63a015972a`. Preserve the plugin identity for future updates.

The private plugin source is in `plugins/macon170`. The CMS hosts its Streamable
HTTP MCP endpoint at `https://cms.macon170.com/mcp`. It exposes 31 tools covering
Pack calendar events, leadership roles, RSVP/item signups, private parent
inquiries, mailing lists and contacts, rich email drafts, sanitized previews and broadcast queuing,
statistics, and volunteer invitations. It uses existing CMS handlers rather
than an alternate content store or direct email provider access.

## Connection and operation

Deploy the additive `0009_chatgpt.sql` migration before the Worker. Number 0008
is reserved for the independent broadcast HTML change. The endpoint requires
`JWT_SECRET`, `MCP_ORIGIN` and the configured `MCP_RATE_LIMITER`; no new provider
secret is needed. Keep `MCP_ORIGIN` equal to the externally reachable origin.
For local development override it in `.dev.vars` to the local Worker origin.
OAuth clients require HTTPS redirect URIs.

Install the Pack 170 private plugin, connect it, and sign in with an active CMS
administrator account. Consent lists the requested permissions and callback
origin. Tokens never appear in plugin files. The three scopes are `cms:read`,
`cms:write` and `cms:send`; email sending is separate from editing. Existing
calendar, signup and broadcast permission checks still run for each operation.
Disabling or demoting an administrator immediately blocks their MCP access.

Open `/admin/chatgpt` (linked from the dashboard) to revoke your connections.
Each grant expires after 30 days; access tokens last at most one hour and refresh
tokens rotate. Reconnect after grant expiry. OAuth supports public DCR clients,
authorization code + S256 PKCE, resource binding, issuer identification and
revocation. Codes are single-use and expire after five minutes. Opaque access,
refresh and authorization codes are stored only as SHA-256 hashes. DCR client
metadata is signed with a domain-separated HMAC and stored in the client ID.
Browser cookies cannot authenticate MCP requests.

Daily maintenance removes expired credentials and revoked grants. The MCP audit
records actor, grant, tool, time and success, without inputs or outputs, for one
year. A recorded failure can represent an ambiguous operation; inspect the CMS
before retrying. Existing per-workflow audit trails remain authoritative for
record changes.

Example requests:

- “Create a draft Pack meeting for November 10 at 6 pm.”
- “Change the Cubmaster name to the approved volunteer name.”
- “How many families have confirmed attendance?”
- “Show new parent inquiries.”
- “Draft a reminder to the Pack news list.”
- “Send that saved reminder to the Pack news list.”

The plugin never automatically sends messages while being installed or tested.
The send tool queues broadcasts through the existing delivery scheduler, which
preserves suppression and unsubscribe behavior. Signup and invitation sends
use the existing transactional routes. Delivery failures may be ambiguous;
check provider activity before retrying. Parent inquiry status changes do not
send a reply. Arbitrary one-off email is not offered by the current CMS UI.

The Pack-owned screens are covered. SonicJS infrastructure configuration,
plugin administration, raw database editing and arbitrary code execution remain
outside the tool surface. The CMS currently allows only administrators to
connect. Tools do not grant new account privileges.

## Why SonicJS was not upgraded

On October 9, 2026 npm `latest` resolved to `3.0.0-beta.28` (`beta` resolved to
`3.0.0-beta.27`). The latest package exports `mcpPlugin` and `createMcpPlugin`.
Its native MCP implementation uses v3 document ACLs and the API Keys plugin,
with collection list/get/create/update/publish/delete tools. It is coupled to
the v3 plugin SDK and document repository, not an independently reusable v2
server. It does not expose Pack-specific calendar, inquiry, signup or email
workflows or implement the OAuth authorization-server flow required here.

The v3 package changes `users` to `auth_user`, replaces content and RBAC with
document-backed models, and starts a new migration sequence. Pack migrations
contain foreign keys to the v2 tables, and the custom workflows and public site
consume v2 contracts. A dependency bump alone would break these relationships.
A future upgrade needs an explicit data, auth, permission and public API
migration with backup and restoration validation. This integration retains
2.19.0 and its invitation compatibility patch. The standalone adapter uses the
official MCP SDK and can later point its operations at migrated handlers.

References inspected:

- [SonicJS changelog](https://sonicjs.com/changelog)
- [Native MCP plugin source](https://github.com/SonicJs-Org/sonicjs/tree/main/packages/core/src/plugins/core-plugins/mcp-plugin)
- [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth)
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)

## Validation and release

`bun run test` includes OAuth and MCP integration tests against the installed
SonicJS SQLite migrations and real CMS handlers, with Postmark mocked. Run
`bun run type-check` and `bun run deploy:dry` as well. For a live smoke check,
read both discovery endpoints and verify unauthenticated `/mcp` returns 401
with `WWW-Authenticate`; then connect with a real CMS account and run
`list_calendar_events`. Do not invoke send or write tools as a live smoke test.

Package `plugins/macon170` as the sole root directory in a ZIP and upload it
through Plugin Creator. A saved plugin does not deploy the CMS or authenticate
the user. The release is usable only after the migration and Worker are deployed
and the user completes the CMS consent flow.
