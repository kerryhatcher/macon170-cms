import type { Bindings } from "@sonicjs-cms/core";
import {
  AuthManager,
  generateCsrfToken,
  validateCsrfToken,
} from "@sonicjs-cms/core/middleware";

export type McpEnv = Bindings &
  Partial<Pick<Env, "MCP_RATE_LIMITER">> & {
    JWT_SECRET: string;
    MCP_ORIGIN: string;
  };
export type Actor = { id: string; email: string; role: string };
export const scopes = ["cms:read", "cms:write", "cms:send"] as const;
export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
export function cookie(request: Request, name: string): string | null {
  const value = request.headers
    .get("Cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(name + "="))
    ?.slice(name.length + 1);
  try {
    return value ? decodeURIComponent(value) : null;
  } catch {
    return null;
  }
}
export async function browserActor(
  request: Request,
  env: McpEnv,
): Promise<Actor | null> {
  const token = cookie(request, "auth_token");
  if (!token || !env.JWT_SECRET) return null;
  const payload = await AuthManager.verifyToken(token, env.JWT_SECRET);
  return payload ? activeActor(env, payload.userId) : null;
}
export async function activeActor(
  env: McpEnv,
  id: string,
): Promise<Actor | null> {
  return env.DB.prepare(
    "SELECT id,email,role FROM users WHERE id=? AND is_active=1 AND role='admin'",
  )
    .bind(id)
    .first<Actor>();
}
export const encode = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
export const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
export const hash = async (value: string) =>
  encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export async function smallBody(
  request: Request,
  limit = 16_384,
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Request too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
export async function csrfForm(
  request: Request,
  env: McpEnv,
  form: URLSearchParams,
): Promise<boolean> {
  const token = form.get("csrf_token");
  return (
    request.headers.get("Origin") === env.MCP_ORIGIN &&
    !!token &&
    token === cookie(request, "csrf_token") &&
    (await validateCsrfToken(token, env.JWT_SECRET))
  );
}
export async function page(
  env: McpEnv,
  title: string,
  body: (csrf: string) => string,
  oauthRedirect?: string,
): Promise<Response> {
  const csrf = await generateCsrfToken(env.JWT_SECRET);
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)} | Pack 170</title><style>body{font:18px/1.6 system-ui;max-width:720px;margin:3rem auto;padding:1rem;color:#172c46;background:#fffdf5}h1{color:#003f87}button{font:inherit;padding:.6rem 1rem;background:#003f87;color:white;border:0;border-radius:6px}label{display:block;margin:1rem 0}article{border-bottom:1px solid #ccc;padding:1rem 0}a{color:#003f87}</style><h1>${escapeHtml(title)}</h1>${body(csrf)}<p><a href="/dash">CMS dashboard</a></p></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // Preserve Origin on same-origin form POSTs; suppress cross-origin referrers.
        "Referrer-Policy": "same-origin",
        "Content-Security-Policy":
          `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${oauthRedirect ? " " + new URL(oauthRedirect).origin : ""}; frame-ancestors 'none'; base-uri 'none'`,
        "X-Content-Type-Options": "nosniff",
        "Set-Cookie": `csrf_token=${encodeURIComponent(csrf)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
      },
    },
  );
}
