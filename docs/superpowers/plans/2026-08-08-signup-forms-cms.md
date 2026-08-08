# Event Signup Forms (CMS Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add volunteer-created event signup forms to the CMS — RSVP attendance intent and bring-an-item claims — with magic-link family identity, a public JSON API, a volunteer admin queue, and automated retention.

**Architecture:** Bespoke D1 tables following the existing calendar pattern (not SonicJS generic forms). Four data tables plus an audit table in one new custom migration. Slot over-subscription is prevented by a schema trigger, so every write path is protected and D1's implicit batch transaction rolls back atomically. Family identity is a 32-byte token delivered by email; only its SHA-256 is stored. The CMS serves JSON and sends email; all family-facing HTML lives in the separate `macon170.com` Astro repo and is out of scope for this plan.

**Tech Stack:** TypeScript on Cloudflare Workers, SonicJS core, D1 (SQLite), Vitest, Bun, Wrangler. Existing bindings reused: `DB`, `EMAIL`, `TURNSTILE_SECRET`. One new binding: `SIGNUP_RATE_LIMITER`.

**Source spec:** `docs/superpowers/specs/2026-08-08-signup-forms-design.md`

## Global Constraints

- Conventional Commit messages: `type(optional-scope): description`. Use `feat` for new features, `fix` for bug fixes. A commit-msg hook enforces this — a non-conforming message is rejected.
- Never edit an applied migration. New schema changes are new sequentially numbered files in `migrations/custom/`.
- All timestamps stored as integer milliseconds (`unixepoch() * 1000` in SQL, `Date.now()` in TS). All timestamps exposed in JSON as ISO 8601 strings.
- All public JSON is camelCase and includes `version: "v1"`.
- Table and column names are `snake_case`; TypeScript identifiers are `camelCase`. Row types are declared separately from domain types, exactly as `CalendarRow` versus `CalendarEvent` in `src/calendar.ts`.
- Source style: double-quoted strings, 2-space indent, explicit return types on exported functions, `import type` for type-only imports.
- Every new SQL object uses `IF NOT EXISTS` so a re-applied migration is a no-op.
- Public error responses use the contact form's code vocabulary: `validation`, `security`, `rate_limit`, `temporary`, `not_found`. Never leak internal detail into a public message.
- No new npm dependencies. No Durable Objects. No KV.
- Dietary notes, family names, and email addresses must never appear in any public API response.
- Run `bun run type-check` before every commit; it must pass.

---

### Task 1: Schema migration and capacity trigger

**Files:**
- Create: `migrations/custom/0004_signups.sql`
- Create: `scripts/test-signup-migrations.mjs`
- Modify: `package.json` (add `test:migrations:signups` script; extend `test`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: tables `signup_forms`, `signup_slots`, `signup_responses`, `signup_claims`, `signup_audit`; permission row `perm_signups_manage` with name `signups.manage`; triggers `signup_claims_capacity_insert` and `signup_claims_capacity_update` which `RAISE(ABORT, 'signup slot is full')`. Later tasks detect that exact message string.

**Note — refinement of the spec.** The spec described preventing the claim race with a single conditional `INSERT`. This task instead enforces the invariant with a `BEFORE INSERT`/`BEFORE UPDATE` trigger. The guarantee is identical and strictly stronger: it protects the admin path and any future write path, not just the one public endpoint, and because D1's `batch()` runs in an implicit transaction, an aborted trigger rolls the whole batch back. The API behavior the spec specifies (`409` plus refreshed availability) is unchanged.

- [ ] **Step 1: Write the migration**

Create `migrations/custom/0004_signups.sql`:

```sql
-- CMS-owned Pack 170 event signup forms: attendance intent and item claims.
CREATE TABLE IF NOT EXISTS signup_forms (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  slug TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL REFERENCES calendar_events(id),
  form_type TEXT NOT NULL CHECK (form_type IN ('rsvp', 'items')),
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'open', 'closed')),
  closes_at TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signup_forms_event
  ON signup_forms(event_id);
CREATE INDEX IF NOT EXISTS idx_signup_forms_state
  ON signup_forms(state, slug);

CREATE TABLE IF NOT EXISTS signup_slots (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES signup_forms(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  label TEXT NOT NULL,
  quantity_needed INTEGER NOT NULL CHECK (quantity_needed >= 1),
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signup_slots_form
  ON signup_slots(form_id, position);

CREATE TABLE IF NOT EXISTS signup_responses (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES signup_forms(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  family_name TEXT NOT NULL,
  attending INTEGER NOT NULL DEFAULT 1 CHECK (attending IN (0, 1)),
  adults INTEGER NOT NULL DEFAULT 0 CHECK (adults >= 0 AND adults <= 20),
  children INTEGER NOT NULL DEFAULT 0 CHECK (children >= 0 AND children <= 20),
  dietary_notes TEXT,
  status TEXT NOT NULL DEFAULT 'unconfirmed'
    CHECK (status IN ('unconfirmed', 'confirmed')),
  confirmed_at INTEGER,
  token_hash TEXT NOT NULL UNIQUE,
  ip_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(form_id, email),
  CHECK (status != 'confirmed' OR confirmed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_signup_responses_form
  ON signup_responses(form_id, created_at);
CREATE INDEX IF NOT EXISTS idx_signup_responses_unconfirmed
  ON signup_responses(status, created_at);

CREATE TABLE IF NOT EXISTS signup_claims (
  id TEXT PRIMARY KEY,
  response_id TEXT NOT NULL REFERENCES signup_responses(id) ON DELETE CASCADE,
  slot_id TEXT NOT NULL REFERENCES signup_slots(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  created_at INTEGER NOT NULL,
  UNIQUE(response_id, slot_id)
);

CREATE INDEX IF NOT EXISTS idx_signup_claims_slot
  ON signup_claims(slot_id);
CREATE INDEX IF NOT EXISTS idx_signup_claims_response
  ON signup_claims(response_id);

-- Capacity is enforced in the schema so every write path is protected and an
-- oversubscribed claim aborts the enclosing D1 batch transaction.
CREATE TRIGGER IF NOT EXISTS signup_claims_capacity_insert
BEFORE INSERT ON signup_claims
BEGIN
  SELECT CASE
    WHEN (
      SELECT COALESCE(SUM(quantity), 0) FROM signup_claims
      WHERE slot_id = NEW.slot_id
    ) + NEW.quantity > (
      SELECT quantity_needed FROM signup_slots WHERE id = NEW.slot_id
    )
    THEN RAISE(ABORT, 'signup slot is full')
  END;
END;

CREATE TRIGGER IF NOT EXISTS signup_claims_capacity_update
BEFORE UPDATE ON signup_claims
BEGIN
  SELECT CASE
    WHEN (
      SELECT COALESCE(SUM(quantity), 0) FROM signup_claims
      WHERE slot_id = NEW.slot_id AND id != NEW.id
    ) + NEW.quantity > (
      SELECT quantity_needed FROM signup_slots WHERE id = NEW.slot_id
    )
    THEN RAISE(ABORT, 'signup slot is full')
  END;
END;

CREATE TABLE IF NOT EXISTS signup_audit (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('form', 'response')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signup_audit_entity
  ON signup_audit(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_signup_audit_created
  ON signup_audit(created_at);

INSERT OR IGNORE INTO permissions
  (id, name, description, category, created_at)
VALUES
  (
    'perm_signups_manage',
    'signups.manage',
    'Create and manage Pack event signup forms and their responses',
    'content',
    unixepoch() * 1000
  );

INSERT OR IGNORE INTO role_permissions
  (id, role, permission_id, created_at)
VALUES
  (
    'role_perm_admin_signups_manage',
    'admin',
    'perm_signups_manage',
    unixepoch() * 1000
  );
```

- [ ] **Step 2: Write the migration contract script**

Create `scripts/test-signup-migrations.mjs`. This mirrors `scripts/test-contact-migrations.mjs` and additionally exercises the capacity trigger against real SQLite, which the Vitest unit tests cannot do.

```javascript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const persistTo = await mkdtemp(join(tmpdir(), "macon170-cms-signups-"));

async function run(args) {
  const child = Bun.spawn(args, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${args.join(" ")} failed (${exitCode})\n${stdout}\n${stderr}`,
    );
  }
  return stdout;
}

const base = [
  "bunx",
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "macon170-cms",
  "--local",
  "--persist-to",
  persistTo,
];

function execute(command) {
  return run([
    "bunx",
    "wrangler",
    "d1",
    "execute",
    "macon170-cms",
    "--local",
    "--persist-to",
    persistTo,
    "--config",
    "wrangler.jsonc",
    "--json",
    "--command",
    command,
  ]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await run([...base, "--config", "wrangler.jsonc"]);
  await run([...base, "--config", "wrangler.custom-migrations.jsonc"]);
  // Re-applying tracked custom migrations must be a no-op.
  await run([...base, "--config", "wrangler.custom-migrations.jsonc"]);

  const shape = JSON.parse(
    await execute(
      `SELECT
         (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'
           AND name IN ('signup_forms','signup_slots','signup_responses',
                        'signup_claims','signup_audit')) AS tables,
         (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'
           AND name IN ('signup_claims_capacity_insert',
                        'signup_claims_capacity_update')) AS triggers,
         (SELECT COUNT(*) FROM permissions WHERE name = 'signups.manage')
           AS permission,
         (SELECT COUNT(*) FROM role_permissions
           WHERE permission_id = 'perm_signups_manage' AND role = 'admin')
           AS admin_grant`,
    ),
  );
  const counts = shape.at(-1).results[0];
  assert(counts.tables === 5, `expected 5 signup tables, got ${counts.tables}`);
  assert(counts.triggers === 2, `expected 2 capacity triggers, got ${counts.triggers}`);
  assert(counts.permission === 1, "signups.manage permission missing");
  assert(counts.admin_grant === 1, "admin role grant missing");

  // Seed one event, one form, one slot needing 2.
  await execute(
    `INSERT INTO calendar_events (
       id, revision, slug, publication_state, event_status, category, title,
       summary, description, starts_at, ends_at, timezone, audience,
       created_at, updated_at, published_at
     ) VALUES (
       'evt-1', 0, 'lego-derby', 'published', 'scheduled', 'pack', 'Lego Derby',
       'Race day', 'Race day details', '2027-03-01T18:00:00.000Z', NULL,
       'America/New_York', 'All families', 1, 1, 1
     );
     INSERT INTO signup_forms (
       id, revision, slug, event_id, form_type, title, instructions, state,
       closes_at, created_at, updated_at
     ) VALUES (
       'frm-1', 0, 'lego-derby-food', 'evt-1', 'items', 'Food', '', 'open',
       NULL, 1, 1
     );
     INSERT INTO signup_slots (
       id, form_id, position, label, quantity_needed, notes,
       created_at, updated_at
     ) VALUES ('slt-1', 'frm-1', 0, 'Hot dog buns', 2, NULL, 1, 1);
     INSERT INTO signup_responses (
       id, form_id, email, family_name, attending, adults, children,
       dietary_notes, status, confirmed_at, token_hash, ip_hash,
       created_at, updated_at
     ) VALUES
       ('rsp-1', 'frm-1', 'a@example.com', 'Alpha', 1, 2, 1, NULL,
        'unconfirmed', NULL, 'hash-a', NULL, 1, 1),
       ('rsp-2', 'frm-1', 'b@example.com', 'Beta', 1, 2, 0, NULL,
        'unconfirmed', NULL, 'hash-b', NULL, 1, 1);`,
  );

  // Claiming the full quantity succeeds.
  await execute(
    `INSERT INTO signup_claims (id, response_id, slot_id, quantity, created_at)
     VALUES ('clm-1', 'rsp-1', 'slt-1', 2, 1);`,
  );

  // Over-subscribing the same slot must abort.
  let aborted = false;
  try {
    await execute(
      `INSERT INTO signup_claims (id, response_id, slot_id, quantity, created_at)
       VALUES ('clm-2', 'rsp-2', 'slt-1', 1, 1);`,
    );
  } catch (error) {
    aborted = /signup slot is full/.test(String(error));
  }
  assert(aborted, "capacity trigger did not abort an oversubscribed claim");

  // Deleting a response releases its claims through the cascade.
  await execute(`DELETE FROM signup_responses WHERE id = 'rsp-1';`);
  const after = JSON.parse(
    await execute(
      `SELECT COALESCE(SUM(quantity), 0) AS claimed FROM signup_claims
       WHERE slot_id = 'slt-1'`,
    ),
  );
  assert(
    after.at(-1).results[0].claimed === 0,
    "claims did not cascade when the response was deleted",
  );

  console.log("signup migration contract OK");
} finally {
  await rm(persistTo, { recursive: true, force: true });
}
```

- [ ] **Step 3: Wire the script into package.json**

In `package.json`, add the new script and include it in `test`:

```json
"test": "bun run test:unit && bun run test:migrations && bun run test:migrations:signups",
"test:migrations:signups": "bun scripts/test-signup-migrations.mjs",
```

- [ ] **Step 4: Run the contract test to verify it fails**

Run: `bun run test:migrations:signups`
Expected: FAIL — the custom migration ledger has no `0004_signups.sql` applied yet if the file was not saved, or, once saved, this is the first run that proves the trigger works. If it fails with `expected 5 signup tables, got 0`, the migration file was not picked up; confirm the filename and that `wrangler.custom-migrations.jsonc` points at `migrations/custom`.

- [ ] **Step 5: Run the contract test to verify it passes**

Run: `bun run test:migrations:signups`
Expected: PASS, printing `signup migration contract OK`.

- [ ] **Step 6: Apply the migration to the local development database**

Run: `bun run db:migrate:local`
Expected: `0004_signups.sql` applies; a second run reports no pending migrations.

- [ ] **Step 7: Commit**

```bash
git add migrations/custom/0004_signups.sql scripts/test-signup-migrations.mjs package.json
git commit -m "feat(signups): add signup form schema with slot capacity trigger"
```

---

### Task 2: Domain module — types, validation, tokens

**Files:**
- Create: `src/signups.ts`
- Test: `src/signups.test.ts`

**Interfaces:**
- Consumes: Task 1's schema (constraint values must agree: headcounts 0–20, `quantity_needed >= 1`).
- Produces:
  - `SIGNUP_PERMISSION = "signups.manage"`, `SIGNUP_VERSION = "v1"`, `SIGNUP_UNCONFIRMED_HOURS = 24`, `SIGNUP_RETENTION_DAYS = 90`, `SIGNUP_AUDIT_RETENTION_DAYS = 365`
  - types `SignupFormType`, `SignupFormState`, `SignupResponseStatus`, `SignupSlot`, `SignupSlotInput`, `SignupForm`, `SignupFormDetail`, `SignupFormInput`, `SignupResponseInput`, `SignupResponseDetail`, `PublicSignupForm`, `SignupBindings`
  - `validateSignupFormInput(input: Record<string, unknown>): SignupFormInput`
  - `validateSignupResponseInput(raw: Record<string, unknown>, form: { formType: SignupFormType; slots: SignupSlot[] }): SignupResponseInput`
  - `isSignupClosed(form: { state: SignupFormState; closesAt: string | null }, now?: number): boolean`
  - `issueSignupToken(): Promise<{ token: string; tokenHash: string }>`
  - `hashSignupToken(token: string): Promise<string>`
  - `SignupRequestError` (with `status: number`, `code: string`), `SignupConflictError`, `SignupNotFoundError`, `SignupSlotFullError`

- [ ] **Step 1: Write the failing test**

Create `src/signups.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  SignupRequestError,
  hashSignupToken,
  isSignupClosed,
  issueSignupToken,
  validateSignupFormInput,
  validateSignupResponseInput,
} from "./signups";

