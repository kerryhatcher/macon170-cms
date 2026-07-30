import type { Bindings } from "@sonicjs-cms/core";

import { renderLoginPage } from "./login-page";
import {
  publishedCalendarProjection,
  validateCalendarData,
} from "./calendar-projection";

type CmsAppFetch = (
  request: Request,
  env: Bindings,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

const disabledAuthPaths = new Set([
  "/auth/seed-admin",
  "/auth/register",
  "/auth/register/form",
]);

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
  return async (request, env, ctx) => {
    const url = new URL(request.url);
    const { pathname } = url;
    if (disabledAuthPaths.has(pathname)) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // This DTO is deliberately separate from SonicJS's general content API.
    // It is the only unauthenticated calendar surface and contains published
    // records only, in the contract consumed by the public Worker adapter.
    if (
      request.method === "GET" &&
      pathname === "/api/calendar-projection/v1"
    ) {
      try {
        const events = await publishedCalendarProjection(env);
        return Response.json(
          { version: "v1", events },
          { headers: { "Cache-Control": "no-store" } },
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "calendar_projection_failed",
            error: error instanceof Error ? error.message : "Unknown error",
          }),
        );
        return Response.json(
          { error: "Calendar projection unavailable" },
          { status: 500, headers: { "Cache-Control": "no-store" } },
        );
      }
    }

    if (request.method === "GET" && pathname === "/auth/login") {
      return new Response(renderLoginPage(url), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'self'; img-src 'self' https://www.macon170.com; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
          "Content-Type": "text/html; charset=UTF-8",
          "Referrer-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "SAMEORIGIN",
        },
      });
    }

    const validatedRequest = await validateCalendarWrite(request, env);
    if (validatedRequest instanceof Response) return validatedRequest;
    const response = await appFetch(validatedRequest, env, ctx);
    const origin = request.headers.get("Origin");
    if (
      origin &&
      configuredCorsOrigins(env).has(origin) &&
      pathname.startsWith("/api/collections/")
    ) {
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", origin);
      headers.append("Vary", "Origin");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    return response;
  };
}

/**
 * SonicJS supplies authentication and publication workflow. This guard adds
 * Pack-specific field validation before its authenticated content routes write
 * a calendar record. It intentionally does not add a second public write API.
 */
async function validateCalendarWrite(
  request: Request,
  env: Bindings,
): Promise<Request | Response> {
  if (
    !["POST", "PUT"].includes(request.method) ||
    !(
      /^\/api\/content(?:\/[^/]+)?$/.test(new URL(request.url).pathname) ||
      /^\/admin\/api\/content(?:\/[^/]+)?$/.test(new URL(request.url).pathname)
    )
  )
    return request;
  if (
    !(request.headers.get("content-type") ?? "")
      .toLowerCase()
      .includes("application/json")
  )
    return request;
  let payload: Record<string, unknown>;
  try {
    payload = (await request.clone().json()) as Record<string, unknown>;
  } catch {
    return request;
  }
  const pathname = new URL(request.url).pathname;
  const contentId = pathname.split("/").at(-1);
  const existing =
    contentId && contentId !== "content"
      ? await env.DB.prepare(
          `SELECT content.data, collections.name FROM content JOIN collections ON collections.id = content.collection_id WHERE content.id = ?`,
        )
          .bind(contentId)
          .first<{ data: string; name: string }>()
      : null;
  const collectionId = payload.collectionId ?? payload.collection_id;
  const collection =
    typeof collectionId === "string"
      ? await env.DB.prepare("SELECT name FROM collections WHERE id = ?")
          .bind(collectionId)
          .first<{ name: string }>()
      : null;
  if (
    existing?.name !== "calendar-event" &&
    collection?.name !== "calendar-event"
  )
    return request;

  const data = (
    payload.data && typeof payload.data === "object" ? payload.data : payload
  ) as Record<string, unknown>;
  // SonicJS stores slug/title in columns while collection fields live in data.
  if (typeof payload.slug === "string") data.slug = payload.slug;
  if (typeof payload.title === "string") data.title = payload.title;
  const prior = existing
    ? (JSON.parse(existing.data) as Record<string, unknown>)
    : null;
  if (prior) {
    if (data.legacyEventId !== prior.legacyEventId)
      return Response.json(
        { error: "legacyEventId is immutable." },
        { status: 400 },
      );
    data.adapterRevision = Number(prior.adapterRevision ?? 0) + 1;
  }
  try {
    validateCalendarData(data);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Invalid calendar event.",
      },
      { status: 400 },
    );
  }
  if (typeof data.slug === "string") {
    const duplicate = await env.DB.prepare(
      `SELECT content.id FROM content JOIN collections ON collections.id = content.collection_id WHERE collections.name = 'calendar-event' AND content.slug = ? ${existing ? "AND content.id != ?" : ""} LIMIT 1`,
    )
      .bind(data.slug, ...(existing ? [contentId] : []))
      .first();
    if (duplicate)
      return Response.json(
        { error: "Another event already uses that URL slug." },
        { status: 409 },
      );
  }
  payload.data = data;
  return new Request(request, { body: JSON.stringify(payload) });
}
