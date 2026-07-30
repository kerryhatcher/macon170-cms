import { describe, expect, it, vi } from "vitest";

import {
  type ContactBindings,
  getContactSubmission,
  handleContactSubmission,
  listContactSubmissions,
  runContactRetention,
  updateContactSubmission,
  validateContactInput,
} from "./contact";

type Prepared = {
  sql: string;
  values: unknown[];
  bind: (...values: unknown[]) => Prepared;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
  run: () => Promise<{ success: boolean }>;
};

function contactEnv(options: {
  rateLimitSuccess?: boolean;
  formExists?: boolean;
  secret?: string;
} = {}) {
  const prepared: Prepared[] = [];
  const batches: Prepared[][] = [];
  const db = {
    prepare(sql: string): Prepared {
      const statement: Prepared = {
        sql,
        values: [],
        bind(...values: unknown[]) {
          this.values = values;
          return this;
        },
        async first<T>() {
          if (sql.includes("FROM forms")) {
            return (options.formExists === false
              ? null
              : {
                  id: "default-contact-form",
                  name: "contact",
                  display_name: "Pack 170 parent contact form",
                }) as T | null;
          }
          return null;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          return { success: true };
        },
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements: Prepared[]) {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };
  const rateLimiter = {
    limit: vi.fn(async () => ({
      success: options.rateLimitSuccess ?? true,
    })),
  };
  const env = {
    DB: db,
    CONTACT_RATE_LIMITER: rateLimiter,
    CORS_ORIGINS: "https://www.macon170.com",
    PUBLIC_SITE_ORIGIN: "https://www.macon170.com",
    TURNSTILE_EXPECTED_ACTION: "turnstile-spin-v2",
    TURNSTILE_EXPECTED_HOSTNAMES: "macon170.com,www.macon170.com",
    TURNSTILE_SECRET:
      options.secret === undefined ? "test-turnstile-secret" : options.secret,
    ENVIRONMENT: "production",
  } as unknown as ContactBindings;
  return { env, prepared, batches, rateLimiter };
}

function validPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    parentName: "Jordan Parent",
    email: "jordan@example.com",
    phone: "478-555-0100",
    childGrade: "3rd grade",
    topic: "Planning a first visit",
    message: "We would like to visit the next confirmed pack meeting.",
    "cf-turnstile-response": "turnstile-token-that-must-not-be-stored",
    ...overrides,
  };
}

function jsonRequest(
  payload: Record<string, unknown>,
  origin = "https://www.macon170.com",
) {
  return new Request(
    "https://cms.macon170.com/api/forms/contact/submit",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ data: payload }),
    },
  );
}

const successfulTurnstile = vi.fn<typeof fetch>(async () =>
  Response.json({
    success: true,
    hostname: "www.macon170.com",
    action: "turnstile-spin-v2",
    challenge_ts: "2026-07-30T00:00:00.000Z",
  }),
);

describe("contact validation", () => {
  it("normalizes valid input without carrying security-only fields", () => {
    expect(
      validateContactInput(
        validPayload({
          parentName: "  Jordan Parent  ",
          message: "Line one.\r\nLine two.",
        }),
      ),
    ).toEqual({
      parentName: "Jordan Parent",
      email: "jordan@example.com",
      phone: "478-555-0100",
      childGrade: "3rd grade",
      topic: "Planning a first visit",
      message: "Line one.\nLine two.",
    });
  });

  it.each([
    [{ parentName: "J" }, "Parent or guardian name"],
    [{ email: "not-an-email" }, "valid parent or guardian email"],
    [{ childGrade: "College" }, "valid grade"],
    [{ topic: "Unknown" }, "valid topic"],
    [{ message: "short" }, "Question"],
    [{ message: "x".repeat(4_001) }, "too long"],
  ])("rejects a validation boundary: %o", (override, message) => {
    expect(() => validateContactInput(validPayload(override))).toThrow(
      message,
    );
  });

  it("rejects an actual body larger than 24 KB", async () => {
    const { env } = contactEnv();
    const response = await handleContactSubmission(
      jsonRequest(validPayload({ padding: "x".repeat(25_000) })),
      env,
      successfulTurnstile,
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "validation" },
    });
  });
});