const formInput = {
  slug: "lego-derby-food",
  eventId: "11111111-1111-4111-8111-111111111111",
  formType: "items",
  title: "Lego Derby food",
  instructions: "Claim what you can bring.",
  state: "open",
  closesAt: "2027-02-28T23:00:00-05:00",
  slots: [
    { label: "Hot dog buns", quantityNeeded: 3, notes: null },
    { label: "Drinks", quantityNeeded: 2, notes: "Caffeine free" },
  ],
};

const slots = [
  {
    id: "slot-1",
    formId: "form-1",
    position: 0,
    label: "Hot dog buns",
    quantityNeeded: 3,
    notes: null,
    createdAt: "2027-01-01T00:00:00.000Z",
    updatedAt: "2027-01-01T00:00:00.000Z",
  },
];

describe("signup form validation", () => {
  it("normalizes the deadline to UTC and assigns slot positions", () => {
    const result = validateSignupFormInput(formInput);
    expect(result.closesAt).toBe("2027-03-01T04:00:00.000Z");
    expect(result.slots.map((slot) => slot.position)).toEqual([0, 1]);
    expect(result.slots[1]?.notes).toBe("Caffeine free");
  });

  it("rejects a bad slug, unknown type, and unknown state", () => {
    expect(() =>
      validateSignupFormInput({ ...formInput, slug: "Lego Derby" }),
    ).toThrow("slug");
    expect(() =>
      validateSignupFormInput({ ...formInput, formType: "potluck" }),
    ).toThrow("formType");
    expect(() =>
      validateSignupFormInput({ ...formInput, state: "archived" }),
    ).toThrow("state");
  });

  it("requires at least one slot for an items form and none for rsvp", () => {
    expect(() =>
      validateSignupFormInput({ ...formInput, slots: [] }),
    ).toThrow("at least one item");
    expect(
      validateSignupFormInput({ ...formInput, formType: "rsvp", slots: [] })
        .slots,
    ).toEqual([]);
    expect(
      validateSignupFormInput({ ...formInput, formType: "rsvp" }).slots,
    ).toEqual([]);
  });

  it("rejects a slot quantity below one", () => {
    expect(() =>
      validateSignupFormInput({
        ...formInput,
        slots: [{ label: "Buns", quantityNeeded: 0, notes: null }],
      }),
    ).toThrow("quantityNeeded");
  });
});

describe("signup response validation", () => {
  const base = {
    email: " Parent@Example.COM ",
    familyName: "  Hatcher  ",
    attending: true,
    adults: 2,
    children: 3,
    dietaryNotes: "Peanut allergy",
    claims: [{ slotId: "slot-1", quantity: 2 }],
  };

  it("lowercases and trims the email and keeps the dietary note", () => {
    const result = validateSignupResponseInput(base, {
      formType: "items",
      slots,
    });
    expect(result.email).toBe("parent@example.com");
    expect(result.familyName).toBe("Hatcher");
    expect(result.dietaryNotes).toBe("Peanut allergy");
  });

  it("forces attending true and drops claims for an rsvp form", () => {
    const result = validateSignupResponseInput(base, {
      formType: "rsvp",
      slots: [],
    });
    expect(result.claims).toEqual([]);
  });

  it("rejects an unknown slot id", () => {
    expect(() =>
      validateSignupResponseInput(
        { ...base, claims: [{ slotId: "nope", quantity: 1 }] },
        { formType: "items", slots },
      ),
    ).toThrow(SignupRequestError);
  });

  it("rejects a malformed email and out-of-range headcounts", () => {
    expect(() =>
      validateSignupResponseInput(
        { ...base, email: "not-an-email" },
        { formType: "items", slots },
      ),
    ).toThrow("email");
    expect(() =>
      validateSignupResponseInput(
        { ...base, adults: 99 },
        { formType: "items", slots },
      ),
    ).toThrow("adults");
    expect(() =>
      validateSignupResponseInput(
        { ...base, children: -1 },
        { formType: "items", slots },
      ),
    ).toThrow("children");
  });

  it("rejects a duplicate slot claim", () => {
    expect(() =>
      validateSignupResponseInput(
        {
          ...base,
          claims: [
            { slotId: "slot-1", quantity: 1 },
            { slotId: "slot-1", quantity: 1 },
          ],
        },
        { formType: "items", slots },
      ),
    ).toThrow("once");
  });
});

describe("signup closed state", () => {
  const at = Date.parse("2027-03-01T00:00:00.000Z");

  it("treats draft and closed states as closed", () => {
    expect(isSignupClosed({ state: "draft", closesAt: null }, at)).toBe(true);
    expect(isSignupClosed({ state: "closed", closesAt: null }, at)).toBe(true);
    expect(isSignupClosed({ state: "open", closesAt: null }, at)).toBe(false);
  });

  it("treats a passed deadline as closed", () => {
    expect(
      isSignupClosed({ state: "open", closesAt: "2027-02-28T00:00:00.000Z" }, at),
    ).toBe(true);
    expect(
      isSignupClosed({ state: "open", closesAt: "2027-03-02T00:00:00.000Z" }, at),
    ).toBe(false);
  });
});

