import { describe, expect, it, vi } from "vitest";

import {
  handlePublicSignupRequest,
  isPublicSignupPath,
} from "./signup-public";
import { hashSignupToken } from "./signups";
import type { SignupBindings } from "./signups";

const publicOrigin = "https://www.macon170.com";

const openFormRow = {
  id: "frm-1",
  revision: 0,
  slug: "lego-derby-food",
  event_id: "evt-1",
  form_type: "items",
  title: "Lego Derby food",
  instructions: "",
  state: "open",
  closes_at: null,
  created_at: 1,
  updated_at: 1,
};

const slotRow = {
  id: "slt-1",
  form_id: "frm-1",
  position: 0,
  label: "Hot dog buns",
  quantity_needed: 3,
  notes: null,
  created_at: 1,
  updated_at: 1,
  quantity_claimed: 0,
};

// The stub answers by statement shape so submission tests reach the control
// they are actually asserting on instead of 404-ing at the form lookup.
function stubDb(options: {
  form?: Record<string, unknown> | null;
  existingResponseId?: string | null;
  batch?: ReturnType<typeof vi.fn>;
} = {}) {
  const form = options.form === undefined ? openFormRow : options.form;
  const batch = options.batch ?? vi.fn().mockResolvedValue([]);
  return {
    prepare: (sql: string) => ({
      sql,
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      first: async () => {
        if (sql.includes("FROM signup_forms")) return form;
        if (sql.includes("FROM signup_responses")) {
          return options.existingResponseId
            ? { id: options.existingResponseId }
            : null;
        }
        return null;
      },
      all: async () => ({
        results: sql.includes("FROM signup_slots") ? [slotRow] : [],
      }),
    }),
    batch,
  };
}

function baseEnv(overrides: Record<string, unknown> = {}) {
  return {
    PUBLIC_SITE_ORIGIN: publicOrigin,
    TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
    TURNSTILE_EXPECTED_ACTION: "turnstile-spin-v2",
    TURNSTILE_EXPECTED_HOSTNAMES: "www.macon170.com",
    INVITE_FROM_EMAIL: "volunteers@macon170.com",
    INVITE_FROM_NAME: "Pack 170 Volunteers",
    SIGNUP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    EMAIL: { send: vi.fn().mockResolvedValue(undefined) },
    DB: stubDb(),
    ...overrides,
  } as unknown as SignupBindings;
}

const validSubmission = {
  email: "parent@example.com",
  familyName: "Hatcher",
  adults: 2,
  children: 1,
  claims: [{ slotId: "slt-1", quantity: 1 }],
  turnstile: "turnstile-token",
};

function submit(body: Record<string, unknown>, origin = publicOrigin) {
  return new Request(
    "https://cms.macon170.com/api/signups/v1/forms/lego-derby-food/responses",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    },
  );
}

// A factory, not mockResolvedValue: a Response body can only be read once,
// and this mock is reused by many submission tests across the file. Handing
// out the same already-consumed Response on a second call would make later
// tests fail on an unrelated "body already read" error instead of the
// behavior they are actually asserting on.
const turnstileOk = vi.fn(() =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        success: true,
        action: "turnstile-spin-v2",
        hostname: "www.macon170.com",
      }),
    ),
  ),
);