describe("contact origin, honeypot, and rate limiting", () => {
  it("returns CORS headers for the configured preflight origin", async () => {
    const { env } = contactEnv();
    const response = await handleContactSubmission(
      new Request(
        "https://cms.macon170.com/api/forms/contact/submit",
        {
          method: "OPTIONS",
          headers: { Origin: "https://www.macon170.com" },
        },
      ),
      env,
      successfulTurnstile,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://www.macon170.com",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST",
    );
  });

  it("rejects an unconfigured origin without storage", async () => {
    const { env, batches } = contactEnv();
    const response = await handleContactSubmission(
      jsonRequest(validPayload(), "https://attacker.example"),
      env,
      successfulTurnstile,
    );
    expect(response.status).toBe(403);
    expect(batches).toHaveLength(0);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("silently accepts a filled honeypot without rate limiting or storage", async () => {
    const { env, batches, rateLimiter } = contactEnv();
    const response = await handleContactSubmission(
      jsonRequest(validPayload({ website: "https://spam.example" })),
      env,
      successfulTurnstile,
    );
    expect(response.status).toBe(201);
    expect(batches).toHaveLength(0);
    expect(rateLimiter.limit).not.toHaveBeenCalled();
  });

  it("returns a structured rate-limit error before verification", async () => {
    const { env, batches } = contactEnv({ rateLimitSuccess: false });
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await handleContactSubmission(
      jsonRequest(validPayload()),
      env,
      fetchImpl,
    );
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "rate_limit" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(batches).toHaveLength(0);
  });
});

describe("Turnstile enforcement", () => {
  it("rejects a missing token without creating a record", async () => {
    const { env, batches } = contactEnv();
    const payload = validPayload();
    delete payload["cf-turnstile-response"];
    const response = await handleContactSubmission(
      jsonRequest(payload),
      env,
      successfulTurnstile,
    );
    expect(response.status).toBe(400);
    expect(batches).toHaveLength(0);
  });

  it.each([
    [
      "missing secret",
      contactEnv({ secret: "" }).env,
      successfulTurnstile,
      503,
      "temporary",
    ],
    [
      "network failure",
      contactEnv().env,
      vi.fn<typeof fetch>(async () => {
        throw new Error("network down");
      }),
      503,
      "temporary",
    ],
    [
      "non-OK response",
      contactEnv().env,
      vi.fn<typeof fetch>(
        async () => new Response("unavailable", { status: 503 }),
      ),
      503,
      "temporary",
    ],
    [
      "malformed response",
      contactEnv().env,
      vi.fn<typeof fetch>(
        async () =>
          new Response("not json", {
            headers: { "Content-Type": "application/json" },
          }),
      ),
      503,
      "temporary",
    ],
    [
      "rejected token",
      contactEnv().env,
      vi.fn<typeof fetch>(async () =>
        Response.json({
          success: false,
          "error-codes": ["timeout-or-duplicate"],
        }),
      ),
      400,
      "security",
    ],
    [
      "missing hostname",
      contactEnv().env,
      vi.fn<typeof fetch>(async () =>
        Response.json({ success: true, action: "turnstile-spin-v2" }),
      ),
      400,
      "security",
    ],
    [
      "wrong hostname",
      contactEnv().env,
      vi.fn<typeof fetch>(async () =>
        Response.json({
          success: true,
          hostname: "attacker.example",
          action: "turnstile-spin-v2",
        }),
      ),
      400,
      "security",
    ],
    [
      "missing action",
      contactEnv().env,
      vi.fn<typeof fetch>(async () =>
        Response.json({ success: true, hostname: "www.macon170.com" }),
      ),
      400,
      "security",
    ],
    [
      "wrong action",
      contactEnv().env,
      vi.fn<typeof fetch>(async () =>
        Response.json({
          success: true,
          hostname: "www.macon170.com",
          action: "other-form",
        }),
      ),
      400,
      "security",
    ],
  ])(
    "handles %s",
    async (_name, env, fetchImpl, expectedStatus, expectedCode) => {
      const response = await handleContactSubmission(
        jsonRequest(validPayload()),
        env as ContactBindings,
        fetchImpl as typeof fetch,
      );
      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: expectedCode },
      });
    },
  );
});

describe("contact persistence and redirects", () => {
  it("stores sanitized native submission data and a linked private content record", async () => {
    const { env, batches } = contactEnv();
    const response = await handleContactSubmission(
      jsonRequest(
        validPayload({
          parentName: " <Jordan>\u0000 Parent ",
          message: "Question with <script>alert(1)</script> text.",
        }),
      ),
      env,
      successfulTurnstile,
    );
    expect(response.status).toBe(201);
    const result = await response.json<{
      submissionId: string;
      contentId: string;
    }>();
    expect(result.submissionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.contentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);

    const serialized = JSON.stringify(
      batches[0].flatMap((statement) => statement.values),
    );
    expect(serialized).not.toContain("turnstile-token-that-must-not-be-stored");
    expect(serialized).toContain("<Jordan> Parent");
    expect(serialized).not.toContain("\\u0000");
    expect(batches[0][0].sql).toContain("INSERT INTO content");
    expect(batches[0][0].sql).toContain("'draft'");
    expect(batches[0][1].sql).toContain("INSERT INTO form_submissions");
    expect(batches[0][0].values).toContain(result.contentId);
    expect(batches[0][1].values).toContain(result.contentId);
  });

  it("redirects browser submissions to the branded success and error states", async () => {
    const { env } = contactEnv();
    const success = await handleContactSubmission(
      new Request(
        "https://cms.macon170.com/api/forms/contact/submit",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: "https://www.macon170.com",
          },
          body: new URLSearchParams(
            validPayload() as Record<string, string>,
          ),
          redirect: "manual",
        },
      ),
      env,
      successfulTurnstile,
    );
    expect(success.status).toBe(303);
    expect(success.headers.get("Location")).toBe(
      "https://www.macon170.com/contact/?submitted=success#contact-form",
    );

    const failure = await handleContactSubmission(
      new Request(
        "https://cms.macon170.com/api/forms/contact/submit",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: "https://www.macon170.com",
          },
          body: new URLSearchParams({ parentName: "J" }),
          redirect: "manual",
        },
      ),
      env,
      successfulTurnstile,
    );
    expect(failure.status).toBe(303);
    expect(failure.headers.get("Location")).toBe(
      "https://www.macon170.com/contact/?error=validation#contact-form",
    );
  });
});

