import { CALENDAR_PERMISSION } from "./calendar";
import { sendSignupLinkEmail, signupLinkUrl } from "./signup-email";
import {
  createSignupForm,
  deleteSignupResponse,
  getSignupFormById,
  listSignupForms,
  listSignupResponses,
  rotateResponseToken,
  updateSignupForm,
} from "./signup-store";
import {
  SIGNUP_PERMISSION,
  SIGNUP_VERSION,
  SignupConflictError,
  SignupNotFoundError,
  SignupRequestError,
  decodeSignupSegment,
  issueSignupToken,
  validateSignupFormInput,
} from "./signups";
import type { SignupBindings, SignupResponseDetail } from "./signups";

export const SIGNUP_ADMIN_BASE = "/api/signups-admin/v1";

export type SignupSummary = {
  families: number;
  attending: number;
  adults: number;
  children: number;
  unconfirmed: number;
};

export function summarizeSignupResponses(
  responses: SignupResponseDetail[],
): SignupSummary {
  return responses.reduce<SignupSummary>(
    (summary, entry) => ({
      families: summary.families + 1,
      attending: summary.attending + (entry.attending ? 1 : 0),
      adults: summary.adults + (entry.attending ? entry.adults : 0),
      children: summary.children + (entry.attending ? entry.children : 0),
      unconfirmed:
        summary.unconfirmed + (entry.status === "unconfirmed" ? 1 : 0),
    }),
    { families: 0, attending: 0, adults: 0, children: 0, unconfirmed: 0 },
  );
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function readExpectedRevision(payload: Record<string, unknown>): number {
  const value = payload.expectedRevision;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 0) {
    throw new SignupRequestError(
      400,
      "validation",
      "A valid expectedRevision is required.",
    );
  }
  return parsed;
}