describe("signup tokens", () => {
  it("issues a URL-safe token whose stored hash is not the token", async () => {
    const { token, tokenHash } = await issueSignupToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
    await expect(hashSignupToken(token)).resolves.toBe(tokenHash);
  });

  it("issues a different token each call", async () => {
    const first = await issueSignupToken();
    const second = await issueSignupToken();
    expect(first.token).not.toBe(second.token);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- src/signups.test.ts`
Expected: FAIL — `Failed to resolve import "./signups"`.

- [ ] **Step 3: Write the implementation**

Create `src/signups.ts`:

```typescript
import type { Bindings } from "@sonicjs-cms/core";

export const SIGNUP_PERMISSION = "signups.manage";
export const SIGNUP_VERSION = "v1";
export const SIGNUP_UNCONFIRMED_HOURS = 24;
export const SIGNUP_RETENTION_DAYS = 90;
export const SIGNUP_AUDIT_RETENTION_DAYS = 365;
export const SIGNUP_BODY_LIMIT = 8 * 1024;

export type SignupFormType = "rsvp" | "items";
export type SignupFormState = "draft" | "open" | "closed";
export type SignupResponseStatus = "unconfirmed" | "confirmed";

export type SignupBindings = Bindings & {
  APP_VERSION?: string;
  ENVIRONMENT?: string;
  PUBLIC_SITE_ORIGIN?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_EXPECTED_ACTION?: string;
  TURNSTILE_EXPECTED_HOSTNAMES?: string;
  INVITE_FROM_EMAIL?: string;
  INVITE_FROM_NAME?: string;
  INVITE_REPLY_TO?: string;
  SIGNUP_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  EMAIL?: { send(message: unknown): Promise<void> };
};

export type SignupSlot = {
  id: string;
  formId: string;
  position: number;
  label: string;
  quantityNeeded: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SignupSlotInput = {
  position: number;
  label: string;
  quantityNeeded: number;
  notes: string | null;
};

export type SignupForm = {
  id: string;
  revision: number;
  slug: string;
  eventId: string;
  formType: SignupFormType;
  title: string;
  instructions: string;
  state: SignupFormState;
  closesAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SignupFormDetail = SignupForm & { slots: SignupSlot[] };

export type SignupFormInput = {
  slug: string;
  eventId: string;
  formType: SignupFormType;
  title: string;
  instructions: string;
  state: SignupFormState;
  closesAt: string | null;
  slots: SignupSlotInput[];
};

export type SignupClaimInput = { slotId: string; quantity: number };

export type SignupResponseInput = {
  email: string;
  familyName: string;
  attending: boolean;
  adults: number;
  children: number;
  dietaryNotes: string | null;
  claims: SignupClaimInput[];
};

export type SignupResponseDetail = {
  id: string;
  formId: string;
  formSlug: string;
  formTitle: string;
  formType: SignupFormType;
  email: string;
  familyName: string;
  attending: boolean;
  adults: number;
  children: number;
  dietaryNotes: string | null;
  status: SignupResponseStatus;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  claims: Array<{ slotId: string; label: string; quantity: number }>;
};

export type PublicSignupSlot = {
  id: string;
  label: string;
  notes: string | null;
  quantityNeeded: number;
  quantityClaimed: number;
  quantityRemaining: number;
};

export type PublicSignupForm = {
  slug: string;
  formType: SignupFormType;
  title: string;
  instructions: string;
  closed: boolean;
  closesAt: string | null;
  event: { slug: string; title: string; startsAt: string };
  slots: PublicSignupSlot[];
};

export class SignupRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SignupRequestError";
  }
}

export class SignupConflictError extends Error {}
export class SignupNotFoundError extends Error {}
export class SignupSlotFullError extends Error {}

const formTypes = new Set<SignupFormType>(["rsvp", "items"]);
const formStates = new Set<SignupFormState>(["draft", "open", "closed"]);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const emailPattern = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const instantPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function invalid(field: string): never {
  throw new SignupRequestError(400, "validation", `Invalid ${field}`);
}

function text(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string") invalid(field);
  const normalized = value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (normalized.length < min || normalized.length > max) invalid(field);
  return normalized;
}

function optionalText(
  value: unknown,
  field: string,
  max: number,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  return text(value, field, 1, max);
}

function count(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (
    typeof parsed !== "number" ||
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > 20
  ) {
    invalid(field);
  }
  return parsed;
}

function instant(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    invalid(field);
  }
  return new Date(value).toISOString();
}

function boolish(value: unknown): boolean {
  return value === true || value === "true" || value === "on" || value === 1;
}

export function validateSignupFormInput(
  input: Record<string, unknown>,
): SignupFormInput {
  const slug = text(input.slug, "slug", 2, 80);
  if (!slugPattern.test(slug)) invalid("slug");

  const formType = input.formType;
  if (typeof formType !== "string" || !formTypes.has(formType as SignupFormType)) {
    invalid("formType");
  }
  const state = input.state;
  if (typeof state !== "string" || !formStates.has(state as SignupFormState)) {
    invalid("state");
  }

  const rawSlots = Array.isArray(input.slots) ? input.slots : [];
  const slots: SignupSlotInput[] =
    formType === "rsvp"
      ? []
      : rawSlots.map((entry, index) => {
          const slot = (entry ?? {}) as Record<string, unknown>;
          const quantityNeeded =
            typeof slot.quantityNeeded === "string"
              ? Number(slot.quantityNeeded)
              : slot.quantityNeeded;
          if (
            typeof quantityNeeded !== "number" ||
            !Number.isInteger(quantityNeeded) ||
            quantityNeeded < 1 ||
            quantityNeeded > 500
          ) {
            invalid("quantityNeeded");
          }
          return {
            position: index,
            label: text(slot.label, "label", 1, 120),
            quantityNeeded,
            notes: optionalText(slot.notes, "notes", 300),
          };
        });
  if (formType === "items" && slots.length === 0) {
    throw new SignupRequestError(
      400,
      "validation",
      "An item signup needs at least one item.",
    );
  }
  if (slots.length > 60) invalid("slots");

  return {
    slug,
    eventId: text(input.eventId, "eventId", 1, 64),
    formType: formType as SignupFormType,
    title: text(input.title, "title", 2, 120),
    instructions: optionalText(input.instructions, "instructions", 2_000) ?? "",
    state: state as SignupFormState,
    closesAt:
      input.closesAt === null ||
      input.closesAt === undefined ||
      input.closesAt === ""
        ? null
        : instant(input.closesAt, "closesAt"),
    slots,
  };
}

export function validateSignupResponseInput(
  raw: Record<string, unknown>,
  form: { formType: SignupFormType; slots: SignupSlot[] },
): SignupResponseInput {
  const email = text(raw.email, "email", 5, 200).toLowerCase();
  if (!emailPattern.test(email)) invalid("email");

  const knownSlots = new Map(form.slots.map((slot) => [slot.id, slot]));
  const rawClaims = Array.isArray(raw.claims) ? raw.claims : [];
  const claims: SignupClaimInput[] = [];
  if (form.formType === "items") {
    const seen = new Set<string>();
    for (const entry of rawClaims) {
      const claim = (entry ?? {}) as Record<string, unknown>;
      const slotId = text(claim.slotId, "slotId", 1, 64);
      if (!knownSlots.has(slotId)) invalid("slotId");
      if (seen.has(slotId)) {
        throw new SignupRequestError(
          400,
          "validation",
          "Each item may be claimed once per family.",
        );
      }
      seen.add(slotId);
      const quantity =
        typeof claim.quantity === "string"
          ? Number(claim.quantity)
          : claim.quantity;
      if (
        typeof quantity !== "number" ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > (knownSlots.get(slotId)?.quantityNeeded ?? 0)
      ) {
        invalid("quantity");
      }
      claims.push({ slotId, quantity });
    }
  }

  return {
    email,
    familyName: text(raw.familyName, "familyName", 2, 120),
    attending: form.formType === "items" ? true : boolish(raw.attending),
    adults: count(raw.adults ?? 0, "adults"),
    children: count(raw.children ?? 0, "children"),
    dietaryNotes: optionalText(raw.dietaryNotes, "dietaryNotes", 500),
    claims,
  };
}

export function isSignupClosed(
  form: { state: SignupFormState; closesAt: string | null },
  now: number = Date.now(),
): boolean {
  if (form.state !== "open") return true;
  if (!form.closesAt) return false;
  const deadline = Date.parse(form.closesAt);
  return Number.isFinite(deadline) && deadline <= now;
}

export async function hashSignupToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function issueSignupToken(): Promise<{
  token: string;
  tokenHash: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { token, tokenHash: await hashSignupToken(token) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- src/signups.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 5: Type-check**

Run: `bun run type-check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/signups.ts src/signups.test.ts
git commit -m "feat(signups): add signup domain types, validation, and token issuance"
```

---

### Task 3: Store — form and slot persistence, public read

**Files:**
- Create: `src/signup-store.ts`
- Test: `src/signup-store.test.ts`

**Interfaces:**
- Consumes: everything Task 2 produces.
- Produces:
  - `createSignupForm(env: SignupBindings, input: SignupFormInput, actorId: string): Promise<SignupFormDetail>`
  - `updateSignupForm(env: SignupBindings, id: string, input: SignupFormInput, expectedRevision: number, actorId: string): Promise<SignupFormDetail>`
  - `getSignupFormById(env: SignupBindings, id: string): Promise<SignupFormDetail | null>`
  - `getSignupFormBySlug(env: SignupBindings, slug: string): Promise<SignupFormDetail | null>`
  - `listSignupForms(env: SignupBindings): Promise<SignupFormSummary[]>` where `SignupFormSummary = SignupForm & { eventTitle: string; eventStartsAt: string; responseCount: number }`
  - `getPublicSignupForm(env: SignupBindings, slug: string): Promise<PublicSignupForm | null>`
  - `recordSignupAudit(env, entityType: "form" | "response", entityId: string, action: string, actorId: string | null, detail: Record<string, unknown>): D1PreparedStatement`

- [ ] **Step 1: Write the failing test**

Create `src/signup-store.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import { getPublicSignupForm, updateSignupForm } from "./signup-store";
import { SignupConflictError, validateSignupFormInput } from "./signups";
import type { SignupBindings } from "./signups";

const formInput = validateSignupFormInput({
  slug: "lego-derby-food",
  eventId: "evt-1",
  formType: "items",
  title: "Lego Derby food",
  instructions: "",
  state: "open",
  closesAt: null,
  slots: [{ label: "Hot dog buns", quantityNeeded: 3, notes: null }],
});

const formRow = {
  id: "frm-1",
  revision: 2,
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

describe("public signup form projection", () => {
  it("exposes only counts and never family data", async () => {
    const db = {
      prepare: (sql: string) => ({
        sql,
        bind() {
          return this;
        },
        first: async () =>
          sql.includes("FROM signup_forms")
            ? {
                ...formRow,
                event_slug: "lego-derby",
                event_title: "Lego Derby",
                event_starts_at: "2027-03-01T18:00:00.000Z",
              }
            : null,
        all: async () => ({
          results: [
            {
              id: "slt-1",
              form_id: "frm-1",
              position: 0,
              label: "Hot dog buns",
              quantity_needed: 3,
              notes: null,
              created_at: 1,
              updated_at: 1,
              quantity_claimed: 2,
            },
          ],
        }),
      }),
    };

    const form = await getPublicSignupForm(
      { DB: db } as unknown as SignupBindings,
      "lego-derby-food",
    );

    expect(form?.slots[0]).toEqual({
      id: "slt-1",
      label: "Hot dog buns",
      notes: null,
      quantityNeeded: 3,
      quantityClaimed: 2,
      quantityRemaining: 1,
    });
    const serialized = JSON.stringify(form);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain("dietary");
    expect(serialized).not.toContain("familyName");
    expect(serialized).not.toContain("adults");
  });

  it("reports a passed deadline as closed while staying readable", async () => {
    const db = {
      prepare: (sql: string) => ({
        sql,
        bind() {
          return this;
        },
        first: async () => ({
          ...formRow,
          closes_at: "2000-01-01T00:00:00.000Z",
          event_slug: "lego-derby",
          event_title: "Lego Derby",
          event_starts_at: "2027-03-01T18:00:00.000Z",
        }),
        all: async () => ({ results: [] }),
      }),
    };
    const form = await getPublicSignupForm(
      { DB: db } as unknown as SignupBindings,
      "lego-derby-food",
    );
    expect(form?.closed).toBe(true);
  });

  it("returns null for a draft form", async () => {
    const db = {
      prepare: () => ({
        bind() {
          return this;
        },
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    };
    await expect(
      getPublicSignupForm(
        { DB: db } as unknown as SignupBindings,
        "hidden",
      ),
    ).resolves.toBeNull();
  });
});

describe("signup form updates", () => {
  it("rejects a stale revision without writing", async () => {
    const batch = vi.fn();
    const db = {
      prepare: (sql: string) => ({
        sql,
        bind() {
          return this;
        },
        first: async () => formRow,
        all: async () => ({ results: [] }),
      }),
      batch,
    };
    await expect(
      updateSignupForm(
        { DB: db } as unknown as SignupBindings,
        "frm-1",
        formInput,
        formRow.revision - 1,
        "admin-1",
      ),
    ).rejects.toBeInstanceOf(SignupConflictError);
    expect(batch).not.toHaveBeenCalled();
  });

  it("bumps the revision and replaces slots in one batch", async () => {
    const statements: string[] = [];
    const batch = vi.fn().mockResolvedValue([]);
    const db = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          sql,
          bind() {
            return this;
          },
          first: async () => ({ ...formRow, revision: 3 }),
          all: async () => ({ results: [] }),
        };
      },
      batch,
    };
    const updated = await updateSignupForm(
      { DB: db } as unknown as SignupBindings,
      "frm-1",
      formInput,
      formRow.revision,
      "admin-1",
    );
    expect(batch).toHaveBeenCalledOnce();
    expect(statements.some((sql) => sql.includes("DELETE FROM signup_slots"))).toBe(
      true,
    );
    expect(statements.some((sql) => sql.includes("INSERT INTO signup_audit"))).toBe(
      true,
    );
    expect(updated.revision).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- src/signup-store.test.ts`
Expected: FAIL — `Failed to resolve import "./signup-store"`.

- [ ] **Step 3: Write the implementation**

Create `src/signup-store.ts`:

```typescript
import {
  SignupConflictError,
  SignupNotFoundError,
  isSignupClosed,
} from "./signups";
import type {
  PublicSignupForm,
  SignupBindings,
  SignupForm,
  SignupFormDetail,
  SignupFormInput,
  SignupFormState,
  SignupFormType,
  SignupSlot,
} from "./signups";

export type SignupFormSummary = SignupForm & {
  eventTitle: string;
  eventStartsAt: string;
  responseCount: number;
};

type FormRow = {
  id: string;
  revision: number;
  slug: string;
  event_id: string;
  form_type: SignupFormType;
  title: string;
  instructions: string;
  state: SignupFormState;
  closes_at: string | null;
  created_at: number;
  updated_at: number;
};

type SlotRow = {
  id: string;
  form_id: string;
  position: number;
  label: string;
  quantity_needed: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

const formColumns = `
  id, revision, slug, event_id, form_type, title, instructions, state,
  closes_at, created_at, updated_at
`;

// Spelled out rather than derived from formColumns: a join needs every column
// table-qualified, and string-rewriting a column list is how you get a query
// that silently selects the wrong thing.
const qualifiedFormColumns = `
  signup_forms.id, signup_forms.revision, signup_forms.slug,
  signup_forms.event_id, signup_forms.form_type, signup_forms.title,
  signup_forms.instructions, signup_forms.state, signup_forms.closes_at,
  signup_forms.created_at, signup_forms.updated_at
`;

const slotColumns = `
  id, form_id, position, label, quantity_needed, notes, created_at, updated_at
`;

const qualifiedSlotColumns = `
  signup_slots.id, signup_slots.form_id, signup_slots.position,
  signup_slots.label, signup_slots.quantity_needed, signup_slots.notes,
  signup_slots.created_at, signup_slots.updated_at
`;

function rowToForm(row: FormRow): SignupForm {
  return {
    id: row.id,
    revision: row.revision,
    slug: row.slug,
    eventId: row.event_id,
    formType: row.form_type,
    title: row.title,
    instructions: row.instructions,
    state: row.state,
    closesAt: row.closes_at,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function rowToSlot(row: SlotRow): SignupSlot {
  return {
    id: row.id,
    formId: row.form_id,
    position: row.position,
    label: row.label,
    quantityNeeded: row.quantity_needed,
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function recordSignupAudit(
  env: SignupBindings,
  entityType: "form" | "response",
  entityId: string,
  action: string,
  actorId: string | null,
  detail: Record<string, unknown> = {},
) {
  return env.DB.prepare(
    `INSERT INTO signup_audit
       (id, entity_type, entity_id, action, actor_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    entityType,
    entityId,
    action,
    actorId,
    JSON.stringify(detail),
    Date.now(),
  );
}

async function readSlots(
  env: SignupBindings,
  formId: string,
): Promise<SignupSlot[]> {
  const rows = await env.DB.prepare(
    `SELECT ${slotColumns} FROM signup_slots WHERE form_id = ?
     ORDER BY position ASC`,
  )
    .bind(formId)
    .all<SlotRow>();
  return rows.results.map(rowToSlot);
}

export async function getSignupFormById(
  env: SignupBindings,
  id: string,
): Promise<SignupFormDetail | null> {
  const row = await env.DB.prepare(
    `SELECT ${formColumns} FROM signup_forms WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<FormRow>();
  if (!row) return null;
  return { ...rowToForm(row), slots: await readSlots(env, row.id) };
}

export async function getSignupFormBySlug(
  env: SignupBindings,
  slug: string,
): Promise<SignupFormDetail | null> {
  const row = await env.DB.prepare(
    `SELECT ${formColumns} FROM signup_forms WHERE slug = ? LIMIT 1`,
  )
    .bind(slug)
    .first<FormRow>();
  if (!row) return null;
  return { ...rowToForm(row), slots: await readSlots(env, row.id) };
}

export async function listSignupForms(
  env: SignupBindings,
): Promise<SignupFormSummary[]> {
  const rows = await env.DB.prepare(
    `SELECT ${qualifiedFormColumns},
       calendar_events.title AS event_title,
       calendar_events.starts_at AS event_starts_at,
       (SELECT COUNT(*) FROM signup_responses
         WHERE signup_responses.form_id = signup_forms.id) AS response_count
     FROM signup_forms
     JOIN calendar_events ON calendar_events.id = signup_forms.event_id
     ORDER BY calendar_events.starts_at DESC, signup_forms.slug ASC`,
  ).all<
    FormRow & {
      event_title: string;
      event_starts_at: string;
      response_count: number;
    }
  >();
  return rows.results.map((row) => ({
    ...rowToForm(row),
    eventTitle: row.event_title,
    eventStartsAt: row.event_starts_at,
    responseCount: row.response_count,
  }));
}

export async function getPublicSignupForm(
  env: SignupBindings,
  slug: string,
): Promise<PublicSignupForm | null> {
  const row = await env.DB.prepare(
    `SELECT ${qualifiedFormColumns},
            calendar_events.slug AS event_slug,
            calendar_events.title AS event_title,
            calendar_events.starts_at AS event_starts_at
     FROM signup_forms
     JOIN calendar_events ON calendar_events.id = signup_forms.event_id
     WHERE signup_forms.slug = ? AND signup_forms.state != 'draft'
     LIMIT 1`,
  )
    .bind(slug)
    .first<
      FormRow & {
        event_slug: string;
        event_title: string;
        event_starts_at: string;
      }
    >();
  if (!row) return null;

  const slots = await env.DB.prepare(
    `SELECT ${qualifiedSlotColumns},
       (SELECT COALESCE(SUM(quantity), 0) FROM signup_claims
         WHERE signup_claims.slot_id = signup_slots.id) AS quantity_claimed
     FROM signup_slots
     WHERE signup_slots.form_id = ?
     ORDER BY signup_slots.position ASC`,
  )
    .bind(row.id)
    .all<SlotRow & { quantity_claimed: number }>();

  const form = rowToForm(row);
  return {
    slug: form.slug,
    formType: form.formType,
    title: form.title,
    instructions: form.instructions,
    closed: isSignupClosed(form),
    closesAt: form.closesAt,
    event: {
      slug: row.event_slug,
      title: row.event_title,
      startsAt: row.event_starts_at,
    },
    slots: slots.results.map((slot) => ({
      id: slot.id,
      label: slot.label,
      notes: slot.notes,
      quantityNeeded: slot.quantity_needed,
      quantityClaimed: slot.quantity_claimed,
      quantityRemaining: Math.max(
        0,
        slot.quantity_needed - slot.quantity_claimed,
      ),
    })),
  };
}

function slotStatements(
  env: SignupBindings,
  formId: string,
  input: SignupFormInput,
  now: number,
) {
  return input.slots.map((slot) =>
    env.DB.prepare(
      `INSERT INTO signup_slots
         (id, form_id, position, label, quantity_needed, notes,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      formId,
      slot.position,
      slot.label,
      slot.quantityNeeded,
      slot.notes,
      now,
      now,
    ),
  );
}

export async function createSignupForm(
  env: SignupBindings,
  input: SignupFormInput,
  actorId: string,
): Promise<SignupFormDetail> {
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO signup_forms
           (id, revision, slug, event_id, form_type, title, instructions,
            state, closes_at, created_at, updated_at)
         VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        input.slug,
        input.eventId,
        input.formType,
        input.title,
        input.instructions,
        input.state,
        input.closesAt,
        now,
        now,
      ),
      ...slotStatements(env, id, input, now),
      recordSignupAudit(env, "form", id, "created", actorId, {
        slug: input.slug,
        formType: input.formType,
      }),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed: signup_forms\.slug/.test(String(error))) {
      throw new SignupConflictError("Another signup already uses that slug.");
    }
    throw error;
  }
  const form = await getSignupFormById(env, id);
  if (!form) throw new Error("Created signup form could not be read.");
  return form;
}

export async function updateSignupForm(
  env: SignupBindings,
  id: string,
  input: SignupFormInput,
  expectedRevision: number,
  actorId: string,
): Promise<SignupFormDetail> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new SignupConflictError("Invalid expectedRevision.");
  }
  const existing = await getSignupFormById(env, id);
  if (!existing) throw new SignupNotFoundError("Signup form not found.");
  if (existing.revision !== expectedRevision) {
    throw new SignupConflictError("The signup changed since it was loaded.");
  }

  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE signup_forms
         SET revision = revision + 1, slug = ?, event_id = ?, form_type = ?,
             title = ?, instructions = ?, state = ?, closes_at = ?,
             updated_at = ?
         WHERE id = ? AND revision = ?`,
      ).bind(
        input.slug,
        input.eventId,
        input.formType,
        input.title,
        input.instructions,
        input.state,
        input.closesAt,
        now,
        id,
        expectedRevision,
      ),
      // Slots are replaced wholesale. Claims reference slots with ON DELETE
      // CASCADE, so editing the item list after families have claimed items
      // clears those claims; the admin page warns before saving.
      env.DB.prepare(`DELETE FROM signup_slots WHERE form_id = ?`).bind(id),
      ...slotStatements(env, id, input, now),
      recordSignupAudit(env, "form", id, "updated", actorId, {
        slug: input.slug,
        state: input.state,
        slotCount: input.slots.length,
      }),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed: signup_forms\.slug/.test(String(error))) {
      throw new SignupConflictError("Another signup already uses that slug.");
    }
    throw error;
  }

  const form = await getSignupFormById(env, id);
  if (!form) throw new SignupNotFoundError("Signup form not found.");
  return form;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- src/signup-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `bun run type-check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/signup-store.ts src/signup-store.test.ts
