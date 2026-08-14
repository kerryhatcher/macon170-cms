import { describe, expect, it, vi } from "vitest";

import {
  SIGNUP_ADMIN_BASE,
  handleAdminSignupRequest,
  summarizeSignupResponses,
} from "./signup-admin";
import type { SignupBindings, SignupResponseDetail } from "./signups";

function response(
  overrides: Partial<SignupResponseDetail>,
): SignupResponseDetail {
  return {
    id: "rsp",
    formId: "frm-1",
    formSlug: "lego-derby-food",
    formTitle: "Lego Derby food",
    formType: "rsvp",
    email: "parent@example.com",
    familyName: "Hatcher",
    phone: "478-555-0123",
    attending: true,
    adults: 2,
    children: 1,
    dietaryNotes: null,
    status: "confirmed",
    confirmedAt: "2027-01-02T00:00:00.000Z",
    createdAt: "2027-01-01T00:00:00.000Z",
    updatedAt: "2027-01-01T00:00:00.000Z",
    claims: [],
    ...overrides,
  };
}

describe("signup response summary", () => {
  it("counts families, headcounts, and unconfirmed responses", () => {
    const summary = summarizeSignupResponses([
      response({ id: "a" }),
      response({ id: "b", adults: 1, children: 4, status: "unconfirmed", confirmedAt: null }),
      response({ id: "c", attending: false, adults: 2, children: 2 }),
    ]);
    expect(summary).toEqual({
      families: 3,
      attending: 2,
      adults: 3,
      children: 5,
      unconfirmed: 1,
    });
  });

  it("excludes headcounts for families that are not attending", () => {
    const summary = summarizeSignupResponses([
      response({ attending: false, adults: 5, children: 5 }),
    ]);
    expect(summary.adults).toBe(0);
    expect(summary.children).toBe(0);
    expect(summary.attending).toBe(0);
  });

  it("returns zeros for an empty queue", () => {
    expect(summarizeSignupResponses([])).toEqual({
      families: 0,
      attending: 0,
      adults: 0,
      children: 0,
      unconfirmed: 0,
    });
  });
});

const user = { userId: "usr-1", email: "volunteer@macon170.com" };

const formRow = {
  id: "frm-1",
  revision: 4,
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
};

const responseRow = {
  id: "rsp-1",
  form_id: "frm-1",
  email: "parent@example.com",
  family_name: "Hatcher",
  phone: "478-555-0123",
  attending: 1,
  adults: 2,
  children: 1,
  dietary_notes: null,
  status: "confirmed",
  confirmed_at: 1,
  created_at: 1,
  updated_at: 1,
  form_slug: "lego-derby-food",
  form_title: "Lego Derby food",
  form_type: "items",
};

// Answers by statement shape, the same approach signup-public.test.ts uses, so
// each test reaches the branch it is asserting on instead of stopping at a
// lookup.
function adminDb(options: {
  form?: Record<string, unknown> | null;
  response?: Record<string, unknown> | null;
  changes?: number;
  batch?: ReturnType<typeof vi.fn>;
} = {}) {
  const form = options.form === undefined ? formRow : options.form;
  const responseValue =
    options.response === undefined ? responseRow : options.response;
  const statements: string[] = [];
  const batch =
    options.batch ??
    vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }]);
  const db = {
    prepare: (sql: string) => {
      statements.push(sql);
      return {
        sql,
        values: [] as unknown[],
        bind(...values: unknown[]) {
          this.values = values;
          return this;
        },
        first: async () => {
          if (sql.includes("FROM signup_forms")) return form;
          if (sql.includes("FROM signup_responses")) return responseValue;
          return null;
        },
        all: async () => ({
          results: sql.includes("FROM signup_slots")
            ? [slotRow]
            : sql.includes("FROM signup_responses")
              ? responseValue
                ? [responseValue]
                : []
              : [],
        }),
        run: async () => ({ meta: { changes: options.changes ?? 1 } }),
      };
    },
    batch,
  };
  return { db, statements, batch };
}

function adminEnv(db: unknown) {
  return {
    PUBLIC_SITE_ORIGIN: "https://www.macon170.com",
    MAILGUN_API_KEY: "key-test",
    MAILGUN_DOMAIN: "macon170.com",
    SIGNUP_FROM_EMAIL: "volunteers@macon170.com",
    DB: db,
  } as unknown as SignupBindings;
}

