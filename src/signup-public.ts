import { sendSignupLinkEmail, signupLinkUrl } from "./signup-email";
import {
  confirmSignupResponse,
  createSignupResponse,
  deleteSignupResponse,
  findResponseIdByEmail,
  getPublicSignupForm,
  getResponseByTokenHash,
  getSignupFormBySlug,
  rotateResponseToken,
  updateSignupResponse,
} from "./signup-store";
import {
  SIGNUP_BODY_LIMIT,
  SIGNUP_VERSION,
  SignupConflictError,
  SignupRequestError,
  SignupSlotFullError,
  decodeSignupSegment,
  hashSignupToken,
  isSignupClosed,
  issueSignupToken,
  validateSignupResponseInput,
} from "./signups";
import type { SignupBindings, SignupFormDetail } from "./signups";

const formsPrefix = "/api/signups/v1/forms/";
const responsesPrefix = "/api/signups/v1/responses/";

export function isPublicSignupPath(pathname: string): boolean {
  return (
    pathname.startsWith(formsPrefix) || pathname.startsWith(responsesPrefix)
  );
}

function publicOrigin(env: SignupBindings): string {
  return env.PUBLIC_SITE_ORIGIN ?? "https://www.macon170.com";
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorJson(status: number, code: string, message: string): Response {
  return json({ version: SIGNUP_VERSION, error: { code, message } }, status);
}

function cors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  headers.set("Vary", "Origin");
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const notFound = () =>
  new SignupRequestError(404, "not_found", "Signup not found.");

function requirePhone(env: SignupBindings): boolean {
  return env.SIGNUP_REQUIRE_PHONE?.toLowerCase() === "true";
}

// The token routes carry the bearer credential in the path itself. Never log
// a raw pathname from this module — route every log line through here so a
// future log statement can't reintroduce the leak.
function redactedPath(pathname: string): string {
  return pathname.startsWith(responsesPrefix)
    ? `${responsesPrefix}:token`
    : pathname;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > SIGNUP_BODY_LIMIT) {
    throw new SignupRequestError(413, "validation", "That request is too large.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > SIGNUP_BODY_LIMIT) {
    throw new SignupRequestError(413, "validation", "That request is too large.");
  }
  if (!raw) return {};
  const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      throw new SignupRequestError(400, "validation", "Invalid request body.");
    }
  }
  const params = new URLSearchParams(raw);
  const body: Record<string, unknown> = {};
  for (const [key, value] of params) body[key] = value;
  if (typeof body.claims === "string") {
    try {
      body.claims = JSON.parse(body.claims);
    } catch {
      throw new SignupRequestError(400, "validation", "Invalid claims.");
    }
  }
  return body;
}

async function verifyTurnstile(
  token: string,
  request: Request,
  env: SignupBindings,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!env.TURNSTILE_SECRET) {
    // Fail closed, but say so in the logs: without this line a missing secret
    // is indistinguishable from a Turnstile outage to whoever is on call.
    console.error(
      JSON.stringify({ event: "signup_turnstile_secret_missing" }),
    );
    throw new SignupRequestError(
      503,
      "temporary",
      "The signup service is temporarily unavailable.",
    );
  }
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.append("remoteip", ip);

  let outcome: {
    success?: boolean;
    action?: string;
    hostname?: string;
  };
  try {
    const verification = await fetchImpl(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body },
    );
    outcome = (await verification.json()) as typeof outcome;
  } catch {
    throw new SignupRequestError(
      503,
      "temporary",
      "The security check could not be completed. Try again.",
    );
  }

  const expectedAction = env.TURNSTILE_EXPECTED_ACTION ?? "turnstile-spin-v2";
  const hostnames = new Set(
    (env.TURNSTILE_EXPECTED_HOSTNAMES ?? "macon170.com,www.macon170.com")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  // Both checks fail closed: a siteverify response missing action or
  // hostname is a failure, not a skip. `outcome.action && ...` would let a
  // token verified without that metadata sail through silently.
  if (
    !outcome.success ||
    outcome.action !== expectedAction ||
    !outcome.hostname ||
    !hostnames.has(outcome.hostname)
  ) {
    throw new SignupRequestError(
      403,
      "security",
      "The security check did not pass. Reload the page and try again.",
    );
  }
}

