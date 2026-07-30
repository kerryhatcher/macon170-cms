import type { Bindings } from "@sonicjs-cms/core";
import {
  AuthManager,
  generateCsrfToken,
  validateCsrfToken,
} from "@sonicjs-cms/core/middleware";

import { renderCalendarAdminPage } from "./calendar-admin-page";
import {
  CALENDAR_PERMISSION,
  CALENDAR_VERSION,
  CalendarConflictError,
  CalendarNotFoundError,
  type CalendarBindings,
  createCalendarEvent,
  getCalendarEvent,
  listCalendarEvents,
  renderCalendarIcs,
  strongEtag,
  transitionCalendarEvent,
  updateCalendarEvent,
  validateCalendarInput,
} from "./calendar";
import { renderContactAdminPage } from "./contact-admin-page";
import { renderDashPage } from "./dash-page";
import { renderLeadershipPage } from "./leadership-page";
import {
  CONTACT_API_BASE,
  CONTACT_QUEUE_PATH,
  LEGACY_CONTACT_QUEUE_PATH,
  ContactRequestError,
  type ContactBindings,
  getContactSubmission,
  handleContactSubmission,
  isContactSubmissionPath,
  listContactSubmissions,
  updateContactSubmission,
} from "./contact";
import { renderLoginPage } from "./login-page";

