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
      const id = decodeURIComponent(relative.slice("/forms/".length));
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
      const id = decodeURIComponent(
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
        await rotateResponseToken(env, id, tokenHash, user.userId);
        await sendSignupLinkEmail(
          env,
          { email: target.email, name: target.familyName },
          {
            familyName: target.familyName,
            formTitle: form.title,
            linkUrl: signupLinkUrl(env, token),
            closesAt: form.closesAt,
          },
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