export async function handleAdminSignupRequest(
  request: Request,
  env: SignupBindings,
  user: { userId: string; email: string },
  session: { csrfToken: string; cookie: string } | null,
  // Defaults true so existing tests that don't exercise this permission are
  // unaffected; request-handler.ts always passes the real value. The HTML
  // /admin/signups/new route already gates on calendar.manage, but that's a
  // UX guard, not a security boundary — this API is directly callable, so
  // the same requirement has to be enforced here too.
  canManageCalendar = true,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const relative = url.pathname.slice(SIGNUP_ADMIN_BASE.length);

  try {
    if (request.method === "GET" && relative === "/session") {
      if (!session) {
        throw new SignupRequestError(500, "temporary", "Session unavailable.");
      }
      const response = json({
        version: SIGNUP_VERSION,
        user: { id: user.userId, email: user.email },
        permission: SIGNUP_PERMISSION,
        csrfToken: session.csrfToken,
      });
      response.headers.append("Set-Cookie", session.cookie);
      return response;
    }

    if (request.method === "GET" && relative === "/forms") {
      return json({
        version: SIGNUP_VERSION,
        forms: await listSignupForms(env),
      });
    }

    if (request.method === "POST" && relative === "/forms") {
      if (!canManageCalendar) {
        throw new SignupRequestError(
          403,
          "forbidden",
          `The ${CALENDAR_PERMISSION} permission is required to attach a signup to an event.`,
        );
      }
      const input = validateSignupFormInput(
        (await request.json()) as Record<string, unknown>,
      );
      return json(
        {
          version: SIGNUP_VERSION,
          form: await createSignupForm(env, input, user.userId),
        },
        201,
      );
    }

    if (relative.startsWith("/forms/")) {
      const id = decodeSignupSegment(relative.slice("/forms/".length));
      if (!id || id.includes("/")) {
        throw new SignupRequestError(404, "not_found", "Signup not found.");
      }
      if (request.method === "GET") {
        const form = await getSignupFormById(env, id);
        if (!form) {
          throw new SignupRequestError(404, "not_found", "Signup not found.");
        }
        const responses = await listSignupResponses(env, id);
        return json({
          version: SIGNUP_VERSION,
          form,
          responses,
          summary: summarizeSignupResponses(responses),
        });
      }
      if (request.method === "PUT") {
        const payload = (await request.json()) as Record<string, unknown>;
        const expectedRevision = readExpectedRevision(payload);
        const input = validateSignupFormInput(payload);
        const existing = await getSignupFormById(env, id);
        if (!existing) {
          throw new SignupRequestError(404, "not_found", "Signup not found.");
        }
        if (input.eventId !== existing.eventId && !canManageCalendar) {
          throw new SignupRequestError(
            403,
            "forbidden",
            `The ${CALENDAR_PERMISSION} permission is required to change a signup's event.`,
          );
        }
        return json({
          version: SIGNUP_VERSION,
          form: await updateSignupForm(
            env,
            id,
            input,
            expectedRevision,
            user.userId,
          ),
        });
      }
      throw new SignupRequestError(405, "validation", "Method not allowed.");
    }

    if (relative.startsWith("/responses/")) {
      const rest = relative.slice("/responses/".length);
      const resend = rest.endsWith("/resend");
      const id = decodeSignupSegment(
        resend ? rest.slice(0, -"/resend".length) : rest,
      );
      if (!id || id.includes("/")) {
        throw new SignupRequestError(404, "not_found", "Signup not found.");
      }

      if (request.method === "DELETE" && !resend) {
        await deleteSignupResponse(env, id, user.userId);
        return json({ version: SIGNUP_VERSION, status: "deleted" });
      }
      if (request.method === "POST" && resend) {
        const target = await findResponseForResend(env, id);
        if (!target) {
          throw new SignupRequestError(404, "not_found", "Signup not found.");
        }
        const form = await getSignupFormById(env, target.formId);
        if (!form) {
          throw new SignupRequestError(404, "not_found", "Signup not found.");
        }
        const { token, tokenHash } = await issueSignupToken();
        // The response can be deleted between the lookup above and this write.
        // Sending the email anyway would report a resend that can never work.
        if (!(await rotateResponseToken(env, id, tokenHash, user.userId))) {
          throw new SignupRequestError(404, "not_found", "Signup not found.");
        }
        await sendSignupLinkEmail(
          env,
          { email: target.email, name: target.familyName },
          {
            name: target.familyName,
            formTitle: form.title,
            linkUrl: signupLinkUrl(env, token),
            closesAt: form.closesAt,
          },
          fetchImpl,
        );
        return json({ version: SIGNUP_VERSION, status: "resent" });
      }
      throw new SignupRequestError(405, "validation", "Method not allowed.");
    }

    throw new SignupRequestError(404, "not_found", "Signup not found.");
  } catch (error) {
    if (error instanceof SignupRequestError) {
      return json(
        {
          version: SIGNUP_VERSION,
          error: { code: error.code, message: error.message },
        },
        error.status,
      );
    }
    if (error instanceof SignupConflictError) {
      return json(
        { version: SIGNUP_VERSION, error: { code: "conflict", message: error.message } },
        409,
      );
    }
    if (error instanceof SignupNotFoundError) {
      return json(
        {
          version: SIGNUP_VERSION,
          error: { code: "not_found", message: "Signup not found." },
        },
        404,
      );
    }
    console.error(
      JSON.stringify({
        event: "signup_admin_request_failed",
        path: url.pathname,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    return json(
      {
        version: SIGNUP_VERSION,
        error: { code: "temporary", message: "Signup service unavailable." },
      },
      500,
    );
  }
}

async function findResponseForResend(
  env: SignupBindings,
  id: string,
): Promise<SignupResponseDetail | null> {
  const row = await env.DB.prepare(
    `SELECT form_id FROM signup_responses WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<{ form_id: string }>();
  if (!row) return null;
  const responses = await listSignupResponses(env, row.form_id);
  return responses.find((entry) => entry.id === id) ?? null;
}