git commit -m "feat(signups): add signup form persistence and public projection"
```

---

### Task 4: Store — responses, claims, and token lookup

**Files:**
- Modify: `src/signup-store.ts` (append)
- Test: `src/signup-response-store.test.ts`

**Interfaces:**
- Consumes: Task 3's `recordSignupAudit`, `getSignupFormById`; Task 2's types and errors.
- Produces:
  - `createSignupResponse(env, form: SignupFormDetail, input: SignupResponseInput, tokenHash: string, ipHash: string | null): Promise<string>` returning the new response id; throws `SignupSlotFullError` when a claim oversubscribes a slot, `SignupConflictError` when the email already responded
  - `findResponseIdByEmail(env, formId: string, email: string): Promise<string | null>`
  - `rotateResponseToken(env, responseId: string, tokenHash: string, actorId: string | null): Promise<void>`
  - `getResponseByTokenHash(env, tokenHash: string): Promise<SignupResponseDetail | null>`
  - `confirmSignupResponse(env, responseId: string): Promise<void>`
  - `updateSignupResponse(env, responseId: string, input: SignupResponseInput): Promise<void>` — throws `SignupSlotFullError`
  - `deleteSignupResponse(env, responseId: string, actorId: string | null): Promise<void>`
  - `listSignupResponses(env, formId: string): Promise<SignupResponseDetail[]>`

- [ ] **Step 1: Write the failing test**

Create `src/signup-response-store.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import {
  createSignupResponse,
  getResponseByTokenHash,
  updateSignupResponse,
} from "./signup-store";
import { SignupSlotFullError, validateSignupResponseInput } from "./signups";
import type { SignupBindings, SignupFormDetail } from "./signups";

const form: SignupFormDetail = {
  id: "frm-1",
  revision: 0,
  slug: "lego-derby-food",
  eventId: "evt-1",
  formType: "items",
  title: "Lego Derby food",
  instructions: "",
  state: "open",
  closesAt: null,
  createdAt: "2027-01-01T00:00:00.000Z",
  updatedAt: "2027-01-01T00:00:00.000Z",
  slots: [
    {
      id: "slt-1",
      formId: "frm-1",
      position: 0,
      label: "Hot dog buns",
      quantityNeeded: 3,
      notes: null,
      createdAt: "2027-01-01T00:00:00.000Z",
      updatedAt: "2027-01-01T00:00:00.000Z",
    },
  ],
};

const input = validateSignupResponseInput(
  {
    email: "parent@example.com",
    familyName: "Hatcher",
    attending: true,
    adults: 2,
    children: 1,
    dietaryNotes: "Peanut allergy",
    claims: [{ slotId: "slt-1", quantity: 2 }],
  },
  form,
);

function dbWithBatch(batch: ReturnType<typeof vi.fn>) {
  return {
    prepare: (sql: string) => ({
      sql,
      bind() {
        return this;
      },
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
    batch,
  };
}

describe("signup response creation", () => {
  it("stores the response, its claims, and an audit row in one batch", async () => {
    const statements: string[] = [];
    const batch = vi.fn().mockResolvedValue([]);
    const db = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          sql,
          bind() {
            return this;
          },
          first: async () => null,
          all: async () => ({ results: [] }),
        };
      },
      batch,
    };
    const id = await createSignupResponse(
      { DB: db } as unknown as SignupBindings,
      form,
      input,
      "hash-1",
      "ip-hash",
    );
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(batch).toHaveBeenCalledOnce();
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_responses")),
    ).toBe(true);
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_claims")),
    ).toBe(true);
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_audit")),
    ).toBe(true);
  });

  it("translates the capacity trigger abort into SignupSlotFullError", async () => {
    const batch = vi
      .fn()
      .mockRejectedValue(new Error("D1_ERROR: signup slot is full"));
    await expect(
      createSignupResponse(
        { DB: dbWithBatch(batch) } as unknown as SignupBindings,
        form,
        input,
        "hash-1",
        null,
      ),
    ).rejects.toBeInstanceOf(SignupSlotFullError);
  });
});