function adminRequest(
  path: string,
  init: RequestInit = {},
): Request {
  return new Request(`https://cms.macon170.com${SIGNUP_ADMIN_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

const formPayload = {
  slug: "lego-derby-food",
  eventId: "evt-1",
  formType: "items",
  title: "Lego Derby food",
  instructions: "",
  state: "open",
  closesAt: null,
  slots: [{ label: "Hot dog buns", quantityNeeded: 3, notes: null }],
};

describe("signup admin API", () => {
  it("returns the form, its responses, and the summary", async () => {
    const { db } = adminDb();
    const response = await handleAdminSignupRequest(
      adminRequest("/forms/frm-1"),
      adminEnv(db),
      user,
      null,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      form: { id: "frm-1", revision: 4 },
      summary: { families: 1, attending: 1 },
    });
  });

  it("404s an unknown form id", async () => {
    const { db } = adminDb({ form: null });
    const response = await handleAdminSignupRequest(
      adminRequest("/forms/frm-missing"),
      adminEnv(db),
      user,
      null,
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("maps a stale expectedRevision to 409 conflict", async () => {
    const { db } = adminDb();
    const response = await handleAdminSignupRequest(
      adminRequest("/forms/frm-1", {
        method: "PUT",
        body: JSON.stringify({ ...formPayload, expectedRevision: 3 }),
      }),
      adminEnv(db),
      user,
      null,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "conflict" },
    });
  });

  it("maps a save against a deleted form to 404", async () => {
    // updateSignupForm throws SignupNotFoundError, which is a different
    // mapping from the explicit 404s the route raises itself.
    const { db } = adminDb({ form: null });
    const response = await handleAdminSignupRequest(
      adminRequest("/forms/frm-1", {
        method: "PUT",
        body: JSON.stringify({ ...formPayload, expectedRevision: 4 }),
      }),
      adminEnv(db),
      user,
      null,
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("rejects a PUT with no expectedRevision as a validation error", async () => {
    const { db } = adminDb();
    const response = await handleAdminSignupRequest(
      adminRequest("/forms/frm-1", {
        method: "PUT",
        body: JSON.stringify(formPayload),
      }),
      adminEnv(db),
      user,
      null,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "validation" },
    });
  });

  it("deletes a response and records the acting volunteer", async () => {
    const { db, statements } = adminDb();
    const response = await handleAdminSignupRequest(
      adminRequest("/responses/rsp-1", { method: "DELETE" }),
      adminEnv(db),
      user,
      null,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "deleted",
    });
    expect(statements.some((sql) => sql.includes("DELETE FROM signup_responses"))).toBe(
      true,
    );
    expect(statements.some((sql) => sql.includes("INSERT INTO signup_audit"))).toBe(
      true,
    );
  });

  it("rotates the token and emails the family on resend", async () => {
    const { db, statements } = adminDb();
    const env = adminEnv(db);
    const send = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const response = await handleAdminSignupRequest(
      adminRequest("/responses/rsp-1/resend", { method: "POST" }),
      env,
      user,
      null,
      true,
      send,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "resent" });
    expect(statements.some((sql) => sql.includes("UPDATE signup_responses SET token_hash"))).toBe(
      true,
    );
    expect(send).toHaveBeenCalledOnce();
    expect((send.mock.calls[0][1].body as FormData).get("to")).toBe(
      "parent@example.com",
    );
  });

  it("404s a resend for a response that vanished before the rotation landed", async () => {
    const { db } = adminDb({
      batch: vi
        .fn()
        .mockResolvedValue([{ meta: { changes: 0 } }, { meta: { changes: 1 } }]),
    });
    const env = adminEnv(db);
    const send = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const response = await handleAdminSignupRequest(
      adminRequest("/responses/rsp-1/resend", { method: "POST" }),
      env,
      user,
      null,
      true,
      send,
    );
    expect(response.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it("404s a resend for an unknown response id", async () => {
    const { db } = adminDb({ response: null });
    const response = await handleAdminSignupRequest(
      adminRequest("/responses/rsp-missing/resend", { method: "POST" }),
      adminEnv(db),
      user,
      null,
    );
    expect(response.status).toBe(404);
  });

  it("405s a method the route does not serve", async () => {
    const { db } = adminDb();
    const response = await handleAdminSignupRequest(
      adminRequest("/forms/frm-1", { method: "DELETE" }),
      adminEnv(db),
      user,
      null,
    );
    expect(response.status).toBe(405);
  });

  it("404s an unrecognized admin path", async () => {
    const { db } = adminDb();
    const response = await handleAdminSignupRequest(
      adminRequest("/nope"),
      adminEnv(db),
      user,
      null,
    );
    expect(response.status).toBe(404);
  });

  it("creates a form when the volunteer holds calendar.manage", async () => {
    const { db } = adminDb();
    const response = await handleAdminSignupRequest(
      adminRequest("/forms", { method: "POST", body: JSON.stringify(formPayload) }),
      adminEnv(db),
      user,
      null,
      true,
    );
    expect(response.status).toBe(201);
  });

  it("rejects creating a form without calendar.manage, even with signups.manage", async () => {
    // The HTML /admin/signups/new route already gates on calendar.manage, but
    // that route is a UX guard, not a security boundary: this API is directly
    // callable, so a signups.manage-only volunteer must not be able to bypass
    // the HTML gate by calling POST /forms directly.
    const { db, batch } = adminDb();
    const response = await handleAdminSignupRequest(
      adminRequest("/forms", { method: "POST", body: JSON.stringify(formPayload) }),
      adminEnv(db),
      user,
      null,
      false,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "forbidden" },
    });
    expect(batch).not.toHaveBeenCalled();
  });

  it("allows a save that leaves eventId unchanged without calendar.manage", async () => {
    // formPayload.eventId ("evt-1") matches formRow.event_id, so this is a
    // title/instructions/state-only style edit — the degrade path the admin
    // UI's disabled event-select relies on must keep working end to end.
    const { db } = adminDb();
    const response = await handleAdminSignupRequest(
      adminRequest("/forms/frm-1", {
        method: "PUT",
        body: JSON.stringify({ ...formPayload, expectedRevision: 4 }),
      }),
      adminEnv(db),
      user,
      null,
      false,
    );
    expect(response.status).toBe(200);
  });

  it("rejects changing a form's event without calendar.manage, even with signups.manage", async () => {
    const { db, batch } = adminDb();
    const response = await handleAdminSignupRequest(
      adminRequest("/forms/frm-1", {
        method: "PUT",
        body: JSON.stringify({
          ...formPayload,
          eventId: "evt-2",
          expectedRevision: 4,
        }),
      }),
      adminEnv(db),
      user,
      null,
      false,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "forbidden" },
    });
    expect(batch).not.toHaveBeenCalled();
  });
});