type CmsAppFetch = (
  request: Request,
  env: Bindings,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

type AuthenticatedUser = {
  userId: string;
  email: string;
  role: string;
};

const disabledAuthPaths = new Set([
  "/auth/seed-admin",
  "/auth/register",
  "/auth/register/form",
]);
const managedTurnstilePluginPath = "/admin/plugins/turnstile";
const publicCache = "public, max-age=300";
const jsonContentType = "application/json; charset=UTF-8";

export function configuredCorsOrigins(env: Bindings): Set<string> {
  const configured =
    (env as Bindings & { CORS_ORIGINS?: string }).CORS_ORIGINS ?? "";
  return new Set(
    configured
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export function createCmsRequestHandler(appFetch: CmsAppFetch): CmsAppFetch {
  return async (request, rawEnv, ctx) => {
    const env = rawEnv as CalendarBindings & ContactBindings;
    const url = new URL(request.url);
    const { pathname } = url;

    if (disabledAuthPaths.has(pathname)) {
      return errorResponse(404, "not_found", "Not found.");
    }
    if (
      pathname === managedTurnstilePluginPath ||
      pathname.startsWith(`${managedTurnstilePluginPath}/`)
    ) {
      return errorResponse(
        403,
        "managed_configuration",
        "Turnstile is managed by the Pack contact endpoint.",
      );
    }
    if (request.method === "GET" && pathname === "/auth/login") {
      return htmlResponse(renderLoginPage(url));
    }

    if (pathname === "/api/version") {
      if (!["GET", "HEAD"].includes(request.method)) {
        return errorResponse(405, "method_not_allowed", "Method not allowed.");
      }
      const body = JSON.stringify({
        service: "macon170-cms",
        version: env.APP_VERSION ?? "unknown",
        environment: env.ENVIRONMENT ?? "unknown",
      });
      return new Response(request.method === "HEAD" ? null : body, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": jsonContentType,
        },
      });
    }

    if (isPublicCalendarPath(pathname)) {
      return handlePublicCalendarRequest(request, env);
    }

    if (isContactSubmissionPath(pathname)) {
      return handleContactSubmission(request, env);
    }

    if (pathname === "/forms/contact") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return errorResponse(405, "method_not_allowed", "Method not allowed.");
      }
      return Response.redirect(
        `${env.PUBLIC_SITE_ORIGIN ?? "https://www.macon170.com"}/contact/`,
        302,
      );
    }

    // Keep the native SonicJS submission page private and send existing
    // bookmarks to the Pack-owned queue, which enforces CMS admin access and
    // records the Pack audit events.
    if (pathname === LEGACY_CONTACT_QUEUE_PATH) {
      if (!['GET', 'HEAD'].includes(request.method)) {
        return errorResponse(404, 'not_found', 'Not found.')
      }
      return Response.redirect(`${url.origin}${CONTACT_QUEUE_PATH}`, 302)
    }

    if (pathname === "/dash") {
      if (request.method !== "GET") {
        return errorResponse(405, "method_not_allowed", "Method not allowed.");
      }
      const user = await authenticate(request, env);
      if (!user) {
        return Response.redirect(
          `${url.origin}/auth/login?returnTo=${encodeURIComponent("/dash")}`,
          302,
        );
      }
      if (!(await hasAdminAccess(env, user))) {
        return errorResponse(
          403,
          "forbidden",
          "An active CMS administrator account is required.",
        );
      }
      return htmlResponse(renderDashPage());
    }

    if (pathname === "/admin/leadership") {
      if (request.method !== "GET") {
        return errorResponse(405, "method_not_allowed", "Method not allowed.");
      }
      const user = await authenticate(request, env);
      if (!user) {
        return Response.redirect(
          `${url.origin}/auth/login?returnTo=${encodeURIComponent("/admin/leadership")}`,
          302,
        );
      }
      if (!(await hasAdminAccess(env, user))) {
        return errorResponse(
          403,
          "forbidden",
          "An active CMS administrator account is required.",
        );
      }
      const csrf = await ensureCsrfToken(request, env);
      if (csrf instanceof Response) return csrf;
      const response = htmlResponse(renderLeadershipPage(csrf.token));
      response.headers.append("Set-Cookie", csrf.cookie);
      return response;
    }

    if (pathname === CONTACT_QUEUE_PATH) {
      if (request.method !== "GET") {
        return errorResponse(405, "method_not_allowed", "Method not allowed.");
      }
      const user = await authenticate(request, env);
      if (!user) {
        return Response.redirect(
          `${url.origin}/auth/login?returnTo=${encodeURIComponent(CONTACT_QUEUE_PATH)}`,
          302,
        );
      }
      if (!(await hasAdminAccess(env, user))) {
        return errorResponse(
          403,
          "forbidden",
          "An active CMS administrator account is required.",
        );
      }
      const csrf = await ensureCsrfToken(request, env);
      if (csrf instanceof Response) return csrf;
      const response = htmlResponse(renderContactAdminPage(csrf.token));
      response.headers.append("Set-Cookie", csrf.cookie);
      return response;
    }

    if (pathname.startsWith(CONTACT_API_BASE)) {
      return handleAdminContactRequest(request, env);
    }

    if (pathname === "/admin/calendar") {
      if (request.method !== "GET") {
        return errorResponse(405, "method_not_allowed", "Method not allowed.");
      }
      const user = await authenticate(request, env);
      if (!user) {
        return Response.redirect(
          `${url.origin}/auth/login?returnTo=%2Fadmin%2Fcalendar`,
          302,
        );
      }
      if (!(await hasCalendarPermission(env, user))) {
        return errorResponse(
          403,
          "forbidden",
          `The ${CALENDAR_PERMISSION} permission is required.`,
        );
      }
      const csrf = await ensureCsrfToken(request, env);
      if (csrf instanceof Response) return csrf;
      const response = htmlResponse(renderCalendarAdminPage(csrf.token));
      response.headers.append("Set-Cookie", csrf.cookie);
      return response;
    }

    if (pathname.startsWith("/api/calendar-admin/v1")) {
      return handleAdminCalendarRequest(request, env);
    }

    // Calendar records are intentionally unavailable through SonicJS's generic
    // content surfaces. The dedicated API owns validation, revisions and audit.
    if (pathname.includes("calendar-event")) {
      return errorResponse(404, "not_found", "Not found.");
    }

    const response = await appFetch(request, rawEnv, ctx);
    const origin = request.headers.get("Origin");
    if (
      origin &&
      configuredCorsOrigins(rawEnv).has(origin) &&
      (pathname.startsWith("/api/collections/") ||
        pathname === "/api/forms/contact/schema" ||
        pathname === "/api/forms/default-contact-form/schema")
    ) {
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", origin);
      appendVary(headers, "Origin");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  };
}

function isPublicCalendarPath(pathname: string): boolean {
  return (
    pathname === "/api/calendar/v1/events" ||
    pathname.startsWith("/api/calendar/v1/events/") ||
    pathname === "/api/calendar/v1/calendar.ics"
  );
}