async function requireOpenForm(
  env: SignupBindings,
  slug: string,
): Promise<SignupFormDetail> {
  const form = await getSignupFormBySlug(env, slug);
  if (!form || form.state === "draft") throw notFound();
  if (isSignupClosed(form)) {
    throw new SignupRequestError(
      409,
      "validation",
      "This signup is closed.",
    );
  }
  return form;
}

export async function handlePublicSignupRequest(
  request: Request,
  env: SignupBindings,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const allowed = publicOrigin(env);
  const corsOrigin = origin === allowed ? origin : null;

  try {
    if (request.method === "OPTIONS") {
      if (!corsOrigin) {
        throw new SignupRequestError(403, "security", "Request origin rejected.");
      }
      return cors(
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
            "Access-Control-Max-Age": "600",
            "Cache-Control": "no-store",
          },
        }),
        corsOrigin,
      );
    }

    // Reading a public form is safe cross-origin; every write requires the
    // configured public site origin.
    if (request.method !== "GET" && !corsOrigin) {
      throw new SignupRequestError(403, "security", "Request origin rejected.");
    }

    if (url.pathname.startsWith(responsesPrefix)) {
      return cors(
        await handleResponseRoute(request, env, url),
        corsOrigin,
      );
    }

    const rest = url.pathname.slice(formsPrefix.length);
    if (rest.endsWith("/responses")) {
      if (request.method !== "POST") {
        throw new SignupRequestError(405, "validation", "Method not allowed.");
      }
      return cors(
        await handleSubmission(
          request,
          env,
          decodeSignupSegment(rest.slice(0, -"/responses".length)),
          fetchImpl,
        ),
        corsOrigin,
      );
    }
    if (request.method !== "GET") {
      throw new SignupRequestError(405, "validation", "Method not allowed.");
    }
    const form = await getPublicSignupForm(env, decodeSignupSegment(rest));
    if (!form) throw notFound();
    return cors(json({ version: SIGNUP_VERSION, form }), corsOrigin);
  } catch (error) {
    if (error instanceof SignupRequestError) {
      return cors(
        errorJson(error.status, error.code, error.message),
        corsOrigin,
      );
    }
    console.error(
      JSON.stringify({
        event: "signup_public_request_failed",
        path: redactedPath(url.pathname),
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    return cors(
      errorJson(503, "temporary", "The signup service is temporarily unavailable."),
      corsOrigin,
    );
  }
}

async function handleSubmission(
  request: Request,
  env: SignupBindings,
  slug: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const raw = await readBody(request);

  // A filled honeypot gets the same success shape and touches nothing.
  if (typeof raw.website === "string" && raw.website.trim() !== "") {
    return json({ version: SIGNUP_VERSION, status: "emailed" }, 201);
  }

  const form = await requireOpenForm(env, slug);
  const input = validateSignupResponseInput(raw, form, requirePhone(env));

  const token =
    typeof raw["cf-turnstile-response"] === "string"
      ? raw["cf-turnstile-response"]
      : typeof raw.turnstile === "string"
        ? raw.turnstile
        : "";
  if (!token) {
    throw new SignupRequestError(
      400,
      "security",
      "Complete the security check before submitting.",
    );
  }

  // Two buckets, both of which must have budget. The email-plus-IP key alone
  // is attacker-resettable: the email comes from the request body, so varying
  // it hands out a fresh bucket on every request. The IP-only key is the one
  // that actually caps volume from a single source; the per-email key still
  // slows a flood aimed at one address from many sources.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const rateKeys = await Promise.all([
    hashSignupToken(ip),
    hashSignupToken(`${input.email}|${ip}`),
  ]);
  for (const key of rateKeys) {
    const limit = await env.SIGNUP_RATE_LIMITER.limit({ key });
    if (!limit.success) {
      throw new SignupRequestError(
        429,
        "rate_limit",
        "Too many signups were submitted. Wait a minute and try again.",
      );
    }
  }

  await verifyTurnstile(token, request, env, fetchImpl);

  const ipHash = await hashSignupToken(
    request.headers.get("CF-Connecting-IP") ?? "unknown",
  );

  // Exactly one token is minted per submission. A first-time submit stores its
  // hash on the new row; a repeat submit rotates the existing row's hash. Both
  // paths then email that same token, so there is never a link whose hash was
  // not persisted.
  const { token: signupToken, tokenHash } = await issueSignupToken();
  const existingId = await findResponseIdByEmail(env, form.id, input.email);
  let responseId: string;

  if (existingId) {
    responseId = existingId;
    // A false rotation means the row was deleted between the lookup and the
    // write. Emailing the link anyway would hand the family a link that can
    // never resolve while reporting success.
    if (!(await rotateResponseToken(env, responseId, tokenHash, null))) {
      throw notFound();
    }
  } else {
    try {
      responseId = await createSignupResponse(
        env,
        form,
        input,
        tokenHash,
        ipHash,
      );
    } catch (error) {
      if (error instanceof SignupSlotFullError) {
        return slotFullResponse(env, slug);
      }
      if (error instanceof SignupConflictError) {
        // Lost a race against a simultaneous first submit for this email.
        // Treat it as a repeat submit so the family still receives a link.
        const raced = await findResponseIdByEmail(env, form.id, input.email);
        if (!raced) throw error;
        responseId = raced;
        if (!(await rotateResponseToken(env, responseId, tokenHash, null))) {
          throw notFound();
        }
      } else {
        throw error;
      }
    }
  }

  try {
    await sendSignupLinkEmail(
      env,
      { email: input.email, name: input.familyName },
      {
        name: input.familyName,
        formTitle: form.title,
        linkUrl: signupLinkUrl(env, signupToken),
        closesAt: form.closesAt,
      },
      fetchImpl,
    );
  } catch {
    // The row is kept deliberately. A repeat submit rotates the token and
    // resends, so the flow heals itself and no signup is lost.
    throw new SignupRequestError(
      502,
      "temporary",
      "Your signup was saved, but the email could not be sent. Submit again to resend the link.",
    );
  }

  return json({ version: SIGNUP_VERSION, status: "emailed" }, 201);
}

