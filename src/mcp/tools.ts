import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuthManager, generateCsrfToken } from "@sonicjs-cms/core/middleware";
import { z } from "zod";
import type { Grant } from "./oauth";
import { type Actor, type McpEnv } from "./security";

export type Dispatch = (request: Request) => Promise<Response>;
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const revision = z.number().int().nonnegative();
const text = z.string().max(8000);
const optionalText = text.nullable().optional();
const event = z
  .object({
    slug: z.string().min(2).max(80),
    title: z.string().min(3).max(160),
    summary: z.string().min(10).max(500),
    description: text.min(10),
    category: z.enum(["pack", "den", "family"]),
    eventStatus: z.enum(["scheduled", "tentative", "cancelled"]),
    startsAt: z
      .string()
      .describe(
        "ISO 8601 timestamp including UTC offset. Interpret user dates in America/New_York.",
      ),
    endsAt: optionalText,
    allDay: z.boolean(),
    timezone: z.literal("America/New_York"),
    audience: z.string().min(2).max(300),
    locationName: optionalText,
    address: optionalText,
    whatToBring: optionalText,
    cost: optionalText,
    registrationUrl: optionalText,
    milestone: z
      .enum(["lego-derby", "fall-camp", "pinewood-derby", "blue-gold"])
      .nullable()
      .optional(),
  })
  .strict();
const roleData = z
  .object({
    title: z.string().min(1).max(120),
    name: z.string().max(120),
    section: z.enum(["pack-leadership", "den-leaders"]),
    sortOrder: z.number().int(),
  })
  .strict();
const signup = z
  .object({
    slug: z.string().min(2).max(80),
    eventId: id,
    formType: z.enum(["rsvp", "items"]),
    title: z.string().min(2).max(120),
    instructions: z.string().max(2000),
    state: z.enum(["draft", "open", "closed"]),
    closesAt: optionalText,
    slots: z
      .array(
        z
          .object({
            id: id.optional(),
            label: z.string().min(1).max(120),
            quantityNeeded: z.number().int().min(1).max(500),
            notes: z.string().max(300).nullable().optional(),
          })
          .strict(),
      )
      .max(60),
  })
  .strict();
const status = z.enum(["pending", "reviewed", "approved", "spam"]);
const broadcastDraft = {
  id: id.optional(),
  listId: id,
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
};