async function handlePublicCalendarRequest(
  request: Request,
  env: CalendarBindings,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const corsOrigin =
    origin && configuredCorsOrigins(env).has(origin) ? origin : null;
  if (request.method === "OPTIONS") {
    return withPublicCors(
      new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Cache-Control": "no-store",
        },
      }),
      corsOrigin,
    );
  }
  try {
    if (
      ["GET", "HEAD"].includes(request.method) &&
      url.pathname === "/api/calendar/v1/calendar.ics"
    ) {
      const events = await listCalendarEvents(env, true);
      const body = renderCalendarIcs(events);
      return withPublicCors(
        await conditionalResponse(request, body, "text/calendar; charset=UTF-8"),
        corsOrigin,
      );
    }
    if (request.method !== "GET") {
      return withPublicCors(
        errorResponse(405, "method_not_allowed", "Method not allowed."),
        corsOrigin,
      );
    }
    if (url.pathname === "/api/calendar/v1/events") {
      const events = await listCalendarEvents(env, true, true);
      const body = JSON.stringify({ version: CALENDAR_VERSION, events });
      return withPublicCors(
        await conditionalResponse(request, body, jsonContentType),
        corsOrigin,
      );
    }
    const encodedSlug = url.pathname.slice("/api/calendar/v1/events/".length);
    let slug: string;
    try {
      slug = decodeURIComponent(encodedSlug);
    } catch {
      return withPublicCors(
        errorResponse(400, "invalid_path", "Invalid event path."),
        corsOrigin,
      );
    }
    const event = await getCalendarEvent(env, slug, true);
    if (!event) {
      return withPublicCors(
        errorResponse(404, "not_found", "Calendar event not found."),
        corsOrigin,
      );
    }
    const body = JSON.stringify({ version: CALENDAR_VERSION, event });
    return withPublicCors(
      await conditionalResponse(request, body, jsonContentType),
      corsOrigin,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "calendar_public_request_failed",
        path: url.pathname,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    return withPublicCors(
      errorResponse(
        500,
        "calendar_unavailable",
        "Calendar service unavailable.",
      ),
      corsOrigin,
    );
  }
}

async function conditionalResponse(
  request: Request,
  body: string,
  contentType: string,
): Promise<Response> {
  const etag = await strongEtag(body);
  const headers = new Headers({
    "Cache-Control": publicCache,
    "Content-Type": contentType,
    ETag: etag,
  });
  if (
    request.headers
      .get("If-None-Match")
      ?.split(",")
      .map((value) => value.trim())
      .some(
        (value) =>
          value === "*" ||
          value.replace(/^W\//, "") === etag.replace(/^W\//, ""),
      )
  ) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : body, { headers });
}