describe("signup response updates", () => {
  it("replaces claims and surfaces a full slot as SignupSlotFullError", async () => {
    const batch = vi
      .fn()
      .mockRejectedValue(new Error("D1_ERROR: signup slot is full"));
    await expect(
      updateSignupResponse(
        { DB: dbWithBatch(batch) } as unknown as SignupBindings,
        "rsp-1",
        input,
      ),
    ).rejects.toBeInstanceOf(SignupSlotFullError);
  });
});

describe("token lookup", () => {
  it("returns null for an unknown hash", async () => {
    const db = {
      prepare: () => ({
        bind() {
          return this;
        },
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    };
    await expect(
      getResponseByTokenHash(
        { DB: db } as unknown as SignupBindings,
        "nope",
      ),
    ).resolves.toBeNull();
  });

  it("maps a row plus its claims into a detail object", async () => {
    const db = {
      prepare: (sql: string) => ({
        sql,
        bind() {
          return this;
        },
        first: async () => ({
          id: "rsp-1",
          form_id: "frm-1",
          email: "parent@example.com",
          family_name: "Hatcher",
          attending: 1,
          adults: 2,
          children: 1,
          dietary_notes: "Peanut allergy",
          status: "unconfirmed",
          confirmed_at: null,
          created_at: 1,
          updated_at: 1,
          form_slug: "lego-derby-food",
          form_title: "Lego Derby food",
          form_type: "items",
        }),
        all: async () => ({
          results: [{ slot_id: "slt-1", label: "Hot dog buns", quantity: 2 }],
        }),
      }),
    };
    const detail = await getResponseByTokenHash(
      { DB: db } as unknown as SignupBindings,
      "hash-1",
    );
    expect(detail).toMatchObject({
      id: "rsp-1",
      attending: true,
      status: "unconfirmed",
      claims: [{ slotId: "slt-1", label: "Hot dog buns", quantity: 2 }],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- src/signup-response-store.test.ts`
Expected: FAIL — `createSignupResponse` is not exported from `./signup-store`.

- [ ] **Step 3: Append the implementation to `src/signup-store.ts`**

Add these imports to the existing import block at the top of the file:

```typescript
import {
  SignupConflictError,
  SignupNotFoundError,
  SignupSlotFullError,
  isSignupClosed,
} from "./signups";
import type {
  PublicSignupForm,
  SignupBindings,
  SignupForm,
  SignupFormDetail,
  SignupFormInput,
  SignupFormState,
  SignupResponseDetail,
  SignupResponseInput,
  SignupResponseStatus,
  SignupFormType,
  SignupSlot,
} from "./signups";
```

Append to the end of `src/signup-store.ts`:

```typescript
type ResponseRow = {
  id: string;
  form_id: string;
  email: string;
  family_name: string;
  attending: number;
  adults: number;
  children: number;
  dietary_notes: string | null;
  status: SignupResponseStatus;
  confirmed_at: number | null;
  created_at: number;
  updated_at: number;
  form_slug: string;
  form_title: string;
  form_type: SignupFormType;
};

type ClaimRow = { slot_id: string; label: string; quantity: number };

const responseSelect = `
  SELECT signup_responses.id, signup_responses.form_id, signup_responses.email,
         signup_responses.family_name, signup_responses.attending,
         signup_responses.adults, signup_responses.children,
         signup_responses.dietary_notes, signup_responses.status,
         signup_responses.confirmed_at, signup_responses.created_at,
         signup_responses.updated_at,
         signup_forms.slug AS form_slug,
         signup_forms.title AS form_title,
         signup_forms.form_type AS form_type
  FROM signup_responses
  JOIN signup_forms ON signup_forms.id = signup_responses.form_id
`;

function isSlotFull(error: unknown): boolean {
  return /signup slot is full/.test(String(error));
}

function isDuplicateEmail(error: unknown): boolean {
  return /UNIQUE constraint failed: signup_responses\.form_id/.test(
    String(error),
  );
}

async function readClaims(
  env: SignupBindings,
  responseId: string,
): Promise<Array<{ slotId: string; label: string; quantity: number }>> {
  const rows = await env.DB.prepare(
    `SELECT signup_claims.slot_id, signup_slots.label, signup_claims.quantity
     FROM signup_claims
     JOIN signup_slots ON signup_slots.id = signup_claims.slot_id
     WHERE signup_claims.response_id = ?
     ORDER BY signup_slots.position ASC`,
  )
    .bind(responseId)
    .all<ClaimRow>();
  return rows.results.map((row) => ({
    slotId: row.slot_id,
    label: row.label,
    quantity: row.quantity,
  }));
}

function rowToResponse(
  row: ResponseRow,
  claims: Array<{ slotId: string; label: string; quantity: number }>,
): SignupResponseDetail {
  return {
    id: row.id,
    formId: row.form_id,
    formSlug: row.form_slug,
    formTitle: row.form_title,
    formType: row.form_type,
    email: row.email,
    familyName: row.family_name,
    attending: row.attending === 1,
    adults: row.adults,
    children: row.children,
    dietaryNotes: row.dietary_notes,
    status: row.status,
    confirmedAt:
      row.confirmed_at === null
        ? null
        : new Date(row.confirmed_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    claims,
  };
}

function claimStatements(
  env: SignupBindings,
  responseId: string,
  input: SignupResponseInput,
  now: number,
) {
  return input.claims.map((claim) =>
    env.DB.prepare(
      `INSERT INTO signup_claims
         (id, response_id, slot_id, quantity, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      responseId,
      claim.slotId,
      claim.quantity,
      now,
    ),
  );
}

export async function createSignupResponse(
  env: SignupBindings,
  form: SignupFormDetail,
  input: SignupResponseInput,
  tokenHash: string,
  ipHash: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO signup_responses
           (id, form_id, email, family_name, attending, adults, children,
            dietary_notes, status, confirmed_at, token_hash, ip_hash,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unconfirmed', NULL, ?, ?, ?, ?)`,
      ).bind(
        id,
        form.id,
        input.email,
        input.familyName,
        input.attending ? 1 : 0,
        input.adults,
        input.children,
        input.dietaryNotes,
        tokenHash,
        ipHash,
        now,
        now,
      ),
      ...claimStatements(env, id, input, now),
      recordSignupAudit(env, "response", id, "created", null, {
        formId: form.id,
        claimCount: input.claims.length,
      }),
    ]);
  } catch (error) {
    if (isSlotFull(error)) {
      throw new SignupSlotFullError("A requested item is already covered.");
    }
    if (isDuplicateEmail(error)) {
      throw new SignupConflictError("That email already signed up.");
    }
    throw error;
  }
  return id;
}

export async function findResponseIdByEmail(
  env: SignupBindings,
  formId: string,
  email: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM signup_responses WHERE form_id = ? AND email = ? LIMIT 1`,
  )
    .bind(formId, email)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function rotateResponseToken(
  env: SignupBindings,
  responseId: string,
  tokenHash: string,
  actorId: string | null,
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE signup_responses SET token_hash = ?, updated_at = ? WHERE id = ?`,
    ).bind(tokenHash, now, responseId),
    recordSignupAudit(env, "response", responseId, "link_resent", actorId),
  ]);
}

export async function getResponseByTokenHash(
  env: SignupBindings,
  tokenHash: string,
): Promise<SignupResponseDetail | null> {
  const row = await env.DB.prepare(
    `${responseSelect} WHERE signup_responses.token_hash = ? LIMIT 1`,
  )
    .bind(tokenHash)
    .first<ResponseRow>();
  if (!row) return null;
  return rowToResponse(row, await readClaims(env, row.id));
}

export async function confirmSignupResponse(
  env: SignupBindings,
  responseId: string,
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE signup_responses
       SET status = 'confirmed', confirmed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'unconfirmed'`,
    ).bind(now, now, responseId),
    recordSignupAudit(env, "response", responseId, "confirmed", null),
  ]);
}

export async function updateSignupResponse(
  env: SignupBindings,
  responseId: string,
  input: SignupResponseInput,
): Promise<void> {
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE signup_responses
         SET family_name = ?, attending = ?, adults = ?, children = ?,
             dietary_notes = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(
        input.familyName,
        input.attending ? 1 : 0,
        input.adults,
        input.children,
        input.dietaryNotes,
        now,
        responseId,
      ),
      // Claims are replaced inside the same batch. D1 runs a batch in one
      // implicit transaction, so an oversubscribed slot aborts the trigger and
      // rolls back the delete along with it.
      env.DB.prepare(`DELETE FROM signup_claims WHERE response_id = ?`).bind(
        responseId,
      ),
      ...claimStatements(env, responseId, input, now),
      recordSignupAudit(env, "response", responseId, "updated", null, {
        claimCount: input.claims.length,
      }),
    ]);
  } catch (error) {
    if (isSlotFull(error)) {
      throw new SignupSlotFullError("A requested item is already covered.");
    }
    throw error;
  }
}

export async function deleteSignupResponse(
  env: SignupBindings,
  responseId: string,
  actorId: string | null,
): Promise<void> {
  await env.DB.batch([
    recordSignupAudit(env, "response", responseId, "deleted", actorId),
    env.DB.prepare(`DELETE FROM signup_responses WHERE id = ?`).bind(
      responseId,
    ),
  ]);
}

export async function listSignupResponses(
  env: SignupBindings,
  formId: string,
): Promise<SignupResponseDetail[]> {
  const rows = await env.DB.prepare(
    `${responseSelect} WHERE signup_responses.form_id = ?
     ORDER BY signup_responses.created_at ASC`,
  )
    .bind(formId)
    .all<ResponseRow>();
  const details: SignupResponseDetail[] = [];
  for (const row of rows.results) {
    details.push(rowToResponse(row, await readClaims(env, row.id)));
  }
  return details;
}
```

Note on `deleteSignupResponse`: the audit row is written **before** the delete because `signup_audit.entity_id` is a plain TEXT column with no foreign key, so the audit survives the row it describes.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- src/signup-response-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `bun run type-check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/signup-store.ts src/signup-response-store.test.ts
git commit -m "feat(signups): add response, claim, and magic-link token persistence"
```

---

### Task 5: Magic-link email

**Files:**
- Create: `src/signup-email.ts`
- Test: `src/signup-email.test.ts`

**Interfaces:**
- Consumes: `SignupBindings` from Task 2.
- Produces:
  - `signupLinkUrl(env: SignupBindings, token: string): string`
  - `renderSignupEmail(options: SignupEmailOptions): { subject: string; text: string; html: string }` where `SignupEmailOptions = { familyName: string; formTitle: string; linkUrl: string; closesAt: string | null }`. There is deliberately no separate event title: `SignupFormDetail` does not carry one, and form titles ("Lego Derby food") already name the event.
  - `sendSignupLinkEmail(env: SignupBindings, recipient: { email: string; name: string }, options: SignupEmailOptions): Promise<void>` — throws on delivery failure

- [ ] **Step 1: Write the failing test**

Create `src/signup-email.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import {
  renderSignupEmail,
  sendSignupLinkEmail,
  signupLinkUrl,
} from "./signup-email";
import type { SignupBindings } from "./signups";

const env = {
  PUBLIC_SITE_ORIGIN: "https://www.macon170.com",
  INVITE_FROM_EMAIL: "volunteers@macon170.com",
  INVITE_FROM_NAME: "Pack 170 Volunteers",
  INVITE_REPLY_TO: "contact@macon170.com",
} as unknown as SignupBindings;

const options = {
  familyName: "Hatcher & <Family>",
  formTitle: "Lego Derby food",
  linkUrl: "https://www.macon170.com/signups/edit/?token=abc",
  closesAt: "2027-02-28T23:00:00.000Z",
};

describe("signup magic link", () => {
  it("builds an edit URL on the public site origin", () => {
    expect(signupLinkUrl(env, "abc123")).toBe(
      "https://www.macon170.com/signups/edit/?token=abc123",
    );
  });

  it("url-encodes the token", () => {
    expect(signupLinkUrl(env, "a b&c")).toContain("token=a%20b%26c");
  });
});

describe("signup email rendering", () => {
  it("includes the link in both parts and escapes HTML in names", () => {
    const message = renderSignupEmail(options);
    expect(message.subject).toContain("Lego Derby");
    expect(message.text).toContain(options.linkUrl);
    expect(message.html).toContain(options.linkUrl);
    expect(message.html).toContain("&lt;Family&gt;");
    expect(message.html).not.toContain("<Family>");
  });

  it("mentions the deadline only when one is set", () => {
    expect(renderSignupEmail(options).text).toMatch(/February 28, 2027/);
    expect(
      renderSignupEmail({ ...options, closesAt: null }).text,
    ).not.toMatch(/Sign up by/);
  });
});

describe("signup email delivery", () => {
  it("sends through the EMAIL binding with the configured sender", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await sendSignupLinkEmail(
      { ...env, EMAIL: { send } } as unknown as SignupBindings,
      { email: "parent@example.com", name: "Hatcher" },
      options,
    );
    expect(send).toHaveBeenCalledOnce();
    const message = send.mock.calls[0][0];
    expect(message.from.email).toBe("volunteers@macon170.com");
    expect(message.to.email).toBe("parent@example.com");
    expect(message.replyTo).toBe("contact@macon170.com");
  });

  it("throws when the binding is missing", async () => {
    await expect(
      sendSignupLinkEmail(
        env,
        { email: "parent@example.com", name: "Hatcher" },
        options,
      ),
    ).rejects.toThrow("email");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- src/signup-email.test.ts`
Expected: FAIL — `Failed to resolve import "./signup-email"`.

- [ ] **Step 3: Write the implementation**

Create `src/signup-email.ts`:

```typescript
import type { SignupBindings } from "./signups";

export type SignupEmailOptions = {
  familyName: string;
  formTitle: string;
  linkUrl: string;
  closesAt: string | null;
};

const deadlineFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "long",
  day: "numeric",
  year: "numeric",
});

export function signupLinkUrl(env: SignupBindings, token: string): string {
  const origin = env.PUBLIC_SITE_ORIGIN ?? "https://www.macon170.com";
  return `${origin}/signups/edit/?token=${encodeURIComponent(token)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderSignupEmail(options: SignupEmailOptions): {
  subject: string;
  text: string;
  html: string;
} {
  const deadline = options.closesAt
    ? deadlineFormat.format(new Date(options.closesAt))
    : null;
  const deadlineLine = deadline ? `Sign up by ${deadline}.` : "";

  const text = [
    `Thanks for signing up for ${options.formTitle}.`,
    "",
    "Use this link to confirm your signup and to change it later:",
    options.linkUrl,
    "",
    "Keep the link. It is the only way to update your response.",
    deadlineLine,
    "",
    "Pack 170",
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");

  const html = [
    `<p>Thanks for signing up for ${escapeHtml(options.formTitle)}.</p>`,
    `<p><a href="${escapeHtml(options.linkUrl)}">Confirm your signup for ${escapeHtml(options.formTitle)}</a></p>`,
    "<p>Keep this link. It is the only way to update your response.</p>",
    deadline ? `<p>Sign up by ${escapeHtml(deadline)}.</p>` : "",
    `<p>Thanks, ${escapeHtml(options.familyName)} — Pack 170</p>`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    subject: `Confirm your ${options.formTitle} signup`,
    text,
    html,
  };
}

export async function sendSignupLinkEmail(
  env: SignupBindings,
  recipient: { email: string; name: string },
  options: SignupEmailOptions,
): Promise<void> {
  if (!env.EMAIL || !env.INVITE_FROM_EMAIL) {
    throw new Error("The signup email binding is not configured.");
  }
  const rendered = renderSignupEmail(options);
  const message: Record<string, unknown> = {
    from: {
      email: env.INVITE_FROM_EMAIL,
      name: env.INVITE_FROM_NAME ?? "Pack 170 Volunteers",
    },
    to: { email: recipient.email, name: recipient.name },
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  };
  if (env.INVITE_REPLY_TO) message.replyTo = env.INVITE_REPLY_TO;
  await env.EMAIL.send(message);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- src/signup-email.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/signup-email.ts src/signup-email.test.ts
git commit -m "feat(signups): add magic-link email rendering and delivery"
```

---

### Task 6: Public API handler

**Files:**
- Create: `src/signup-public.ts`
- Test: `src/signup-public.test.ts`
- Modify: `src/request-handler.ts` (route registration)
- Modify: `wrangler.jsonc` (add `SIGNUP_RATE_LIMITER`)
- Modify: `.dev.vars.example` (no new vars needed — verify and leave unchanged if so)

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `isPublicSignupPath(pathname: string): boolean`
  - `handlePublicSignupRequest(request: Request, env: SignupBindings, fetchImpl?: typeof fetch): Promise<Response>`

Route map:

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/signups/v1/forms/:slug` | public form projection |
| `POST` | `/api/signups/v1/forms/:slug/responses` | submit, email link |
| `GET` | `/api/signups/v1/responses/:token` | load and confirm |
| `PATCH` | `/api/signups/v1/responses/:token` | update |
| `DELETE` | `/api/signups/v1/responses/:token` | withdraw |
| `OPTIONS` | any of the above | CORS preflight |

- [ ] **Step 1: Add the rate limiter binding**

In `wrangler.jsonc`, extend the existing `ratelimits` array:

```jsonc
"ratelimits": [
  {
    "name": "CONTACT_RATE_LIMITER",
    "namespace_id": "17004",
    "simple": { "limit": 6, "period": 60 }
  },
  {
    "name": "SIGNUP_RATE_LIMITER",
    "namespace_id": "17005",
    "simple": { "limit": 10, "period": 60 }
  }
],
```

- [ ] **Step 2: Write the failing test**

Create `src/signup-public.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import {
  handlePublicSignupRequest,
  isPublicSignupPath,
} from "./signup-public";
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

const turnstileOk = vi.fn().mockResolvedValue(
  new Response(JSON.stringify({ success: true, action: "turnstile-spin-v2", hostname: "www.macon170.com" })),
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
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toBe("Signup not found.");
  });

  it("confirms an unconfirmed response on the first valid token use", async () => {
    const batch = vi.fn().mockResolvedValue([]);
    const db = {
      prepare: (sql: string) => ({
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
      }),
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
    const sql = batch.mock.calls
      .flat(2)
      .map((statement: { sql?: string }) => statement.sql ?? "")
      .join("\n");
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run test:unit -- src/signup-public.test.ts`
Expected: FAIL — `Failed to resolve import "./signup-public"`.

- [ ] **Step 4: Write the implementation**

Create `src/signup-public.ts`:

```typescript
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

async function stableHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function verifyTurnstile(
  token: string,
  request: Request,
  env: SignupBindings,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!env.TURNSTILE_SECRET) {
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
  if (
    !outcome.success ||
    (outcome.action && outcome.action !== expectedAction) ||
    (outcome.hostname && !hostnames.has(outcome.hostname))
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
          decodeURIComponent(rest.slice(0, -"/responses".length)),
          fetchImpl,
        ),
        corsOrigin,
      );
    }
    if (request.method !== "GET") {
      throw new SignupRequestError(405, "validation", "Method not allowed.");
    }
    const form = await getPublicSignupForm(env, decodeURIComponent(rest));
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
        path: url.pathname,
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
  const input = validateSignupResponseInput(raw, form);

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

  const rateKey = await stableHash(
    `${input.email}|${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
  );
  const limit = await env.SIGNUP_RATE_LIMITER.limit({ key: rateKey });
  if (!limit.success) {
    throw new SignupRequestError(
      429,
      "rate_limit",
      "Too many signups were submitted. Wait a minute and try again.",
    );
  }

  await verifyTurnstile(token, request, env, fetchImpl);

  const ipHash = await stableHash(
    request.headers.get("CF-Connecting-IP") ?? "unknown",
  );

  // Exactly one token is minted per submission. A first-time submit stores its
  // hash on the new row; a repeat submit rotates the existing row's hash. Both
  // paths then email that same token, so there is never a link whose hash was
  // not persisted.
  const { token, tokenHash } = await issueSignupToken();
  const existingId = await findResponseIdByEmail(env, form.id, input.email);
  let responseId: string;

  if (existingId) {
    responseId = existingId;
    await rotateResponseToken(env, responseId, tokenHash, null);
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
        await rotateResponseToken(env, responseId, tokenHash, null);
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
        familyName: input.familyName,
        formTitle: form.title,
        linkUrl: signupLinkUrl(env, token),
        closesAt: form.closesAt,
      },
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
    await hashSignupToken(decodeURIComponent(rawToken)),
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
    await hashSignupToken(decodeURIComponent(rawToken)),
  );
  return json({ version: SIGNUP_VERSION, response: updated });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test:unit -- src/signup-public.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire the route into the request handler**

In `src/request-handler.ts`, add the import beside the existing calendar and contact imports:

```typescript
import {
  handlePublicSignupRequest,
  isPublicSignupPath,
} from "./signup-public";
import type { SignupBindings } from "./signups";
```

Widen the env cast near the top of the returned handler:

```typescript
const env = rawEnv as CalendarBindings & ContactBindings & SignupBindings;
```

Immediately after the existing `isPublicCalendarPath` block, add:

```typescript
    if (isPublicSignupPath(pathname)) {
      return handlePublicSignupRequest(request, env);
    }
```

- [ ] **Step 7: Verify the wiring and type-check**

Run: `bun run type-check && bun run test:unit`
Expected: no type errors; all unit tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/signup-public.ts src/signup-public.test.ts src/request-handler.ts wrangler.jsonc
git commit -m "feat(signups): add public signup API with magic-link issuance"
```

---

### Task 7: Admin API and admin pages

**Files:**
- Create: `src/signup-admin-page.ts`
- Create: `src/signup-admin.ts`
- Test: `src/signup-admin.test.ts`
- Modify: `src/request-handler.ts` (page route, API route, permission helper)

**Interfaces:**
- Consumes: Tasks 2–5, plus `authenticate`, `ensureCsrfToken`, `validateMutationCsrf`, `errorResponse`, `htmlResponse` already private to `request-handler.ts`.
- Produces:
  - `renderSignupAdminPage(csrfToken: string): string` and `renderSignupAdminDetailPage(csrfToken: string, formId: string): string` from `src/signup-admin-page.ts`
  - `handleAdminSignupRequest(request, env, user: { userId: string; email: string }): Promise<Response>` from `src/signup-admin.ts`
  - `summarizeSignupResponses(responses: SignupResponseDetail[]): { families: number; attending: number; adults: number; children: number; unconfirmed: number }` from `src/signup-admin.ts`
- A generalized permission check replaces `hasCalendarPermission`: `hasPermission(env, user, permissionName: string): Promise<boolean>`. `hasCalendarPermission` becomes a thin wrapper so the calendar behavior is unchanged.

Admin API routes under `/api/signups-admin/v1`:

| Method | Relative path | Behavior |
| --- | --- | --- |
| `GET` | `/session` | user, permission, CSRF token |
| `GET` | `/forms` | all forms with event and response counts |
| `POST` | `/forms` | create |
| `GET` | `/forms/:id` | form detail, responses, summary |
| `PUT` | `/forms/:id` | update, requires `expectedRevision` |
| `DELETE` | `/responses/:id` | delete one response |
| `POST` | `/responses/:id/resend` | rotate token and email a new link |

- [ ] **Step 1: Write the failing test**

Create `src/signup-admin.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { summarizeSignupResponses } from "./signup-admin";
import type { SignupResponseDetail } from "./signups";

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- src/signup-admin.test.ts`
Expected: FAIL — `Failed to resolve import "./signup-admin"`.

- [ ] **Step 3: Write the admin module**

Create `src/signup-admin.ts`:

```typescript
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
        permission: "signups.manage",
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
      const id = decodeURIComponent(resend ? rest.slice(0, -"/resend".length) : rest);
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
        { version: SIGNUP_VERSION, error: { code: error.code, message: error.message } },
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
        { version: SIGNUP_VERSION, error: { code: "not_found", message: "Signup not found." } },
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
      { version: SIGNUP_VERSION, error: { code: "temporary", message: "Signup service unavailable." } },
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- src/signup-admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the admin pages**

Create `src/signup-admin-page.ts`. It follows `src/calendar-admin-page.ts`: a server-rendered shell whose inline script talks to the admin API with the CSRF header. Open `src/calendar-admin-page.ts` first and mirror its markup structure, class names, and inline-script conventions so the two pages look like siblings.

```typescript
import { renderAdminHeader } from "./admin-header";

export function renderSignupAdminPage(csrfToken: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Signups · Pack 170 CMS</title>
</head>
<body>
${renderAdminHeader("Signups")}
<main id="app" data-csrf="${csrfToken}">
  <p>Loading signups…</p>
</main>
<script type="module">
const CSRF = ${JSON.stringify(csrfToken)};
const app = document.querySelector('#app');
const response = await fetch('/api/signups-admin/v1/forms', {
  headers: { 'X-CSRF-Token': CSRF },
  credentials: 'same-origin',
});
const data = await response.json();
if (!response.ok) {
  app.textContent = data.error?.message ?? 'Unable to load signups.';
} else if (data.forms.length === 0) {
  app.textContent = 'No signup forms yet.';
} else {
  const list = document.createElement('ul');
  for (const form of data.forms) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = '/admin/signups/' + encodeURIComponent(form.id);
    link.textContent = form.title + ' — ' + form.eventTitle;
    const meta = document.createElement('span');
    meta.textContent = ' · ' + form.state + ' · ' + form.responseCount + ' responses';
    item.append(link, meta);
    list.append(item);
  }
  app.replaceChildren(list);
}
</script>
</body>
</html>`;
}

export function renderSignupAdminDetailPage(
  csrfToken: string,
  formId: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Signup detail · Pack 170 CMS</title>
</head>
<body>
${renderAdminHeader("Signups")}
<main id="app" data-form-id="${formId}" data-csrf="${csrfToken}">
  <p>Loading signup…</p>
</main>
<script type="module">
const CSRF = ${JSON.stringify(csrfToken)};
const FORM_ID = ${JSON.stringify(formId)};
const app = document.querySelector('#app');

function cell(row, text) {
  const td = document.createElement('td');
  td.textContent = text;
  row.append(td);
}

async function load() {
  const response = await fetch('/api/signups-admin/v1/forms/' + encodeURIComponent(FORM_ID), {
    headers: { 'X-CSRF-Token': CSRF },
    credentials: 'same-origin',
  });
  const data = await response.json();
  if (!response.ok) {
    app.textContent = data.error?.message ?? 'Unable to load this signup.';
    return;
  }

  const heading = document.createElement('h1');
  heading.textContent = data.form.title;

  const summary = document.createElement('p');
  summary.textContent =
    data.summary.families + ' families · ' +
    data.summary.attending + ' attending · ' +
    data.summary.adults + ' adults · ' +
    data.summary.children + ' children · ' +
    data.summary.unconfirmed + ' unconfirmed';

  const slots = document.createElement('ul');
  for (const slot of data.form.slots) {
    const claimed = data.responses
      .flatMap((entry) => entry.claims)
      .filter((claim) => claim.slotId === slot.id)
      .reduce((total, claim) => total + claim.quantity, 0);
    const item = document.createElement('li');
    item.textContent = slot.label + ': ' + claimed + ' of ' + slot.quantityNeeded + ' claimed';
    slots.append(item);
  }

  const table = document.createElement('table');
  const header = document.createElement('tr');
  for (const label of ['Family', 'Email', 'Attending', 'Adults', 'Children', 'Dietary', 'Bringing', 'Status', 'Signed up', '']) {
    const th = document.createElement('th');
    th.textContent = label;
    header.append(th);
  }
  table.append(header);

  for (const entry of data.responses) {
    const row = document.createElement('tr');
    cell(row, entry.familyName);
    cell(row, entry.email);
    cell(row, entry.attending ? 'Yes' : 'No');
    cell(row, String(entry.adults));
    cell(row, String(entry.children));
    cell(row, entry.dietaryNotes ?? '—');
    cell(row, entry.claims.map((claim) => claim.label + ' ×' + claim.quantity).join(', ') || '—');
    cell(row, entry.status === 'confirmed' ? 'Confirmed' : 'Unconfirmed');
    cell(row, new Date(entry.createdAt).toLocaleDateString());

    const actions = document.createElement('td');
    const resend = document.createElement('button');
    resend.type = 'button';
    resend.textContent = 'Resend link';
    resend.addEventListener('click', async () => {
      resend.disabled = true;
      await fetch('/api/signups-admin/v1/responses/' + encodeURIComponent(entry.id) + '/resend', {
        method: 'POST',
        headers: { 'X-CSRF-Token': CSRF },
        credentials: 'same-origin',
      });
      resend.textContent = 'Link sent';
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      await fetch('/api/signups-admin/v1/responses/' + encodeURIComponent(entry.id), {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': CSRF },
        credentials: 'same-origin',
      });
      await load();
    });
    actions.append(resend, remove);
    row.append(actions);
    table.append(row);
  }

  app.replaceChildren(heading, summary, slots, table);
}

await load();
</script>
</body>
</html>`;
}
```

Before writing this file, run `sed -n 1,40p src/admin-header.ts` to confirm the exact exported name and signature of the header helper, and adjust the import if it differs.

- [ ] **Step 6: Wire the admin routes into the request handler**

In `src/request-handler.ts`:

Add imports:

```typescript
import { SIGNUP_ADMIN_BASE, handleAdminSignupRequest } from "./signup-admin";
import {
  renderSignupAdminDetailPage,
  renderSignupAdminPage,
} from "./signup-admin-page";
import { SIGNUP_PERMISSION } from "./signups";
```

Generalize the permission helper. The existing `hasCalendarPermission` at `src/request-handler.ts:833` already contains exactly the query needed; parameterize the permission name and keep the old function as a wrapper so calendar behavior is provably unchanged:

```typescript
async function hasPermission(
  env: CalendarBindings,
  user: AuthenticatedUser,
  permissionName: string,
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
    .bind(user.userId, permissionName, permissionName)
    .first<{ id: string }>();
  return Boolean(row);
}

async function hasCalendarPermission(
  env: CalendarBindings,
  user: AuthenticatedUser,
): Promise<boolean> {
  return hasPermission(env, user, CALENDAR_PERMISSION);
}
```

The SQL above is the current implementation verbatim with `CALENDAR_PERMISSION` replaced by the `permissionName` parameter. Diff it against the file before saving to confirm nothing else drifted.

Add the page routes next to the `/admin/calendar` block:

```typescript
    if (pathname === "/admin/signups" || pathname.startsWith("/admin/signups/")) {
      if (request.method !== "GET") {
        return errorResponse(405, "method_not_allowed", "Method not allowed.");
      }
      const user = await authenticate(request, env);
      if (!user) {
        return Response.redirect(
          `${url.origin}/auth/login?returnTo=${encodeURIComponent(pathname)}`,
          302,
        );
      }
      if (!(await hasPermission(env, user, SIGNUP_PERMISSION))) {
        return errorResponse(
          403,
          "forbidden",
          `The ${SIGNUP_PERMISSION} permission is required.`,
        );
      }
      const csrf = await ensureCsrfToken(request, env);
      if (csrf instanceof Response) return csrf;
      const formId = pathname.slice("/admin/signups/".length);
      const response = htmlResponse(
        formId
          ? renderSignupAdminDetailPage(csrf.token, decodeURIComponent(formId))
          : renderSignupAdminPage(csrf.token),
      );
      response.headers.append("Set-Cookie", csrf.cookie);
      return response;
    }
```

Add the API route beside the `/api/calendar-admin/v1` block:

```typescript
    if (pathname.startsWith(SIGNUP_ADMIN_BASE)) {
      const user = await authenticate(request, env);
      if (!user) return errorResponse(401, "unauthorized", "Sign in required.");
      if (!(await hasPermission(env, user, SIGNUP_PERMISSION))) {
        return errorResponse(
          403,
          "forbidden",
          `The ${SIGNUP_PERMISSION} permission is required.`,
        );
      }
      if (!["GET", "HEAD"].includes(request.method)) {
        const csrfError = await validateMutationCsrf(request, env);
        if (csrfError) return csrfError;
      }
      const csrf = await ensureCsrfToken(request, env);
      return handleAdminSignupRequest(
        request,
        env,
        user,
        csrf instanceof Response ? null : csrf,
      );
    }
```

- [ ] **Step 7: Add the request-handler tests**

Append to `src/request-handler.test.ts`. This file uses single quotes and no semicolons — match it, not the `src/` style. It already imports `AuthManager` and `generateCsrfToken` from `@sonicjs-cms/core/middleware` and defines the `cmsEnv(origins?, db?, appVersion?)` helper and `executionContext`; reuse both.

```typescript
describe('signup admin routing', () => {
  const secret = 'test-secret-that-is-not-used-in-production'

  it('returns 403 without the signups.manage permission', async () => {
    const token = await AuthManager.generateToken(
      'editor-1',
      'editor@example.test',
      'editor',
      secret,
    )
    // The permission query finds no row, so the grant check fails.
    const db = {
      prepare: () => ({
        bind() {
          return this
        },
        first: async () => null,
      }),
    }
    const response = await createCmsRequestHandler(vi.fn())(
      new Request('https://cms.macon170.com/api/signups-admin/v1/forms', {
        headers: { Cookie: `auth_token=${token}` },
      }),
      cmsEnv(undefined, db),
      executionContext,
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'forbidden',
        message: 'The signups.manage permission is required.',
      },
    })
  })

  it('rejects a mutation without the CSRF header', async () => {
    const token = await AuthManager.generateToken(
      'admin-1',
      'admin@example.test',
      'admin',
      secret,
    )
    // The permission query finds a row, so authorization passes and the
    // request reaches the CSRF gate.
    const db = {
      prepare: () => ({
        bind() {
          return this
        },
        first: async () => ({ id: 'admin-1' }),
      }),
      batch: vi.fn(),
    }
    const response = await createCmsRequestHandler(vi.fn())(
      new Request('https://cms.macon170.com/api/signups-admin/v1/forms', {
        method: 'POST',
        headers: {
          Cookie: `auth_token=${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      cmsEnv(undefined, db),
      executionContext,
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'invalid_csrf', message: 'Security token rejected.' },
    })
    expect(db.batch).not.toHaveBeenCalled()
  })

  it('requires the signups.manage permission for the admin page', async () => {
    const token = await AuthManager.generateToken(
      'editor-1',
      'editor@example.test',
      'editor',
      secret,
    )
    const db = {
      prepare: () => ({
        bind() {
          return this
        },
        first: async () => null,
      }),
    }
    const response = await createCmsRequestHandler(vi.fn())(
      new Request('https://cms.macon170.com/admin/signups', {
        headers: { Cookie: `auth_token=${token}` },
      }),
      cmsEnv(undefined, db),
      executionContext,
    )
    expect(response.status).toBe(403)
  })

  it('redirects an anonymous visitor to login with a returnTo', async () => {
    const response = await createCmsRequestHandler(vi.fn())(
      new Request('https://cms.macon170.com/admin/signups'),
      cmsEnv(),
      executionContext,
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(
      'https://cms.macon170.com/auth/login?returnTo=%2Fadmin%2Fsignups',
    )
  })
})
```

If the exact `forbidden` message differs from what the implementation produces, fix the expectation to match the implementation rather than loosening the assertion.

- [ ] **Step 8: Run the full unit suite and type-check**

Run: `bun run type-check && bun run test:unit`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/signup-admin.ts src/signup-admin-page.ts src/signup-admin.test.ts src/request-handler.ts src/request-handler.test.ts
git commit -m "feat(signups): add volunteer admin queue and management API"
```

---

### Task 8: Retention and cron

**Files:**
- Modify: `src/signup-store.ts` (append `runSignupRetention`)
- Modify: `src/index.ts` (call it from `scheduled`)
- Test: `src/signup-retention.test.ts`

**Interfaces:**
- Consumes: `SIGNUP_UNCONFIRMED_HOURS`, `SIGNUP_RETENTION_DAYS`, `SIGNUP_AUDIT_RETENTION_DAYS` from Task 2.
- Produces: `runSignupRetention(env: SignupBindings): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/signup-retention.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import { runSignupRetention } from "./signup-store";
import type { SignupBindings } from "./signups";

function collectingDb() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => ({
      sql,
      bind(...values: unknown[]) {
        statements.push({ sql, values });
        return this;
      },
    }),
    batch: vi
      .fn()
      .mockResolvedValue([
        { meta: { changes: 2 } },
        { meta: { changes: 1 } },
        { meta: { changes: 0 } },
      ]),
  };
  return { db, statements };
}

describe("signup retention", () => {
  it("purges unconfirmed responses past the 24 hour window", async () => {
    const { db, statements } = collectingDb();
    await runSignupRetention({ DB: db } as unknown as SignupBindings);
    const purge = statements.find(
      (entry) =>
        entry.sql.includes("DELETE FROM signup_responses") &&
        entry.sql.includes("'unconfirmed'"),
    );
    expect(purge).toBeDefined();
    const cutoff = purge?.values[0] as number;
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(24 * 60 * 60 * 1_000);
    expect(Date.now() - cutoff).toBeLessThan(25 * 60 * 60 * 1_000);
  });

  it("deletes aged responses but never their forms or slots", async () => {
    const { db, statements } = collectingDb();
    await runSignupRetention({ DB: db } as unknown as SignupBindings);
    const sql = statements.map((entry) => entry.sql).join("\n");
    expect(sql).toContain("DELETE FROM signup_responses");
    expect(sql).not.toContain("DELETE FROM signup_forms");
    expect(sql).not.toContain("DELETE FROM signup_slots");
  });

  it("purges audit rows older than a year", async () => {
    const { db, statements } = collectingDb();
    await runSignupRetention({ DB: db } as unknown as SignupBindings);
    const audit = statements.find((entry) =>
      entry.sql.includes("DELETE FROM signup_audit"),
    );
    expect(audit).toBeDefined();
    const cutoff = audit?.values[0] as number;
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(
      365 * 24 * 60 * 60 * 1_000,
    );
  });

  it("runs every pass in a single batch", async () => {
    const { db } = collectingDb();
    await runSignupRetention({ DB: db } as unknown as SignupBindings);
    expect(db.batch).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit -- src/signup-retention.test.ts`
Expected: FAIL — `runSignupRetention` is not exported from `./signup-store`.

- [ ] **Step 3: Append the implementation to `src/signup-store.ts`**

Add `SIGNUP_AUDIT_RETENTION_DAYS`, `SIGNUP_RETENTION_DAYS`, and `SIGNUP_UNCONFIRMED_HOURS` to the value import from `./signups`, then append:

```typescript
export async function runSignupRetention(env: SignupBindings): Promise<void> {
  const now = Date.now();
  const unconfirmedCutoff = now - SIGNUP_UNCONFIRMED_HOURS * 60 * 60 * 1_000;
  const responseCutoff = now - SIGNUP_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
  const auditCutoff = now - SIGNUP_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

  const results = await env.DB.batch([
    // Unconfirmed responses expire quickly; their claims cascade, which
    // releases the slot they were holding.
    env.DB.prepare(
      `DELETE FROM signup_responses
       WHERE status = 'unconfirmed' AND created_at < ?`,
    ).bind(unconfirmedCutoff),
    // Retention removes families, never the volunteer's shopping list: forms
    // and slots survive so next year's coordinator can reuse them.
    env.DB.prepare(
      `DELETE FROM signup_responses
       WHERE form_id IN (
         SELECT signup_forms.id
           FROM signup_forms
           JOIN calendar_events ON calendar_events.id = signup_forms.event_id
          WHERE COALESCE(calendar_events.ends_at, calendar_events.starts_at) < ?
       )`,
    ).bind(new Date(responseCutoff).toISOString()),
    env.DB.prepare(`DELETE FROM signup_audit WHERE created_at < ?`).bind(
      auditCutoff,
    ),
  ]);

  console.log(
    JSON.stringify({
      event: "signup_retention_cleanup",
      unconfirmedHours: SIGNUP_UNCONFIRMED_HOURS,
      retentionDays: SIGNUP_RETENTION_DAYS,
      unconfirmedDeleted: results[0]?.meta?.changes ?? 0,
      agedResponsesDeleted: results[1]?.meta?.changes ?? 0,
      auditDeleted: results[2]?.meta?.changes ?? 0,
    }),
  );
}
```

Note the second statement binds an **ISO string**, not a millisecond number, because `calendar_events.starts_at` and `ends_at` are stored as ISO text.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:unit -- src/signup-retention.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the cron**

In `src/index.ts`, extend the imports and the `scheduled` handler:

```typescript
import { runSignupRetention } from './signup-store'
import type { SignupBindings } from './signups'
```

```typescript
  async scheduled(_controller: ScheduledController, env: Bindings): Promise<void> {
    await runContactRetention(env as ContactBindings)
    await runSignupRetention(env as SignupBindings)
  },
```

Contact retention runs first and each call is independently awaited, so a signup failure cannot skip contact cleanup on a later deploy reordering. If signup retention throws, the Workers cron invocation is marked failed and appears in observability logs.

- [ ] **Step 6: Run the full suite and type-check**

Run: `bun run type-check && bun run test`
Expected: unit tests, the contact migration contract, and the signup migration contract all pass.

- [ ] **Step 7: Commit**

```bash
git add src/signup-store.ts src/signup-retention.test.ts src/index.ts
git commit -m "feat(signups): purge unconfirmed and aged signup responses on cron"
```

---

### Task 9: Runbook and deployment checklist

**Files:**
- Create: `docs/signups.md`
- Modify: `README.md` (link the runbook beside calendar and contact)

**Interfaces:**
- Consumes: everything. Produces documentation only.

- [ ] **Step 1: Write the runbook**

Create `docs/signups.md`, matching the structure of `docs/calendar.md` and `docs/contact.md`:

````markdown
# Event signups

The CMS owns signup forms, their slots, family responses, the public JSON
contract, and magic-link delivery. Signup records are separate from SonicJS's
generic form tables so slot capacity, family identity, and retention pass
through the same validated controls as the calendar.

## Volunteer workflow

Visit `https://cms.macon170.com/admin/signups`. Access requires an active CMS
account with the `signups.manage` permission. Administrators receive it by
default; an administrator grants it to another volunteer by adding the user and
`perm_signups_manage` permission IDs to `user_permissions`.

Each signup is attached to one calendar event and is one of two types:

- **`rsvp`** — attendance intent with adult and child headcounts. No items.
- **`items`** — a list of items with quantities; families claim what they bring.

Forms start as `draft` and are invisible publicly. Set `state` to `open` to
accept responses, `closed` to stop them. A `closesAt` deadline closes the form
automatically without another edit.

Editing an `items` form replaces its slot list, and claims reference slots with
`ON DELETE CASCADE`. Changing the item list after families have claimed items
therefore clears those claims. Add items rather than reordering or renaming once
a form is open.

## Public API

All JSON is camelCase and includes `version: "v1"`.

- `GET /api/signups/v1/forms/:slug` — form, deadline, closed flag, and per-slot
  `quantityNeeded`, `quantityClaimed`, `quantityRemaining`. Draft forms 404;
  closed forms stay readable. Never returns names, emails, dietary notes, or
  headcounts.
- `POST /api/signups/v1/forms/:slug/responses` — family submits; the response is
  created `unconfirmed` and a magic link is emailed.
- `GET /api/signups/v1/responses/:token` — loads the response and confirms it on
  first valid use.
- `PATCH /api/signups/v1/responses/:token` — updates headcount, dietary note, or
  claims.
- `DELETE /api/signups/v1/responses/:token` — withdraws.

Submitting again with an email that already responded is **not** an error: it
rotates that response's token and emails a fresh link. This is the "I lost my
link" recovery path and it keeps the endpoint from revealing whether an address
already signed up.

The management API lives under `/api/signups-admin/v1`. It is same-origin,
requires authentication and `signups.manage`, requires the signed CSRF
cookie/header pair for mutations, and uses `expectedRevision` for form updates.

## Stored data

`signup_responses` holds the family email, family name, attendance flag, adult
and child counts, an optional dietary note, confirmation status, the SHA-256 of
the magic-link token, and a hash of the submitting IP. The raw token is never
stored — it exists only in the email. Dietary notes, names, and emails are
returned by the admin API only.

## Security controls

- Request bodies are bounded at 8 KB, including bodies with no `Content-Length`.
- Writes require the configured `PUBLIC_SITE_ORIGIN`, with explicit preflight
  behavior. Reads are allowed cross-origin.
- A filled honeypot returns success and stores nothing.
- `SIGNUP_RATE_LIMITER` keys on a hash of email plus connecting IP.
- Turnstile is verified server-side against the CMS secret, expected hostnames,
  and expected action.
- Unknown, malformed, and deleted tokens all return the same generic 404.
- Slot capacity is enforced by the `signup_claims_capacity_insert` and
  `signup_claims_capacity_update` triggers. An oversubscribed claim aborts the
  enclosing D1 batch, and the API returns 409 with refreshed availability.

## Retention

The daily CMS cron runs three passes:

1. `unconfirmed` responses older than 24 hours are deleted; their claims cascade
   and the slot becomes available again.
2. Responses for forms whose event ended more than 90 days ago are deleted.
   Forms and slots are kept deliberately, so a volunteer can reuse last year's
   shopping list.
3. `signup_audit` rows older than 365 days are deleted.

Each pass logs its deleted-row count, including zero.

## Local setup and validation

```bash
bun install --frozen-lockfile
bun run db:migrate:local
bun run type-check
bun run test
```

`bun run test` includes `scripts/test-signup-migrations.mjs`, which applies core
and custom migrations to a temporary local D1 database, reapplies the custom
migrations as a no-op, and asserts the tables, capacity triggers, permission
rows, over-subscription abort, and claim cascade.

## Cutover

1. Confirm `SIGNUP_RATE_LIMITER` is present in `wrangler.jsonc`. No new secrets
   are required; Turnstile and email reuse the contact and invite configuration.
2. Deploy the CMS and apply its migrations in an approved window.
3. Verify `/admin/signups` renders for an administrator and returns 403 for a
   user without `signups.manage`.
4. Create one `items` form against a test event, submit a response from the
   public API, confirm the email arrives, follow the link, and change the claim.
5. Deploy the public-site frontend once its own plan is complete.

Do not deploy or apply remote migrations until separately approved.

## Troubleshooting

- `409` with code `slot_full`: expected when a slot filled between page load and
  submit. The response body carries the refreshed form; re-render it.
- `502` on submit: the response saved but email delivery failed. The family
  submits again to resend; check the `EMAIL` binding and sender address.
- `security` on a valid-looking request: confirm the request `Origin` matches
  `PUBLIC_SITE_ORIGIN` and that the Turnstile hostname and action match the
  committed settings.
- Admin queue redirects to login: expected without a CMS session.
- Admin queue returns 403 after login: verify the user is active and holds
  `signups.manage`.
- Mutation returns `invalid_csrf`: reload the page for a fresh signed
  cookie/token pair.
- A volunteer reports claims disappeared: the form's item list was edited, which
  cascades claims. Recover the claimed items from `signup_audit`.
````

- [ ] **Step 2: Link the runbook from the README**

In `README.md`, in the paragraph that already references `docs/calendar.md` and `docs/contact.md`, add a sentence:

```markdown
Event signups — attendance intent and item claims attached to a calendar event —
use the workflow documented in [docs/signups.md](docs/signups.md).
```

- [ ] **Step 3: Verify the whole suite one final time**

Run: `bun run type-check && bun run test && bun run deploy:dry`
Expected: type-check clean, all tests pass, dry-run deploy succeeds with the new `SIGNUP_RATE_LIMITER` binding resolved.

- [ ] **Step 4: Commit**

```bash
git add docs/signups.md README.md
git commit -m "docs(signups): add event signup runbook and cutover checklist"
```

---

## Follow-up work (not in this plan)

- **Astro frontend plan.** The family-facing signup page, the magic-link edit
  page, and Playwright e2e coverage live in `macon170.com`. That plan requires
  exploring that repo's page, component, and design conventions and must be
  written separately. Per the spec's rollout order, the CMS ships first.
- **Submodule pointer bump.** After both repos deploy, bump both pointers in the
  `macon170` meta repo in one commit.