describe("contact queue persistence", () => {
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    status: "pending",
    submission_number: 7,
    submission_data: JSON.stringify(
      validPayload({
        "cf-turnstile-response": undefined,
      }),
    ),
    submitted_at: 1_800_000_000_000,
    updated_at: 1_800_000_000_000,
    country_code: "US",
    source_path: "/contact/",
    last_viewed_at: null,
  };

  it("paginates and filters the native contact submissions", async () => {
    const statements: Prepared[] = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          sql,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            this.values = values;
            return this;
          },
          async all<T>() {
            return { results: [row as T] };
          },
        } as Prepared;
        statements.push(statement);
        return statement;
      },
    };
    const response = await listContactSubmissions(
      new Request(
        "https://cms.macon170.com/api/contact-admin/v1/submissions?status=pending&page=2",
      ),
      { DB: db } as unknown as ContactBindings,
    );
    const body = await response.json<{
      submissions: Array<{ parentName: string; statusLabel: string }>;
      page: number;
    }>();
    expect(body.page).toBe(2);
    expect(body.submissions[0]).toMatchObject({
      parentName: "Jordan Parent",
      statusLabel: "New",
    });
    expect(statements[0].values).toEqual([
      "default-contact-form",
      "pending",
      25,
      25,
    ]);
  });

  it("logs a view against the authenticated CMS user", async () => {
    const batches: Prepared[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          sql,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            this.values = values;
            return this;
          },
          async first<T>() {
            return row as T;
          },
        } as Prepared;
      },
      async batch(statements: Prepared[]) {
        batches.push(statements);
        return [];
      },
    };
    const response = await getContactSubmission(
      row.id,
      { DB: db } as unknown as ContactBindings,
      "admin-1",
    );
    expect(response.status).toBe(200);
    expect(batches[0][1].sql).toContain("contact_submission_audit");
    expect(batches[0][1].values).toContain("admin-1");
    expect(batches[0][1].values).toContain(row.id);
  });

  it.each([
    ["pending", "New", "draft"],
    ["reviewed", "In progress", "draft"],
    ["approved", "Resolved", "draft"],
    ["spam", "Spam", "archived"],
  ])(
    "maps %s to the queue label and private content state",
    async (status, label, contentStatus) => {
      const batches: Prepared[][] = [];
      const db = {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              this.values = values;
              return this;
            },
            async first<T>() {
              return {
                status: "pending",
                content_id: "content-1",
              } as T;
            },
          } as Prepared;
        },
        async batch(statements: Prepared[]) {
          batches.push(statements);
          return [];
        },
      };
      const response = await updateContactSubmission(
        new Request(
          `https://cms.macon170.com/api/contact-admin/v1/submissions/${row.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status }),
          },
        ),
        row.id,
        { DB: db } as unknown as ContactBindings,
        "admin-1",
      );
      await expect(response.json()).resolves.toMatchObject({
        status,
        statusLabel: label,
      });
      expect(batches[0][1].sql).toContain("contact_submission_audit");
      expect(batches[0][1].values).toContain(
        `pending -> ${status}`,
      );
      expect(batches[0][2].values).toContain(contentStatus);
    },
  );

  it("purges stale submissions, linked content, and audit rows then repairs the count", async () => {
    const batches: Prepared[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          sql,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            this.values = values;
            return this;
          },
        } as Prepared;
      },
      async batch(statements: Prepared[]) {
        batches.push(statements);
        return statements.map((_, index) => ({
          meta: { changes: index === 1 ? 1 : 0 },
        }));
      },
    };
    await runContactRetention({
      DB: db,
    } as unknown as ContactBindings);

    const sql = batches[0].map((statement) => statement.sql).join("\n");
    expect(sql).toContain("DELETE FROM contact_submission_audit");
    expect(sql).toContain("DELETE FROM form_submissions");
    expect(sql).toContain("SET submission_count");
    expect(batches[0]).toHaveLength(3);
  });
});