export function buildMcpServer(
  env: McpEnv,
  actor: Actor,
  grant: Grant,
  dispatch: Dispatch,
): McpServer {
  const server = new McpServer({ name: "macon170", version: "1.0.0" });
  // Credentials exist only inside this request. The caller cannot select a path,
  // impersonate another user, pass arbitrary headers, or receive session cookies.
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    form = false,
  ) => {
    const jwt = await AuthManager.generateToken(
      actor.id,
      actor.email,
      actor.role,
      env.JWT_SECRET,
      60,
    );
    const csrf = await generateCsrfToken(env.JWT_SECRET);
    const headers = new Headers({
      Authorization: `Bearer ${jwt}`,
      Cookie: `auth_token=${jwt}; csrf_token=${encodeURIComponent(csrf)}`,
      Origin: env.MCP_ORIGIN,
      "X-CSRF-Token": csrf,
    });
    let content: string | undefined;
    if (body !== undefined) {
      headers.set(
        "Content-Type",
        form ? "application/x-www-form-urlencoded" : "application/json",
      );
      content = form
        ? new URLSearchParams(body as Record<string, string>).toString()
        : JSON.stringify(body);
    }
    const response = await dispatch(
      new Request(env.MCP_ORIGIN + path, {
        method,
        headers,
        ...(content !== undefined ? { body: content } : {}),
      }),
    );
    if (!response.headers.get("Content-Type")?.includes("application/json"))
      throw new Error(
        `CMS returned HTTP ${response.status}; inspect the CMS before retrying.`,
      );
    const data: unknown = await response.json();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ status: response.status, data }),
        },
      ],
      isError: !response.ok,
    };
  };
  type Result = Awaited<ReturnType<typeof call>>;
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: S,
    scope: "cms:read" | "cms:write" | "cms:send",
    run: (args: z.infer<z.ZodObject<S>>) => Promise<Result>,
    destructive = false,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema as z.ZodRawShape,
        annotations: {
          readOnlyHint: scope === "cms:read",
          destructiveHint: destructive,
          openWorldHint: scope === "cms:send",
          idempotentHint: scope === "cms:read",
        },
        _meta: { securitySchemes: [{ type: "oauth2", scopes: [scope] }] },
      },
      async (args) => {
        if (!grant.scope.split(" ").includes(scope))
          return {
            content: [
              { type: "text", text: `Reconnect with ${scope} permission.` },
            ],
            isError: true,
          };
        // Persist an attempted invocation before the side effect. Never log payloads,
        // recipients, contact messages, credentials, or invitation links.
        const auditId = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO mcp_audit(id,user_id,grant_id,tool,success,created_at) VALUES(?,?,?,?,0,?)",
        )
          .bind(auditId, actor.id, grant.id, name, Date.now())
          .run();
        let result: Result;
        try {
          result = await run(z.object(schema).strict().parse(args));
        } catch {
          result = {
            content: [
              {
                type: "text",
                text: "The operation could not be confirmed. Read the current CMS state before retrying; email delivery may be ambiguous.",
              },
            ],
            isError: true,
          };
        }
        try {
          await env.DB.prepare("UPDATE mcp_audit SET success=? WHERE id=?")
            .bind(result.isError ? 0 : 1, auditId)
            .run();
        } catch {
          console.error(
            JSON.stringify({ event: "mcp_audit_update_failed", auditId }),
          );
        }
        return result;
      },
    );
  }
  const calendar = "/api/calendar-admin/v1/events";
  tool(
    "list_calendar_events",
    "List all calendar events, including drafts and archived events, with current revisions.",
    {},
    "cms:read",
    () => call("GET", calendar),
  );
  tool(
    "get_calendar_event",
    "Read an event before editing or publishing it.",
    { id },
    "cms:read",
    (a) => call("GET", `${calendar}/${a.id}`),
  );
  tool(
    "create_calendar_event",
    "Create a calendar draft. Publish separately when requested.",
    event.shape,
    "cms:write",
    (a) => call("POST", calendar, a),
  );
  tool(
    "update_calendar_event",
    "Update an event using its most recently read revision. Cancel by setting eventStatus to cancelled. A conflict requires reading again.",
    { id, expectedRevision: revision, changes: event.partial() },
    "cms:write",
    (a) =>
      call("PATCH", `${calendar}/${a.id}`, {
        ...a.changes,
        expectedRevision: a.expectedRevision,
      }),
  );
  for (const action of ["publish", "archive"] as const)
    tool(
      `${action}_calendar_event`,
      `${action === "publish" ? "Publish" : "Archive"} an event on the public site using its current revision.`,
      { id, expectedRevision: revision },
      "cms:write",
      (a) =>
        call("POST", `${calendar}/${a.id}/${action}`, {
          expectedRevision: a.expectedRevision,
        }),
      true,
    );

  const roster = "/api/collections/leadership-roster/content";
  const checkRole = async (entry: string) => {
    const row = await env.DB.prepare(
      "SELECT content.id FROM content JOIN collections ON collections.id=content.collection_id WHERE content.id=? AND collections.name='leadership-roster'",
    )
      .bind(entry)
      .first();
    if (!row) throw new Error("Leadership role not found");
  };
  tool(
    "list_leadership",
    "List leadership roles and volunteer names. Empty names indicate vacancies.",
    {},
    "cms:read",
    () => call("GET", roster),
  );
  tool(
    "get_leadership_role",
    "Read a leadership role.",
    { id },
    "cms:read",
    async (a) => {
      await checkRole(a.id);
      return call("GET", "/api/content/" + a.id);
    },
  );
  tool(
    "create_leadership_role",
    "Create a leadership role. Choose draft or published explicitly; public names must be approved.",
    {
      slug: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(120),
      status: z.enum(["draft", "published"]),
      data: roleData,
    },
    "cms:write",
    async (a) => {
      const collection = await env.DB.prepare(
        "SELECT id FROM collections WHERE name='leadership-roster'",
      ).first<{ id: string }>();
      if (!collection) throw new Error("Leadership collection unavailable");
      return call("POST", "/api/content", {
        ...a,
        title: a.data.title,
        collectionId: collection.id,
      });
    },
  );
  tool(
    "update_leadership_role",
    "Update an existing leadership role. Read first to preserve unchanged fields; setting status to published makes it public.",
    { id, data: roleData, status: z.enum(["draft", "published"]).optional() },
    "cms:write",
    async (a) => {
      await checkRole(a.id);
      return call("PUT", "/api/content/" + a.id, {
        data: a.data,
        ...(a.status ? { status: a.status } : {}),
      });
    },
  );
  tool(
    "delete_leadership_role",
    "Permanently delete a leadership role when the user requests removal.",
    { id },
    "cms:write",
    async (a) => {
      await checkRole(a.id);
      return call("DELETE", "/api/content/" + a.id);
    },
    true,
  );

  const forms = "/api/signups-admin/v1/forms";
  tool(
    "list_signup_forms",
    "List RSVP and item signup forms.",
    {},
    "cms:read",
    () => call("GET", forms),
  );
  tool(
    "get_signup_form",
    "Read signup configuration, private family responses, item claims and attendance totals.",
    { id },
    "cms:read",
    (a) => call("GET", `${forms}/${a.id}`),
  );
  tool(
    "create_signup_form",
    "Create an event signup with RSVP or item slots.",
    signup.shape,
    "cms:write",
    (a) => call("POST", forms, a),
  );
  tool(
    "update_signup_form",
    "Replace signup configuration using the current revision. Preserve existing slot IDs. Set state to open or closed to control registration.",
    { id, expectedRevision: revision, form: signup },
    "cms:write",
    (a) =>
      call("PUT", `${forms}/${a.id}`, {
        ...a.form,
        expectedRevision: a.expectedRevision,
      }),
  );
  tool(
    "delete_signup_response",
    "Delete a family response and release its item claims.",
    { id },
    "cms:write",
    (a) => call("DELETE", "/api/signups-admin/v1/responses/" + a.id),
    true,
  );
  tool(
    "resend_signup_email",
    "Send a fresh signup management link to the stored family email. Do not automatically retry ambiguous failures.",
    { id },
    "cms:send",
    (a) => call("POST", `/api/signups-admin/v1/responses/${a.id}/resend`),
    true,
  );

  const contacts = "/api/contact-admin/v1/submissions";
  tool(
    "list_parent_inquiries",
    "List private parent inquiries, 25 per page. Continue while hasMore is true.",
    {
      page: z.number().int().min(1).max(1000).optional(),
      status: status.optional(),
    },
    "cms:read",
    (a) =>
      call(
        "GET",
        contacts +
          "?" +
          new URLSearchParams(
            Object.entries(a).map(([k, v]) => [k, String(v)]),
          ),
      ),
  );
  tool(
    "get_parent_inquiry",
    "Read a parent inquiry and mark it viewed in the CMS audit trail.",
    { id },
    "cms:read",
    (a) => call("GET", `${contacts}/${a.id}`),
  );
  tool(
    "update_parent_inquiry",
    "Set inquiry status: pending=New, reviewed=In progress, approved=Resolved, spam=Spam.",
    { id, status },
    "cms:write",
    (a) => call("PATCH", `${contacts}/${a.id}`, { status: a.status }),
  );

  const broadcasts = "/api/broadcasts/v1";
  tool(
    "list_email_workspace",
    "List mailing lists, contacts, active memberships, email drafts and delivery/open/bounce statistics. Queued or accepted does not mean delivered.",
    {},
    "cms:read",
    () => call("GET", broadcasts),
  );
  tool(
    "get_mailing_list",
    "Read a mailing list and its active contacts.",
    { id },
    "cms:read",
    (a) => call("GET", `${broadcasts}/lists/${a.id}`),
  );
  tool(
    "save_mailing_list",
    "Create or rename a mailing list and its public signup slug. Omit id to create.",
    {
      id: id.optional(),
      name: z.string().min(1).max(100),
      slug: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(80),
    },
    "cms:write",
    (a) => call("POST", broadcasts + "/lists", a),
  );
  tool(
    "save_email_contact",
    "Create a contact or update the name for an existing email address. This does not subscribe them.",
    { email: z.email(), name: z.string().max(100) },
    "cms:write",
    (a) => call("POST", broadcasts + "/contacts", a),
  );
  tool(
    "update_mailing_memberships",
    "Add or remove a contact from lists. Set consent=true only with actual consent evidence from the user. Unsubscribed or suppressed contacts cannot be re-added.",
    {
      contactId: id,
      listIds: z.array(id).min(1).max(100),
      action: z.enum(["add", "remove"]),
      consent: z.boolean().optional(),
    },
    "cms:write",
    (a) => call("POST", broadcasts + "/memberships", a),
    true,
  );
  tool(
    "save_email_draft",
    "Create or edit an email draft for a mailing list. Does not send. Omit id to create.",
    broadcastDraft,
    "cms:write",
    (a) => call("POST", broadcasts + "/drafts", a),
  );
  tool(
    "send_email_broadcast",
    "Queue an existing draft for sending to its subscribed mailing list. Requires an explicit user instruction to send this message to this audience. Read the final draft and list first. Sending is irreversible; never retry an ambiguous result automatically.",
    { id },
    "cms:send",
    (a) => call("POST", broadcasts + "/send", a),
    true,
  );

  tool(
    "list_pending_invitations",
    "List pending volunteer accounts without exposing invitation tokens.",
    {},
    "cms:read",
    async () => {
      const rows = await env.DB.prepare(
        "SELECT id,email,first_name,last_name,role,invited_at FROM users WHERE is_active=0 AND invitation_token IS NOT NULL AND accepted_invitation_at IS NULL ORDER BY invited_at DESC LIMIT 100",
      ).all();
      return {
        content: [
          { type: "text", text: JSON.stringify({ invitations: rows.results }) },
        ],
        isError: false,
      };
    },
  );
  tool(
    "invite_volunteer",
    "Send a volunteer an account setup email with the requested CMS role. Prefer the least privilege role suitable for their work. Requires an explicit instruction to send.",
    {
      email: z.email(),
      first_name: z.string().min(1).max(100),
      last_name: z.string().min(1).max(100),
      role: z.enum(["viewer", "author", "editor", "admin"]),
    },
    "cms:send",
    (a) => call("POST", "/admin/invite-user", a, true),
    true,
  );
  tool(
    "resend_volunteer_invitation",
    "Send a new setup email to the existing pending volunteer; invalidates the old link and preserves their role. Requires an explicit instruction to resend.",
    { id },
    "cms:send",
    (a) => call("POST", "/admin/resend-invitation/" + a.id, {}, true),
    true,
  );
  return server;
}