async function handleAdminCalendarRequest(
  request: Request,
  env: CalendarBindings,
): Promise<Response> {
  const user = await authenticate(request, env);
  if (!user) return errorResponse(401, "unauthorized", "Sign in required.");
  if (!(await hasCalendarPermission(env, user))) {
    return errorResponse(
      403,
      "forbidden",
      `The ${CALENDAR_PERMISSION} permission is required.`,
    );
  }
  if (!["GET", "HEAD"].includes(request.method)) {
    const csrfError = await validateMutationCsrf(request, env);
    if (csrfError) return csrfError;
  }

  const url = new URL(request.url);
  const base = "/api/calendar-admin/v1";
  const relative = url.pathname.slice(base.length);
  try {
    if (request.method === "GET" && relative === "/session") {
      const csrf = await ensureCsrfToken(request, env);
      if (csrf instanceof Response) return csrf;
      const response = adminJson({
        version: CALENDAR_VERSION,
        user: { id: user.userId, email: user.email },
        permission: CALENDAR_PERMISSION,
        csrfToken: csrf.token,
      });
      response.headers.append("Set-Cookie", csrf.cookie);
      return response;
    }
    if (request.method === "GET" && relative === "/events") {
      return adminJson({
        version: CALENDAR_VERSION,
        events: await listCalendarEvents(env, false),
      });
    }
    if (request.method === "POST" && relative === "/events") {
      const payload = await readJson(request);
      const input = validateCalendarInput(payload);
      return adminJson(
        {
          version: CALENDAR_VERSION,
          event: await createCalendarEvent(env, input, user.userId),
        },
        201,
      );
    }

    const match = relative.match(
      /^\/events\/([^/]+)(?:\/(publish|archive))?$/,
    );
    if (!match) {
      return errorResponse(404, "not_found", "Not found.");
    }
    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return errorResponse(400, "invalid_path", "Invalid event path.");
    }
    const action = match[2];
    if (request.method === "GET" && !action) {
      const event = await getCalendarEvent(env, id, false);
      return event
        ? adminJson({ version: CALENDAR_VERSION, event })
        : errorResponse(404, "not_found", "Calendar event not found.");
    }
    if (
      !(
        (request.method === "PATCH" && !action) ||
        (request.method === "POST" && action)
      )
    ) {
      return errorResponse(405, "method_not_allowed", "Method not allowed.");
    }
    const payload = await readJson(request);
    const expectedRevision = readExpectedRevision(payload);
    if (request.method === "PATCH" && !action) {
      const current = await getCalendarEvent(env, id, false);
      if (!current) {
        return errorResponse(404, "not_found", "Calendar event not found.");
      }
      const input = validateCalendarInput({ ...current, ...payload });
      return adminJson({
        version: CALENDAR_VERSION,
        event: await updateCalendarEvent(
          env,
          id,
          input,
          expectedRevision,
          user.userId,
        ),
      });
    }
    if (request.method === "POST" && action) {
      return adminJson({
        version: CALENDAR_VERSION,
        event: await transitionCalendarEvent(
          env,
          id,
          action === "publish" ? "published" : "archived",
          expectedRevision,
          user.userId,
        ),
      });
    }
    return errorResponse(405, "method_not_allowed", "Method not allowed.");
  } catch (error) {
    if (error instanceof CalendarNotFoundError) {
      return errorResponse(404, "not_found", error.message);
    }
    if (error instanceof CalendarConflictError) {
      return errorResponse(409, "conflict", error.message);
    }
    if (
      error instanceof SyntaxError ||
      (error instanceof Error &&
        (error.message.startsWith("Invalid") ||
          error.message.startsWith("End date") ||
          error.message.startsWith("Pack 170") ||
          error.message.startsWith("Registration URL")))
    ) {
      return errorResponse(
        400,
        "invalid_request",
        error instanceof Error ? error.message : "Invalid request.",
      );
    }
    console.error(
      JSON.stringify({
        event: "calendar_admin_request_failed",
        path: url.pathname,
        actorId: user.userId,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    return errorResponse(
      500,
      "calendar_unavailable",
      "Calendar service unavailable.",
    );
  }
}

async function handleAdminContactRequest(
  request: Request,
  env: CalendarBindings & ContactBindings,
): Promise<Response> {
  const user = await authenticate(request, env);
  if (!user) {
    return errorResponse(401, "unauthorized", "Sign in required.");
  }
  if (!(await hasAdminAccess(env, user))) {
    return errorResponse(
      403,
      "forbidden",
      "An active CMS administrator account is required.",
    );
  }

  const url = new URL(request.url);
  const relative = url.pathname.slice(CONTACT_API_BASE.length);
  try {
    if (request.method === "GET" && (relative === "" || relative === "/")) {
      return listContactSubmissions(request, env);
    }
    const match = relative.match(/^\/([0-9a-f-]{36})$/i);
    if (!match) {
      return errorResponse(404, "not_found", "Not found.");
    }
    const id = match[1];
    if (request.method === "GET") {
      return getContactSubmission(id, env, user.userId);
    }
    if (request.method === "PATCH") {
      const csrfError = await validateMutationCsrf(request, env);
      if (csrfError) return csrfError;
      return updateContactSubmission(request, id, env, user.userId);
    }
    return errorResponse(405, "method_not_allowed", "Method not allowed.");
  } catch (error) {
    if (error instanceof ContactRequestError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (
      error instanceof SyntaxError ||
      (error instanceof Error &&
        (error.message.includes("request body") ||
          error.message.includes("too large")))
    ) {
      return errorResponse(
        400,
        "invalid_request",
        error instanceof Error ? error.message : "Invalid request.",
      );
    }
    console.error(
      JSON.stringify({
        event: "contact_admin_request_failed",
        path: url.pathname,
        actorId: user.userId,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    return errorResponse(
      500,
      "contact_unavailable",
      "Contact service unavailable.",
    );
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (
    !(request.headers.get("Content-Type") ?? "")
      .toLowerCase()
      .includes("application/json")
  ) {
    throw new SyntaxError("Expected a JSON request body.");
  }
  const payload = await request.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SyntaxError("Expected a JSON object.");
  }
  return payload as Record<string, unknown>;
}

function readExpectedRevision(payload: Record<string, unknown>): number {
  if (
    typeof payload.expectedRevision !== "number" ||
    !Number.isInteger(payload.expectedRevision) ||
    payload.expectedRevision < 0
  ) {
    throw new Error("Invalid expectedRevision");
  }
  return payload.expectedRevision;
}

async function authenticate(
  request: Request,
  env: CalendarBindings,
): Promise<AuthenticatedUser | null> {
  const authorization = request.headers.get("Authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = bearer ?? readCookie(request, "auth_token");
  if (!token || !env.JWT_SECRET) return null;
  const payload = await AuthManager.verifyToken(token, env.JWT_SECRET);
  return payload
    ? {
        userId: payload.userId,
        email: payload.email,
        role: payload.role,
      }
    : null;
}

async function hasCalendarPermission(
  env: CalendarBindings,
  user: AuthenticatedUser,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT users.id
     FROM users
     WHERE users.id = ? AND users.is_active = 1
       AND (
         EXISTS (
           SELECT 1
           FROM role_permissions
           JOIN permissions ON permissions.id = role_permissions.permission_id
           WHERE role_permissions.role = users.role
             AND permissions.name = ?
         )
         OR EXISTS (
           SELECT 1
           FROM user_permissions
           JOIN permissions ON permissions.id = user_permissions.permission_id
           WHERE user_permissions.user_id = users.id
             AND permissions.name = ?
         )
       )
     LIMIT 1`,
  )
    .bind(user.userId, CALENDAR_PERMISSION, CALENDAR_PERMISSION)
    .first<{ id: string }>();
  return Boolean(row);
}

async function hasAdminAccess(
  env: CalendarBindings,
  user: AuthenticatedUser,
): Promise<boolean> {
  if (user.role !== "admin") return false;
  const row = await env.DB.prepare(
    `SELECT id FROM users
     WHERE id = ? AND role = 'admin' AND is_active = 1
     LIMIT 1`,
  )
    .bind(user.userId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function ensureCsrfToken(
  request: Request,
  env: CalendarBindings,
): Promise<{ token: string; cookie: string } | Response> {
  if (!env.JWT_SECRET) {
    return errorResponse(
      500,
      "configuration_error",
      "CMS security configuration is unavailable.",
    );
  }
  const existing = readCookie(request, "csrf_token");
  const token =
    existing && (await validateCsrfToken(existing, env.JWT_SECRET))
      ? existing
      : await generateCsrfToken(env.JWT_SECRET);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return {
    token,
    cookie: `csrf_token=${encodeURIComponent(token)}; Path=/; Max-Age=86400; SameSite=Strict${secure}`,
  };
}

async function validateMutationCsrf(
  request: Request,
  env: CalendarBindings,
): Promise<Response | null> {
  const origin = request.headers.get("Origin");
  if (origin !== new URL(request.url).origin) {
    return errorResponse(403, "invalid_origin", "Request origin rejected.");
  }
  const header = request.headers.get("X-CSRF-Token");
  const cookie = readCookie(request, "csrf_token");
  if (
    !env.JWT_SECRET ||
    !header ||
    !cookie ||
    header !== cookie ||
    !(await validateCsrfToken(header, env.JWT_SECRET))
  ) {
    return errorResponse(403, "invalid_csrf", "Security token rejected.");
  }
  return null;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function adminJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": jsonContentType,
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return adminJson({ error: { code, message } }, status);
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' https://www.macon170.com; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
      "Content-Type": "text/html; charset=UTF-8",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}

function withPublicCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  appendVary(headers, "Origin");
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get("Vary");
  const values = new Set(
    (existing ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  values.add(value);
  headers.set("Vary", [...values].join(", "));
}