describe("public signup routing", () => {
  it("claims only its own paths", () => {
    expect(isPublicSignupPath("/api/signups/v1/forms/x")).toBe(true);
    expect(isPublicSignupPath("/api/signups/v1/responses/abc")).toBe(true);
    expect(isPublicSignupPath("/api/calendar/v1/events")).toBe(false);
    expect(isPublicSignupPath("/api/signups-admin/v1/forms")).toBe(false);
  });

  it("rejects a foreign origin as security", async () => {
    const response = await handlePublicSignupRequest(
      submit({}, "https://evil.example"),
      baseEnv(),
      turnstileOk,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "security" },
    });
  });

  it("returns a generic 404 for an unknown token", async () => {
    const request = new Request(
      "https://cms.macon170.com/api/signups/v1/responses/deadbeef",
      { headers: { Origin: publicOrigin } },
    );
    const response = await handlePublicSignupRequest(
      request,
      baseEnv(),
      turnstileOk,
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toBe("Signup not found.");
  });

  it("never logs the raw token when a token route fails unexpectedly", async () => {
    const secretToken = "super-secret-magic-link-token";
    const db = {
      prepare: (sql: string) => ({
        bind() {
          return this;
        },
        first: async () => {
          if (sql.includes("FROM signup_responses")) {
            // Not a SignupRequestError: exercises the generic catch-all,
            // which is the branch that used to log the raw request path.
            throw new Error("D1 is unavailable");
          }
          return null;
        },
        all: async () => ({ results: [] }),
      }),
      batch: vi.fn(),
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handlePublicSignupRequest(
        new Request(
          `https://cms.macon170.com/api/signups/v1/responses/${secretToken}`,
          { headers: { Origin: publicOrigin } },
        ),
        baseEnv({ DB: db }),
        turnstileOk,
      );
      expect(response.status).toBe(503);
      const logged = errorSpy.mock.calls.flat().join("\n");
      expect(logged).not.toContain(secretToken);
      expect(logged).toContain("/api/signups/v1/responses/:token");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("confirms an unconfirmed response on the first valid token use", async () => {
    const batch = vi.fn().mockResolvedValue([]);
    // confirmSignupResponse runs its guarded UPDATE and the follow-up audit
    // insert as two direct .run() calls, not a .batch() (see signup-store.ts)
    // — so the assertion below inspects the SQL handed to .prepare(), not to
    // .batch(), which this stub's db never receives on this path.
    const preparedSql: string[] = [];
    const db = {
      prepare: (sql: string) => {
        preparedSql.push(sql);
        return {
          sql,
          bind() {
            return this;
          },
          first: async () =>
            sql.includes("FROM signup_responses")
              ? {
                  id: "rsp-1",
                  form_id: "frm-1",
                  email: "parent@example.com",
                  family_name: "Hatcher",
                  attending: 1,
                  adults: 2,
                  children: 1,
                  dietary_notes: null,
                  status: "unconfirmed",
                  confirmed_at: null,
                  created_at: 1,
                  updated_at: 1,
                  form_slug: "lego-derby-food",
                  form_title: "Lego Derby food",
                  form_type: "items",
                }
              : null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch,
    };
    const response = await handlePublicSignupRequest(
      new Request(
        "https://cms.macon170.com/api/signups/v1/responses/some-token",
        { headers: { Origin: publicOrigin } },
      ),
      baseEnv({ DB: db }),
      turnstileOk,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: { status: "confirmed" },
    });
    const sql = preparedSql.join("\n");
    // The guarded UPDATE is what makes confirmation idempotent.
    expect(sql).toContain("status = 'confirmed'");
    expect(sql).toContain("AND status = 'unconfirmed'");
  });

  it("accepts and discards a honeypot submission without touching the database", async () => {
    const env = baseEnv();
    const response = await handlePublicSignupRequest(
      submit({ website: "http://spam.example", email: "a@b.co" }),
      env,
      turnstileOk,
    );
    expect(response.status).toBe(201);
    expect((env.DB as unknown as { batch: ReturnType<typeof vi.fn> }).batch)
      .not.toHaveBeenCalled();
  });

  it("returns rate_limit when the limiter rejects", async () => {
    const env = baseEnv({
      SIGNUP_RATE_LIMITER: { limit: async () => ({ success: false }) },
    });
    const response = await handlePublicSignupRequest(
      submit(validSubmission),
      env,
      turnstileOk,
    );
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "rate_limit" },
    });
  });

  it("rejects a submission with no Turnstile token", async () => {
    const { turnstile, ...withoutToken } = validSubmission;
    const response = await handlePublicSignupRequest(
      submit(withoutToken),
      baseEnv(),
      turnstileOk,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "security" },
    });
  });

  it("rejects a submission when Turnstile does not pass", async () => {
    const failing = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: false })));
    const response = await handlePublicSignupRequest(
      submit(validSubmission),
      baseEnv(),
      failing,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "security" },
    });
  });

  it("rejects a Turnstile response missing the action field (fails closed)", async () => {
    const missingAction = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, hostname: "www.macon170.com" }),
        ),
      );
    const response = await handlePublicSignupRequest(
      submit(validSubmission),
      baseEnv(),
      missingAction,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "security" },
    });
  });

  it("rejects a Turnstile response missing the hostname field (fails closed)", async () => {
    const missingHostname = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, action: "turnstile-spin-v2" }),
        ),
      );
    const response = await handlePublicSignupRequest(
      submit(validSubmission),
      baseEnv(),
      missingHostname,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "security" },
    });
  });

  it("refuses a submission to a closed form", async () => {
    const env = baseEnv({
      DB: stubDb({ form: { ...openFormRow, state: "closed" } }),
    });
    const response = await handlePublicSignupRequest(
      submit(validSubmission),
      env,
      turnstileOk,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "This signup is closed." },
    });
  });

  it("refuses a submission to a form past its deadline", async () => {
    const env = baseEnv({
      DB: stubDb({
        form: { ...openFormRow, closes_at: "2000-01-01T00:00:00.000Z" },
      }),
    });
    const response = await handlePublicSignupRequest(
      submit(validSubmission),
      env,
      turnstileOk,
    );
    expect(response.status).toBe(409);
  });

  it("404s a submission to a draft form", async () => {
    const env = baseEnv({
      DB: stubDb({ form: { ...openFormRow, state: "draft" } }),
    });
    const response = await handlePublicSignupRequest(
      submit(validSubmission),
      env,
      turnstileOk,
    );
    expect(response.status).toBe(404);
  });

  it("creates a response and emails exactly one link on a first submit", async () => {
    const env = baseEnv();
    const response = await handlePublicSignupRequest(
      submit(validSubmission),
      env,
      turnstileOk,
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      status: "emailed",
    });
    const email = (env as unknown as { EMAIL: { send: ReturnType<typeof vi.fn> } })
      .EMAIL.send;
    expect(email).toHaveBeenCalledOnce();
    expect(email.mock.calls[0][0].to.email).toBe("parent@example.com");
  });

  it("resends the link for an email that already responded, without a second row", async () => {
    const batch = vi.fn().mockResolvedValue([]);
    const env = baseEnv({
      DB: stubDb({ existingResponseId: "rsp-1", batch }),
    });
    const response = await handlePublicSignupRequest(
      submit(validSubmission),
      env,
      turnstileOk,
    );

    // Same neutral shape as a first-time submit: the endpoint must not reveal
    // that this address had already signed up.
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      status: "emailed",
    });
    const sql = batch.mock.calls
      .flat(2)
      .map((statement: { sql?: string }) => statement.sql ?? "")
      .join("\n");
    expect(sql).toContain("UPDATE signup_responses SET token_hash");
    expect(sql).not.toContain("INSERT INTO signup_responses");
  });

  it("rate limits on the connecting IP even when the email keeps changing", async () => {
    // The email arrives in the request body, so a key built from it is
    // attacker-resettable. The IP-only bucket has to be consulted and
    // enforced on its own.
    const ipKey = await hashSignupToken("203.0.113.9");
    const limit = vi.fn(async ({ key }: { key: string }) => ({
      success: key !== ipKey,
    }));
    const request = new Request(
      "https://cms.macon170.com/api/signups/v1/forms/lego-derby-food/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: publicOrigin,
          "CF-Connecting-IP": "203.0.113.9",
        },
        body: JSON.stringify({
          ...validSubmission,
          email: "never-seen-before@example.com",
        }),
      },
    );
    const response = await handlePublicSignupRequest(
      request,
      baseEnv({ SIGNUP_RATE_LIMITER: { limit } }),
      turnstileOk,
    );
    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: ipKey });
  });

  it("reports 502 when the response saved but the email failed", async () => {
    const env = baseEnv({
      EMAIL: { send: vi.fn().mockRejectedValue(new Error("sender rejected")) },
    });
    const response = await handlePublicSignupRequest(
      submit(validSubmission),
      env,
      turnstileOk,
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "temporary" },
    });
  });

  it("rejects an oversized body", async () => {
    const request = new Request(
      "https://cms.macon170.com/api/signups/v1/forms/lego-derby-food/responses",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: publicOrigin },
        body: JSON.stringify({ familyName: "x".repeat(9_000) }),
      },
    );
    const response = await handlePublicSignupRequest(
      request,
      baseEnv(),
      turnstileOk,
    );
    expect(response.status).toBe(413);
  });

  it("answers a CORS preflight for the public site only", async () => {
    const preflight = new Request(
      "https://cms.macon170.com/api/signups/v1/forms/lego-derby-food/responses",
      { method: "OPTIONS", headers: { Origin: publicOrigin } },
    );
    const response = await handlePublicSignupRequest(
      preflight,
      baseEnv(),
      turnstileOk,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      publicOrigin,
    );
  });
});