async function slotFullResponse(
  env: SignupBindings,
  slug: string,
): Promise<Response> {
  return json(
    {
      version: SIGNUP_VERSION,
      error: {
        code: "slot_full",
        message: "Someone just claimed that item. Pick another.",
      },
      form: await getPublicSignupForm(env, slug),
    },
    409,
  );
}

async function handleResponseRoute(
  request: Request,
  env: SignupBindings,
  url: URL,
): Promise<Response> {
  const rawToken = url.pathname.slice(responsesPrefix.length);
  if (!rawToken || rawToken.includes("/")) throw notFound();
  const detail = await getResponseByTokenHash(
    env,
    await hashSignupToken(decodeSignupSegment(rawToken)),
  );
  if (!detail) throw notFound();

  if (detail.status === "unconfirmed") {
    await confirmSignupResponse(env, detail.id);
    detail.status = "confirmed";
  }

  if (request.method === "GET") {
    return json({ version: SIGNUP_VERSION, response: detail });
  }
  if (request.method === "DELETE") {
    await deleteSignupResponse(env, detail.id, null);
    return json({ version: SIGNUP_VERSION, status: "withdrawn" });
  }
  if (request.method !== "PATCH") {
    throw new SignupRequestError(405, "validation", "Method not allowed.");
  }

  const form = await requireOpenForm(env, detail.formSlug);
  const input = validateSignupResponseInput(
    { ...(await readBody(request)), email: detail.email },
    form,
    requirePhone(env),
  );
  try {
    await updateSignupResponse(env, detail.id, input);
  } catch (error) {
    if (error instanceof SignupSlotFullError) {
      return slotFullResponse(env, detail.formSlug);
    }
    throw error;
  }
  const updated = await getResponseByTokenHash(
    env,
    await hashSignupToken(decodeSignupSegment(rawToken)),
  );
  return json({ version: SIGNUP_VERSION, response: updated });
}
