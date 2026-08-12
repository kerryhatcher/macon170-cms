# Signup Form Admin CRUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a volunteer create and edit event signup forms from the CMS admin UI, instead of calling the admin API directly, without ever letting an edit silently delete a family's claim on an item they didn't touch.

**Architecture:** All work happens in `macon170-cms` on the already-created worktree/branch at `/Users/kerry.hatcher/projects/hatek/macon170/worktrees/signup-admin-crud` (branch `feat/signup-admin-crud`) — every command below assumes that directory as the working directory. Two layers change: (1) a backend fix so `updateSignupForm` reconciles a form's item list by each item's stable `id` instead of replacing the whole list on any change, and (2) a new admin-page UI (settings panel, event picker, item editor) built on top of the existing `POST /api/signups-admin/v1/forms` / `PUT .../forms/:id` endpoints, which already accept everything the UI needs to send.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), Vitest, SonicJS admin conventions (server-rendered HTML with an inline `<script type="module">`, no client framework).

## Global Constraints

- No `macon170.com` (frontend) changes — everything is in `macon170-cms`.
- No new D1 migration — `signup_slots.id` already exists on every row.
- Server-side field limits, copied from `signups.ts`, are the source of truth; the UI's own limits must match: slug pattern `^[a-z0-9]+(?:-[a-z0-9]+)*$` (2–80 chars), title 2–120 chars, instructions ≤2000 chars, slot label 1–120 chars, slot notes ≤300 chars, slot quantity 1–500, an `items` form needs 1–60 slots.
- Run `bun run type-check` and `bun run test` (which runs `vitest --run` plus the SQL/migration contract scripts) after every task in this repo; both must be clean before moving to the next task.
- Every new git commit is made from `/Users/kerry.hatcher/projects/hatek/macon170/worktrees/signup-admin-crud` on branch `feat/signup-admin-crud`. Do not create another worktree and do not touch the shared `macon170-cms/` checkout.

---

### Task 1: Carry a stable slot id through validation

**Files:**
- Modify: `src/signups.ts:44-49` (`SignupSlotInput` type), `src/signups.ts:236-260` (slot mapping inside `validateSignupFormInput`)
- Test: `src/signups.test.ts`

**Interfaces:**
- Produces: `SignupSlotInput.id?: string` — every later task that reconciles slots by identity depends on this field existing and being passed through unchanged by `validateSignupFormInput`.

- [ ] **Step 1: Write the failing test**

Add to `src/signups.test.ts`, inside the existing `describe("signup form validation", ...)` block (after the `"rejects a slot quantity below one"` test):

```ts
  it("passes an existing slot's id through unchanged and drops an empty one", () => {
    const result = validateSignupFormInput({
      ...formInput,
      slots: [
        { id: "slot-1", label: "Hot dog buns", quantityNeeded: 3, notes: null },
        { id: "", label: "Drinks", quantityNeeded: 2, notes: null },
      ],
    });
    expect(result.slots[0]?.id).toBe("slot-1");
    expect(result.slots[1]?.id).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- signups.test.ts`
Expected: FAIL — `result.slots[0]?.id` is `undefined`, not `"slot-1"` (the field doesn't exist on the returned object yet).

- [ ] **Step 3: Write minimal implementation**

In `src/signups.ts`, change `SignupSlotInput` (currently lines 44-49):

```ts
export type SignupSlotInput = {
  id?: string;
  position: number;
  label: string;
  quantityNeeded: number;
  notes: string | null;
};
```

Then in `validateSignupFormInput`, change the slot-mapping block (currently lines 236-260) so the returned object includes `id`:

```ts
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
            id:
              typeof slot.id === "string" && slot.id.length > 0
                ? slot.id
                : undefined,
            position: index,
            label: text(slot.label, "label", 1, 120),
            quantityNeeded,
            notes: optionalText(slot.notes, "notes", 300),
          };
        });
```

No format validation on `id` beyond "non-empty string" — Task 2's store logic reconciles it against the form's real stored slot ids, so a spoofed or stale id just falls into the "insert as new" path rather than matching anything.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- signups.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/signups.ts src/signups.test.ts
git commit -m "feat(signups): carry a stable slot id through form validation"
```

---

### Task 2: Reconcile a form's slots by id instead of replacing them wholesale

**Files:**
- Modify: `src/signup-store.ts:261-306` (replace `slotStatements` and `slotsUnchanged`), `src/signup-store.ts:308-349` (`createSignupForm`), `src/signup-store.ts:351-437` (`updateSignupForm`)
- Test: `src/signup-store.test.ts`

**Interfaces:**
- Consumes: `SignupSlotInput.id?: string` from Task 1.
- Produces: `updateSignupForm(env, id, input, expectedRevision, actorId): Promise<SignupFormDetail>` — unchanged signature and two-phase optimistic-concurrency contract; only its slot-reconciliation internals change. Later tasks (the admin UI) rely on this: submitting an existing slot's `id` back unchanged now leaves that row's claims untouched, and omitting a previously-submitted id is what removes a slot and its claims.

This is the fix the design review found necessary: today, `updateSignupForm` deletes and reinserts the *entire* slot list on any difference, and `signup_claims.slot_id` cascades on delete — so adding one new item to an open form deletes every family's claims on every item, not just the new one. Reconciling by id means only a genuinely removed slot loses its claims.

- [ ] **Step 1: Write the failing tests**

Three of these are new tests; two are rewrites of existing tests whose assertions describe the old wholesale-replace behavior and would otherwise keep "passing" while asserting the wrong thing. Open `src/signup-store.test.ts` and make these changes:

Replace the existing `"bumps the revision and replaces slots in one batch"` test (currently lines 175-214) with:

```ts
  it("bumps the revision and inserts new slots in one batch", async () => {
    const statements: string[] = [];
    const batch = vi.fn().mockResolvedValue([]);
    let firstCalls = 0;
    const db = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          sql,
          bind() {
            return this;
          },
          first: async () => {
            firstCalls += 1;
            return firstCalls === 1 ? formRow : { ...formRow, revision: 3 };
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
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
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_slots")),
    ).toBe(true);
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_audit")),
    ).toBe(true);
    expect(updated.revision).toBe(3);
  });
```

Replace the existing `"keeps the stored slots when a save changes only form metadata"` test (currently lines 216-268) with:

```ts
  it("keeps the stored slot row when a save changes only form metadata", async () => {
    // A volunteer fixing a typo in the title submits the same slot, by id.
    // Reconciling by id must recognize it as unchanged and skip the UPDATE
    // as well as any DELETE/INSERT — a title-only save must never touch
    // signup_slots at all.
    const statements: string[] = [];
    const batch = vi.fn().mockResolvedValue([]);
    let firstCalls = 0;
    const storedSlot = {
      id: "slt-1",
      form_id: "frm-1",
      position: 0,
      label: "Hot dog buns",
      quantity_needed: 3,
      notes: null,
      created_at: 1,
      updated_at: 1,
    };
    const db = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          sql,
          bind() {
            return this;
          },
          first: async () => {
            firstCalls += 1;
            return firstCalls === 1 ? formRow : { ...formRow, revision: 3 };
          },
          all: async () => ({ results: [storedSlot] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch,
    };
    await updateSignupForm(
      { DB: db } as unknown as SignupBindings,
      "frm-1",
      {
        ...formInput,
        slots: [
          {
            id: "slt-1",
            position: 0,
            label: "Hot dog buns",
            quantityNeeded: 3,
            notes: null,
          },
        ],
        title: "Lego Derby food (fixed)",
      },
      formRow.revision,
      "admin-1",
    );
    expect(batch).toHaveBeenCalledOnce();
    expect(
      statements.some((sql) => sql.includes("DELETE FROM signup_slots")),
    ).toBe(false);
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_slots")),
    ).toBe(false);
    expect(
      statements.some((sql) => sql.includes("UPDATE signup_slots")),
    ).toBe(false);
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_audit")),
    ).toBe(true);
  });
```

Leave the existing `"replaces slots when the submitted item list differs"` test (lines 270-318) and `"rejects a losing racer without touching slots (TOCTOU guard)"` test (lines 320-357) as they are — both scenarios (a submitted slot with no id that doesn't match anything stored; a losing optimistic-concurrency racer) produce the same observable statements under the new reconciliation logic, so they still pass unchanged.

Add three new tests after the `"replaces slots when the submitted item list differs"` test:

```ts
  it("inserts a new slot without touching an existing one's row", async () => {
    // The bug this fixes: adding "napkins" to an open items form used to
    // replace the entire slot list, cascading every family's claims via
    // ON DELETE CASCADE — not just claims on the new row. Reconciling by id
    // means the existing slot's row is neither deleted nor updated.
    const statements: string[] = [];
    const batch = vi.fn().mockResolvedValue([]);
    let firstCalls = 0;
    const storedSlot = {
      id: "slt-1",
      form_id: "frm-1",
      position: 0,
      label: "Hot dog buns",
      quantity_needed: 3,
      notes: null,
      created_at: 1,
      updated_at: 1,
    };
    const db = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          sql,
          bind() {
            return this;
          },
          first: async () => {
            firstCalls += 1;
            return firstCalls === 1 ? formRow : { ...formRow, revision: 3 };
          },
          all: async () => ({ results: [storedSlot] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch,
    };
    await updateSignupForm(
      { DB: db } as unknown as SignupBindings,
      "frm-1",
      {
        ...formInput,
        slots: [
          {
            id: "slt-1",
            position: 0,
            label: "Hot dog buns",
            quantityNeeded: 3,
            notes: null,
          },
          { position: 1, label: "Napkins", quantityNeeded: 2, notes: null },
        ],
      },
      formRow.revision,
      "admin-1",
    );
    expect(
      statements.some((sql) => sql.includes("DELETE FROM signup_slots")),
    ).toBe(false);
    expect(
      statements.some((sql) => sql.includes("UPDATE signup_slots")),
    ).toBe(false);
    expect(
      statements.some((sql) => sql.includes("INSERT INTO signup_slots")),
    ).toBe(true);
  });

  it("removes only the deleted slot, leaving another slot's row untouched", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const batch = vi.fn().mockResolvedValue([]);
    let firstCalls = 0;
    const keptSlot = {
      id: "slt-keep",
      form_id: "frm-1",
      position: 0,
      label: "Hot dog buns",
      quantity_needed: 3,
      notes: null,
      created_at: 1,
      updated_at: 1,
    };
    const removedSlot = {
      id: "slt-remove",
      form_id: "frm-1",
      position: 1,
      label: "Drinks",
      quantity_needed: 2,
      notes: null,
      created_at: 1,
      updated_at: 1,
    };
    const db = {
      prepare: (sql: string) => {
        const call = { sql, args: [] as unknown[] };
        statements.push(call);
        return {
          sql,
          bind(...args: unknown[]) {
            call.args = args;
            return this;
          },
          first: async () => {
            firstCalls += 1;
            return firstCalls === 1 ? formRow : { ...formRow, revision: 3 };
          },
          all: async () => ({ results: [keptSlot, removedSlot] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch,
    };
    await updateSignupForm(
      { DB: db } as unknown as SignupBindings,
      "frm-1",
      {
        ...formInput,
        slots: [
          {
            id: "slt-keep",
            position: 0,
            label: "Hot dog buns",
            quantityNeeded: 3,
            notes: null,
          },
        ],
      },
      formRow.revision,
      "admin-1",
    );
    const deletes = statements.filter((call) =>
      call.sql.includes("DELETE FROM signup_slots"),
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.args).toContain("slt-remove");
    expect(
      statements.some(
        (call) =>
          call.sql.includes("DELETE FROM signup_slots") &&
          call.args.includes("slt-keep"),
      ),
    ).toBe(false);
  });

  it("updates a slot in place by id instead of deleting and reinserting it", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const batch = vi.fn().mockResolvedValue([]);
    let firstCalls = 0;
    const storedSlot = {
      id: "slt-1",
      form_id: "frm-1",
      position: 0,
      label: "Hot dog buns",
      quantity_needed: 3,
      notes: null,
      created_at: 1,
      updated_at: 1,
    };
    const db = {
      prepare: (sql: string) => {
        const call = { sql, args: [] as unknown[] };
        statements.push(call);
        return {
          sql,
          bind(...args: unknown[]) {
            call.args = args;
            return this;
          },
          first: async () => {
            firstCalls += 1;
            return firstCalls === 1 ? formRow : { ...formRow, revision: 3 };
          },
          all: async () => ({ results: [storedSlot] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch,
    };
    await updateSignupForm(
      { DB: db } as unknown as SignupBindings,
      "frm-1",
      {
        ...formInput,
        slots: [
          {
            id: "slt-1",
            position: 0,
            label: "Hot dog rolls",
            quantityNeeded: 4,
            notes: null,
          },
        ],
      },
      formRow.revision,
      "admin-1",
    );
    expect(
      statements.some((call) => call.sql.includes("DELETE FROM signup_slots")),
    ).toBe(false);
    const updates = statements.filter((call) =>
      call.sql.includes("UPDATE signup_slots"),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args).toContain("Hot dog rolls");
    expect(updates[0]?.args).toContain(4);
  });

  it("removes every slot when the form type switches from items to rsvp", async () => {
    // validateSignupFormInput forces slots: [] for formType "rsvp"
    // (signups.ts:238-239), so this is the one case that is still fully
    // destructive by nature, not by a wholesale-replace bug: there is
    // nothing left for any slot id to match, so every existing slot is a
    // removal.
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const batch = vi.fn().mockResolvedValue([]);
    let firstCalls = 0;
    const storedSlots = [
      {
        id: "slt-1",
        form_id: "frm-1",
        position: 0,
        label: "Hot dog buns",
        quantity_needed: 3,
        notes: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: "slt-2",
        form_id: "frm-1",
        position: 1,
        label: "Drinks",
        quantity_needed: 2,
        notes: null,
        created_at: 1,
        updated_at: 1,
      },
    ];
    const db = {
      prepare: (sql: string) => {
        const call = { sql, args: [] as unknown[] };
        statements.push(call);
        return {
          sql,
          bind(...args: unknown[]) {
            call.args = args;
            return this;
          },
          first: async () => {
            firstCalls += 1;
            return firstCalls === 1 ? formRow : { ...formRow, revision: 3 };
          },
          all: async () => ({ results: storedSlots }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch,
    };
    await updateSignupForm(
      { DB: db } as unknown as SignupBindings,
      "frm-1",
      { ...formInput, formType: "rsvp", slots: [] },
      formRow.revision,
      "admin-1",
    );
    const deletes = statements.filter((call) =>
      call.sql.includes("DELETE FROM signup_slots"),
    );
    expect(deletes).toHaveLength(2);
    expect(deletes.map((call) => call.args[0])).toEqual(
      expect.arrayContaining(["slt-1", "slt-2"]),
    );
    expect(
      statements.some((call) => call.sql.includes("INSERT INTO signup_slots")),
    ).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:unit -- signup-store.test.ts`
Expected: The four new tests FAIL (the current implementation always issues a wholesale `DELETE FROM signup_slots` plus reinsert, so there's no `UPDATE signup_slots` statement at all, and the delete touches `slt-keep` too since it's unconditional; the type-switch test fails because today's delete is a single unconditional `DELETE FROM signup_slots WHERE form_id = ?` rather than one bound `DELETE ... WHERE id = ? AND form_id = ?` per removed slot, so `deletes` has length 1, not 2). The rewritten `"keeps the stored slot row..."` test also FAILS as written today (current logic compares by position/label/quantity/notes, ignoring `id`, so it currently *does* skip the replace for this scenario — but only by accident; once Task 1 makes `id` a real field on the input, the failing mode to watch for is the next step's actual rewrite, not this one). The `"bumps the revision and inserts new slots"` test fails on the dropped `DELETE FROM signup_slots` assertion.

- [ ] **Step 3: Write minimal implementation**

In `src/signup-store.ts`, replace `slotStatements` and `slotsUnchanged` (currently lines 261-306) with:

```ts
function insertSlotStatements(
  env: SignupBindings,
  formId: string,
  slots: SignupSlotInput[],
  now: number,
) {
  return slots.map((slot) =>
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

type SignupSlotDiff = {
  toInsert: SignupSlotInput[];
  toUpdate: Array<{ id: string; slot: SignupSlotInput }>;
  toRemove: SignupSlot[];
};

// Reconciles the submitted slot list against the stored one by id, so a save
// only touches the rows that actually changed. A slot id absent from the
// submitted list is the only case that removes a row and, via ON DELETE
// CASCADE on signup_claims.slot_id, its claims — editing a kept slot's
// label/quantity/notes/position never touches signup_claims. Claim labels
// are joined live from signup_slots at read time (see readClaims below), so
// renaming a slot here needs no follow-up write on signup_claims.
function diffSignupSlots(
  existing: SignupSlot[],
  input: SignupSlotInput[],
): SignupSlotDiff {
  const existingById = new Map(existing.map((slot) => [slot.id, slot]));
  const keptIds = new Set<string>();
  const toInsert: SignupSlotInput[] = [];
  const toUpdate: Array<{ id: string; slot: SignupSlotInput }> = [];

  for (const slot of input) {
    const stored = slot.id ? existingById.get(slot.id) : undefined;
    if (!stored) {
      toInsert.push(slot);
      continue;
    }
    keptIds.add(stored.id);
    if (
      stored.position !== slot.position ||
      stored.label !== slot.label ||
      stored.quantityNeeded !== slot.quantityNeeded ||
      stored.notes !== slot.notes
    ) {
      toUpdate.push({ id: stored.id, slot });
    }
  }

  return {
    toInsert,
    toUpdate,
    toRemove: existing.filter((slot) => !keptIds.has(slot.id)),
  };
}

function slotDiffStatements(
  env: SignupBindings,
  formId: string,
  diff: SignupSlotDiff,
  now: number,
) {
  return [
    ...diff.toRemove.map((slot) =>
      env.DB.prepare(
        `DELETE FROM signup_slots WHERE id = ? AND form_id = ?`,
      ).bind(slot.id, formId),
    ),
    ...diff.toUpdate.map(({ id, slot }) =>
      env.DB.prepare(
        `UPDATE signup_slots
         SET position = ?, label = ?, quantity_needed = ?, notes = ?,
             updated_at = ?
         WHERE id = ? AND form_id = ?`,
      ).bind(
        slot.position,
        slot.label,
        slot.quantityNeeded,
        slot.notes,
        now,
        id,
        formId,
      ),
    ),
    ...insertSlotStatements(env, formId, diff.toInsert, now),
  ];
}
```

In `createSignupForm` (currently line 334), change:

```ts
      ...slotStatements(env, id, input, now),
```

to:

```ts
      ...insertSlotStatements(env, id, input.slots, now),
```

In `updateSignupForm`, replace the phase-2 comment and body (currently lines 399-425):

```ts
    // Phase 2: only reached if this call won the revision bump. Slots are
    // reconciled by id, so a save only touches the rows that actually
    // changed — an in-place edit to a kept slot never runs a DELETE, so it
    // never cascades a claim. Accepted trade-off: if this second batch fails
    // after phase 1 committed, the form carries the new revision with the
    // old slot rows — a failed edit the volunteer retries with the fresh
    // revision, not cross-volunteer corruption.
    const slotDiff = diffSignupSlots(existing.slots, input.slots);
    const slotsChanged =
      slotDiff.toInsert.length > 0 ||
      slotDiff.toUpdate.length > 0 ||
      slotDiff.toRemove.length > 0;
    await env.DB.batch([
      ...(slotsChanged ? slotDiffStatements(env, id, slotDiff, now) : []),
      recordSignupAudit(env, "form", id, "updated", actorId, {
        slug: input.slug,
        state: input.state,
        slotCount: input.slots.length,
        slotsChanged: {
          added: slotDiff.toInsert.length,
          updated: slotDiff.toUpdate.length,
          removed: slotDiff.toRemove.length,
        },
      }),
    ]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:unit -- signup-store.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Run the full test suite and type-check**

Run: `bun run type-check && bun run test`
Expected: PASS. (`SignupSlot` and `SignupSlotInput` are still imported the same way; no other file references `slotStatements` or `slotsUnchanged` directly, so this is a self-contained rename plus behavior change.)

- [ ] **Step 6: Commit**

```bash
git add src/signup-store.ts src/signup-store.test.ts
git commit -m "fix(signups): reconcile a form's slots by id instead of replacing them wholesale"
```

---

### Task 3: Map a stale or invalid event reference to a 400, not a 500

**Files:**
- Modify: `src/signup-store.ts` (catch blocks in `createSignupForm` and `updateSignupForm`), imports at `src/signup-store.ts:1-9`
- Test: `src/signup-store.test.ts`

**Interfaces:**
- Consumes: `SignupRequestError` (already exported from `src/signups.ts`, already handled first in `signup-admin.ts`'s catch chain — see `signup-admin.ts:194-203` — so no changes are needed outside `signup-store.ts`).

`signup_forms.event_id` is a real foreign key to `calendar_events(id)` (`migrations/custom/0004_signups.sql:6`), but `validateSignupFormInput` only length-checks `eventId` as a string. A deleted or malformed event id currently falls through every mapped error branch in `createSignupForm`/`updateSignupForm` and surfaces as a generic `500` ("Signup service unavailable") instead of a `400` the admin UI can show inline.

- [ ] **Step 1: Write the failing tests**

In `src/signup-store.test.ts`, the two import lines currently at the top of the file:

```ts
import { getPublicSignupForm, updateSignupForm } from "./signup-store";
import { SignupConflictError, validateSignupFormInput } from "./signups";
```

become:

```ts
import { createSignupForm, getPublicSignupForm, updateSignupForm } from "./signup-store";
import { SignupConflictError, SignupRequestError, validateSignupFormInput } from "./signups";
```

Then add this new `describe` block at the end of the file:

```ts
describe("event reference errors", () => {
  it("maps a foreign-key violation on create to a validation error, not a throw-through", async () => {
    const db = {
      prepare: () => ({
        bind() {
          return this;
        },
        first: async () => null,
      }),
      batch: async () => {
        throw new Error("D1_ERROR: FOREIGN KEY constraint failed");
      },
    };
    await expect(
      createSignupForm(
        { DB: db } as unknown as SignupBindings,
        formInput,
        "admin-1",
      ),
    ).rejects.toBeInstanceOf(SignupRequestError);
  });

  it("maps a foreign-key violation on update to a validation error, not a throw-through", async () => {
    const db = {
      prepare: () => ({
        bind() {
          return this;
        },
        first: async () => formRow,
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 1 } }),
      }),
      batch: async () => {
        throw new Error("D1_ERROR: FOREIGN KEY constraint failed");
      },
    };
    await expect(
      updateSignupForm(
        { DB: db } as unknown as SignupBindings,
        "frm-1",
        formInput,
        formRow.revision,
        "admin-1",
      ),
    ).rejects.toBeInstanceOf(SignupRequestError);
  });
});
```

Also add `createSignupForm` to the existing import from `./signup-store` at the top of the test file (it currently imports only `getPublicSignupForm, updateSignupForm`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:unit -- signup-store.test.ts`
Expected: FAIL — both throw the raw `Error("D1_ERROR: FOREIGN KEY constraint failed")` rather than a `SignupRequestError`.

- [ ] **Step 3: Write minimal implementation**

In `src/signup-store.ts`, add `SignupRequestError` to the existing import from `./signups` (line 1-9):

```ts
import {
  SIGNUP_AUDIT_RETENTION_DAYS,
  SIGNUP_RETENTION_DAYS,
  SIGNUP_UNCONFIRMED_HOURS,
  SignupConflictError,
  SignupNotFoundError,
  SignupRequestError,
  SignupSlotFullError,
  isSignupClosed,
} from "./signups";
```

Add a helper near `isSlotFull`/`isDuplicateEmail` (around line 473-481):

```ts
function isInvalidEventReference(error: unknown): boolean {
  return /FOREIGN KEY constraint failed/.test(String(error));
}
```

In `createSignupForm`'s catch block (currently lines 340-345):

```ts
  } catch (error) {
    if (isInvalidEventReference(error)) {
      throw new SignupRequestError(
        400,
        "validation",
        "That event no longer exists.",
      );
    }
    if (/UNIQUE constraint failed: signup_forms\.slug/.test(String(error))) {
      throw new SignupConflictError("Another signup already uses that slug.");
    }
    throw error;
  }
```

In `updateSignupForm`'s catch block (currently lines 426-432):

```ts
  } catch (error) {
    if (error instanceof SignupConflictError) throw error;
    if (isInvalidEventReference(error)) {
      throw new SignupRequestError(
        400,
        "validation",
        "That event no longer exists.",
      );
    }
    if (/UNIQUE constraint failed: signup_forms\.slug/.test(String(error))) {
      throw new SignupConflictError("Another signup already uses that slug.");
    }
    throw error;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:unit -- signup-store.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite and type-check**

Run: `bun run type-check && bun run test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/signup-store.ts src/signup-store.test.ts
git commit -m "fix(signups): map a stale event reference to a 400 instead of a 500"
```

---

### Task 4: Add pure slot/claim helpers and the "New form" link

**Files:**
- Modify: `src/signup-admin-page.ts` (add exports near the top, after `scriptSafeJson`; edit `renderSignupAdminPage`'s body string and `renderSignupShell`'s `<style>` block)
- Test: `src/signup-admin-page.test.ts`

**Interfaces:**
- Produces: `diffRemovedSlotIds(loadedSlotIds: string[], currentRows: Array<{ id?: string }>): string[]` and `countClaimedFamiliesBySlot(responses: Array<{ claims: Array<{ slotId: string }> }>): Record<string, number>` — both pure functions, unit-tested here. Task 7's inline browser script duplicates the same algorithm as plain JS (it cannot import a TS module at runtime), with a comment pointing back to these as the source of truth.

These two functions back the destructive-edit guard: `diffRemovedSlotIds` says which loaded slots are missing from the current form (i.e., about to be deleted), and `countClaimedFamiliesBySlot` says how many distinct families would lose a claim if that happens. A claim's `UNIQUE(response_id, slot_id)` constraint means each response contributes at most one claim per slot, so counting claims per slot is already counting distinct families — no separate dedup needed.

- [ ] **Step 1: Write the failing tests**

Add to `src/signup-admin-page.test.ts`:

```ts
import {
  countClaimedFamiliesBySlot,
  diffRemovedSlotIds,
  renderSignupAdminPage,
  renderSignupAdminDetailPage,
} from "./signup-admin-page";

describe("diffRemovedSlotIds", () => {
  it("returns loaded ids missing from the current rows", () => {
    expect(
      diffRemovedSlotIds(["a", "b", "c"], [{ id: "a" }, { id: "c" }]),
    ).toEqual(["b"]);
  });

  it("treats a brand-new row with no id as neither removed nor kept", () => {
    expect(diffRemovedSlotIds(["a"], [{ id: "a" }, {}])).toEqual([]);
  });

  it("returns every loaded id when the current list is empty", () => {
    expect(diffRemovedSlotIds(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("countClaimedFamiliesBySlot", () => {
  it("counts one per distinct response per slot, not claimed quantity", () => {
    const responses = [
      { claims: [{ slotId: "slot-1" }, { slotId: "slot-2" }] },
      { claims: [{ slotId: "slot-1" }] },
    ];
    expect(countClaimedFamiliesBySlot(responses)).toEqual({
      "slot-1": 2,
      "slot-2": 1,
    });
  });

  it("returns an empty object when nothing has claims", () => {
    expect(countClaimedFamiliesBySlot([])).toEqual({});
  });
});

describe("renderSignupAdminPage", () => {
  it("links to the new-signup route", () => {
    const html = renderSignupAdminPage("csrf-token");
    expect(html).toContain('href="/admin/signups/new"');
  });
});
```

This import block replaces the file's existing `import { renderSignupAdminDetailPage } from "./signup-admin-page";` line — don't leave both in place, or `renderSignupAdminDetailPage` would be imported twice.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:unit -- signup-admin-page.test.ts`
Expected: FAIL — `diffRemovedSlotIds` and `countClaimedFamiliesBySlot` don't exist yet (import error), and the list page has no `/admin/signups/new` link yet.

- [ ] **Step 3: Write minimal implementation**

In `src/signup-admin-page.ts`, add after the `scriptSafeJson` function (currently ending at line 15):

```ts
export function diffRemovedSlotIds(
  loadedSlotIds: string[],
  currentRows: Array<{ id?: string }>,
): string[] {
  const kept = new Set(
    currentRows.map((row) => row.id).filter((id): id is string => Boolean(id)),
  );
  return loadedSlotIds.filter((id) => !kept.has(id));
}

export function countClaimedFamiliesBySlot(
  responses: Array<{ claims: Array<{ slotId: string }> }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const response of responses) {
    for (const claim of response.claims) {
      counts[claim.slotId] = (counts[claim.slotId] ?? 0) + 1;
    }
  }
  return counts;
}
```

In `renderSignupShell`'s `<style>` block, add two rules (anywhere alongside the existing button/link rules, e.g. right after the existing `a { color: var(--blue); }` line):

```css
  .toolbar { align-items: center; display: flex; gap: .75rem; justify-content: space-between; }
  .new-form { background: var(--blue); border-radius: .4rem; color: white; display: inline-flex; align-items: center; font-weight: 700; min-block-size: 2.25rem; padding: .4rem .75rem; text-decoration: none; }
```

Change `renderSignupAdminPage`'s body (currently just `<main id="app">...`) to:

```ts
export function renderSignupAdminPage(csrfToken: string): string {
  const body = `<main>
  <div class="toolbar">
    <h1>Signups</h1>
    <a class="new-form" href="/admin/signups/new">New form</a>
  </div>
  <div id="app"><p>Loading signups…</p></div>
</main>`;
  const script = `const app = document.querySelector('#app');
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
}`;
  return renderSignupShell("Signups", csrfToken, body, script);
}
```

(Only the `body` constant changes from what's there today; `script` is copied unchanged — it still targets `#app`, which still exists, just nested one level deeper in `<main>` now.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:unit -- signup-admin-page.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite and type-check**

Run: `bun run type-check && bun run test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/signup-admin-page.ts src/signup-admin-page.test.ts
git commit -m "feat(signups): add slot-diff helpers and a New form link on the list page"
```

---

### Task 5: Add the form-settings panel, event picker, and create/edit save

**Files:**
- Modify: `src/signup-admin-page.ts` (`renderSignupAdminDetailPage` signature and body — full rewrite of the function; response-table logic moves into a named `renderResponses` function inside the script)
- Test: `src/signup-admin-page.test.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks (the pure helpers from Task 4 aren't wired in yet — that's Task 7).
- Produces: `renderSignupAdminDetailPage(csrfToken: string, formId: string | null): string` — `formId === null` renders create mode. Task 6 (routing) depends on this accepting `null`. Task 7 extends this same function's script to add the item editor; it assumes the DOM ids and functions introduced here (`#settings-form`, `#event-select`, `#slot-editor`, `#slot-list`, `showNotice`, `request`, `loadForm`, `renderResponses`, `toggleSlotEditor`) exist exactly as named.

RSVP forms are fully usable end to end after this task (create, edit, save, see responses). An `items` form's item list can't be edited yet — the settings panel always submits `slots: []`, so saving an `items`-type form with no items yet added will surface the server's "An item signup needs at least one item" validation message as an inline notice. That's expected and not a bug to chase here; Task 7 adds the item editor that fixes it. Nothing that works today regresses: the response table (family list, resend, delete) keeps working exactly as it does now, just refactored into a reusable function so it can also run after a save.

- [ ] **Step 1: Write the failing tests**

Add to `src/signup-admin-page.test.ts`, inside the existing `describe("renderSignupAdminDetailPage", ...)` block:

```ts
  it("renders the settings panel with the event picker and a hidden slot editor", () => {
    const html = renderSignupAdminDetailPage(
      "csrf-token",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(html).toContain('id="settings-form"');
    expect(html).toContain('id="event-select"');
    expect(html).toContain('id="slot-editor"');
  });

  it("renders create mode without a form id and without a response section", () => {
    const html = renderSignupAdminDetailPage("csrf-token", null);
    expect(html).toContain("New signup form");
    expect(html).toContain("Create signup");
    expect(html).not.toContain('id="responses-section"');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:unit -- signup-admin-page.test.ts`
Expected: FAIL. The first test fails because none of `#settings-form`/`#event-select`/`#slot-editor` exist in today's markup. The second fails both on a type error (`renderSignupAdminDetailPage` currently requires `formId: string`, so passing `null` doesn't compile) and on content, once that's fixed.

- [ ] **Step 3: Write minimal implementation**

Replace `renderSignupAdminDetailPage` (currently lines 95-200 of `src/signup-admin-page.ts`) entirely with:

```ts
export function renderSignupAdminDetailPage(
  csrfToken: string,
  formId: string | null,
): string {
  const mode = formId === null ? "create" : "edit";
  const heading = mode === "create" ? "New signup form" : "Edit signup form";
  const saveLabel = mode === "create" ? "Create signup" : "Save changes";
  const responsesSection =
    mode === "edit"
      ? `<section aria-labelledby="responses-heading" id="responses-section">
    <h2 id="responses-heading">Responses</h2>
    <div id="responses">Loading responses…</div>
  </section>`
      : "";
  const body = `<main>
  <div class="toolbar">
    <h1>${heading}</h1>
    <a href="/admin/signups">← All signups</a>
  </div>
  <div id="notice" class="notice" hidden role="status"></div>
  <section aria-labelledby="settings-heading">
    <h2 id="settings-heading">Form settings</h2>
    <form id="settings-form">
      <div class="grid">
        <label>Title<input name="title" required minlength="2" maxlength="120"></label>
        <label>URL slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxlength="80"></label>
        <label>Event<select name="eventId" id="event-select" required></select></label>
        <label>State<select name="state"><option value="draft">Draft</option><option value="open">Open</option><option value="closed">Closed</option></select></label>
        <label class="wide">Instructions<textarea name="instructions" maxlength="2000"></textarea></label>
        <label>Closes at (optional)<input name="closesAt" type="datetime-local"></label>
        <label>Form type<select name="formType" id="form-type"><option value="rsvp">RSVP (attendance only)</option><option value="items">Items (families claim what to bring)</option></select></label>
      </div>
      <fieldset id="slot-editor" hidden>
        <div class="toolbar"><strong>Items</strong></div>
        <div id="slot-list"></div>
      </fieldset>
      <div class="actions">
        <button type="submit" id="save">${saveLabel}</button>
      </div>
    </form>
  </section>
  ${responsesSection}
</main>`;
  const script = `const MODE = ${scriptSafeJson(mode)};
const FORM_ID = ${scriptSafeJson(formId)};
const notice = document.querySelector('#notice');
const settingsForm = document.querySelector('#settings-form');
const saveButton = document.querySelector('#save');
const eventSelect = document.querySelector('#event-select');
const formTypeSelect = document.querySelector('#form-type');

let currentForm = null;

function showNotice(message, kind) {
  notice.textContent = message;
  notice.dataset.kind = kind || 'message';
  notice.hidden = false;
}

const request = async (path, options = {}) => {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD'].includes(options.method || 'GET')) headers.set('X-CSRF-Token', CSRF);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'Signup request failed.');
    error.status = response.status;
    throw error;
  }
  return payload;
};

function cell(row, text) {
  const td = document.createElement('td');
  td.textContent = text;
  row.append(td);
}

const localValue = (iso) => {
  if (!iso) return '';
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const utcValue = (value) => (value ? new Date(value).toISOString() : null);

function toggleSlotEditor(formType) {
  document.querySelector('#slot-editor').hidden = formType !== 'items';
}
formTypeSelect.addEventListener('change', (event) => toggleSlotEditor(event.target.value));

async function loadEventOptions(selectedEventId) {
  try {
    const data = await request('/api/calendar-admin/v1/events');
    const upcoming = data.events
      .filter((event) => event.publicationState !== 'archived' || event.id === selectedEventId)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    eventSelect.replaceChildren(
      ...upcoming.map((event) => {
        const option = document.createElement('option');
        option.value = event.id;
        option.textContent = event.title + ' — ' + new Date(event.startsAt).toLocaleDateString();
        return option;
      }),
    );
    if (selectedEventId) eventSelect.value = selectedEventId;
    eventSelect.disabled = false;
  } catch (error) {
    if (error.status === 403 && selectedEventId) {
      const option = document.createElement('option');
      option.value = selectedEventId;
      option.textContent = 'Current event (unchanged)';
      eventSelect.replaceChildren(option);
      eventSelect.disabled = true;
      showNotice(
        'Changing the event requires the calendar.manage permission — ask an administrator.',
        'error',
      );
    } else {
      throw error;
    }
  }
}

function renderResponses(form, responses, summary) {
  const container = document.querySelector('#responses');
  if (!container) return;
  container.replaceChildren();

  const summaryLine = document.createElement('p');
  summaryLine.textContent =
    summary.families + ' families · ' +
    summary.attending + ' attending · ' +
    summary.adults + ' adults · ' +
    summary.children + ' children · ' +
    summary.unconfirmed + ' unconfirmed';
  container.append(summaryLine);

  if (form.formType === 'items') {
    const slotSummary = document.createElement('ul');
    for (const slot of form.slots) {
      const claimedQuantity = responses
        .flatMap((entry) => entry.claims)
        .filter((claim) => claim.slotId === slot.id)
        .reduce((total, claim) => total + claim.quantity, 0);
      const item = document.createElement('li');
      item.textContent = slot.label + ': ' + claimedQuantity + ' of ' + slot.quantityNeeded + ' claimed';
      slotSummary.append(item);
    }
    container.append(slotSummary);
  }

  const table = document.createElement('table');
  const header = document.createElement('tr');
  for (const label of ['Family', 'Email', 'Attending', 'Adults', 'Children', 'Dietary', 'Bringing', 'Status', 'Signed up', '']) {
    const th = document.createElement('th');
    th.textContent = label;
    header.append(th);
  }
  table.append(header);

  for (const entry of responses) {
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
      await request('/api/signups-admin/v1/responses/' + encodeURIComponent(entry.id) + '/resend', { method: 'POST' });
      resend.textContent = 'Link sent';
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      await request('/api/signups-admin/v1/responses/' + encodeURIComponent(entry.id), { method: 'DELETE' });
      await loadForm();
    });
    actions.append(resend, remove);
    row.append(actions);
    table.append(row);
  }
  container.append(table);
}

function populateSettingsForm(form) {
  settingsForm.elements.namedItem('title').value = form.title;
  settingsForm.elements.namedItem('slug').value = form.slug;
  settingsForm.elements.namedItem('state').value = form.state;
  settingsForm.elements.namedItem('instructions').value = form.instructions;
  settingsForm.elements.namedItem('closesAt').value = localValue(form.closesAt);
  settingsForm.elements.namedItem('formType').value = form.formType;
  toggleSlotEditor(form.formType);
}

async function loadForm() {
  const data = await request('/api/signups-admin/v1/forms/' + encodeURIComponent(FORM_ID));
  currentForm = data.form;
  populateSettingsForm(currentForm);
  renderResponses(currentForm, data.responses, data.summary);
  await loadEventOptions(currentForm.eventId);
}

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(settingsForm).entries());
  const payload = {
    slug: values.slug,
    eventId: values.eventId,
    formType: values.formType,
    title: values.title,
    instructions: values.instructions,
    state: values.state,
    closesAt: utcValue(values.closesAt),
    slots: [],
  };

  saveButton.disabled = true;
  try {
    if (MODE === 'create') {
      const created = await request('/api/signups-admin/v1/forms', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      window.location.href = '/admin/signups/' + encodeURIComponent(created.form.id);
      return;
    }
    await request('/api/signups-admin/v1/forms/' + encodeURIComponent(FORM_ID), {
      method: 'PUT',
      body: JSON.stringify({ ...payload, expectedRevision: currentForm.revision }),
    });
    showNotice('Signup saved.');
    await loadForm();
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    saveButton.disabled = false;
  }
});

if (MODE === 'create') {
  toggleSlotEditor('rsvp');
  loadEventOptions(null).catch((error) => showNotice(error.message, 'error'));
} else {
  loadForm().catch((error) => showNotice(error.message, 'error'));
}`;
  return renderSignupShell(
    mode === "create" ? "New signup" : "Signup detail",
    csrfToken,
    body,
    script,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:unit -- signup-admin-page.test.ts`
Expected: PASS, including the two pre-existing script-injection tests (they pass a string `formId`, which still routes through `mode = "edit"` and the same `scriptSafeJson` escaping as before).

- [ ] **Step 5: Run the full test suite and type-check**

Run: `bun run type-check && bun run test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/signup-admin-page.ts src/signup-admin-page.test.ts
git commit -m "feat(signups): add the form-settings panel, event picker, and create/edit save"
```

---

### Task 6: Route `/admin/signups/new`, gated on calendar.manage

**Files:**
- Modify: `src/request-handler.ts:308-338` (the `/admin/signups` routing block)
- Test: `src/request-handler.test.ts`

**Interfaces:**
- Consumes: `renderSignupAdminDetailPage(csrfToken, formId: string | null)` from Task 5.

Creating a form always needs an event to attach to, and the picker (added in Task 5) calls the calendar-admin API, which requires `calendar.manage`. Unlike editing, there's no data already on the page to fall back to, so this route gates on `calendar.manage` up front with a clear 403, rather than rendering a page whose picker silently fails.

- [ ] **Step 1: Write the failing tests**

Add to `src/request-handler.test.ts`, inside the existing `describe('signup admin routing', ...)` block, right after the `"rejects a non-UUID form id in the detail page path without echoing it"` test:

```ts
  it('serves the new-signup page to a volunteer holding both permissions', async () => {
    const token = await AuthManager.generateToken(
      'admin-1',
      'admin@example.test',
      'admin',
      secret,
    )
    const db = {
      prepare: () => ({
        bind() {
          return this
        },
        first: async () => ({ id: 'admin-1' }),
      }),
    }
    const response = await createCmsRequestHandler(vi.fn())(
      new Request('https://cms.macon170.com/admin/signups/new', {
        headers: { Cookie: `auth_token=${token}` },
      }),
      cmsEnv(undefined, db),
      executionContext,
    )
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('New signup form')
  })

  it('requires calendar.manage to reach the new-signup route even with signups.manage', async () => {
    const token = await AuthManager.generateToken(
      'editor-1',
      'editor@example.test',
      'editor',
      secret,
    )
    let lastPermission: unknown
    const db = {
      prepare: () => ({
        bind(...args: unknown[]) {
          lastPermission = args[1]
          return this
        },
        first: async () =>
          lastPermission === 'signups.manage' ? { id: 'editor-1' } : null,
      }),
    }
    const response = await createCmsRequestHandler(vi.fn())(
      new Request('https://cms.macon170.com/admin/signups/new', {
        headers: { Cookie: `auth_token=${token}` },
      }),
      cmsEnv(undefined, db),
      executionContext,
    )
    expect(response.status).toBe(403)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:unit -- request-handler.test.ts`
Expected: FAIL. The first test fails because `rawFormId` is `"new"`, which isn't UUID-shaped, so today's code 404s instead of rendering the page. The second test fails because there's no `calendar.manage` check on this route at all today, so a `signups.manage`-only user currently gets 200, not 403.

- [ ] **Step 3: Write minimal implementation**

In `src/request-handler.ts`, replace the `/admin/signups` block (currently lines 308-338):

```ts
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
      const rawFormId = pathname.slice("/admin/signups/".length);
      const isNew = rawFormId === "new";
      if (isNew) {
        // Creating a form always requires picking an event, and the picker
        // reuses the calendar-admin API — unlike editing, there is no
        // degraded path here for a signups-only volunteer.
        if (!(await hasCalendarPermission(env, user))) {
          return errorResponse(
            403,
            "forbidden",
            `The ${CALENDAR_PERMISSION} permission is required to attach a signup to an event.`,
          );
        }
      } else if (rawFormId && !uuidPattern.test(rawFormId)) {
        return errorResponse(404, "not_found", "Signup not found.");
      }
      const csrf = await ensureCsrfToken(request, env);
      if (csrf instanceof Response) return csrf;
      const response = htmlResponse(
        isNew
          ? renderSignupAdminDetailPage(csrf.token, null)
          : rawFormId
            ? renderSignupAdminDetailPage(csrf.token, rawFormId)
            : renderSignupAdminPage(csrf.token),
      );
      response.headers.append("Set-Cookie", csrf.cookie);
      return response;
    }
```

`CALENDAR_PERMISSION` and `hasCalendarPermission` are already imported/defined in this file (used by the `/admin/calendar` route above this block) — no new imports needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:unit -- request-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite and type-check**

Run: `bun run type-check && bun run test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/request-handler.ts src/request-handler.test.ts
git commit -m "feat(signups): route /admin/signups/new, gated on calendar.manage"
```

---

### Task 7: Add the item editor and the destructive-removal guard

**Files:**
- Modify: `src/signup-admin-page.ts` (extend `renderSignupAdminDetailPage`'s body and script from Task 5)
- Test: `src/signup-admin-page.test.ts`

**Interfaces:**
- Consumes: `diffRemovedSlotIds`/`countClaimedFamiliesBySlot` from Task 4 (as the tested reference algorithm — this task's inline script is a hand-written JS mirror, since the browser script can't import the TS module) and the DOM structure/functions from Task 5 (`#slot-editor`, `#slot-list`, `toggleSlotEditor`, `loadForm`, `populateSettingsForm`, `settingsForm` submit handler).

This finishes `items`-form support: adding, removing, and reordering item rows, showing each existing item's current claimed-by-families count, and confirming before a save would delete any family's claim.

- [ ] **Step 1: Write the failing test**

Add to `src/signup-admin-page.test.ts`, inside `describe("renderSignupAdminDetailPage", ...)`:

```ts
  it("renders the add-item button inside the slot editor", () => {
    const html = renderSignupAdminDetailPage(
      "csrf-token",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(html).toContain('id="add-slot"');
    expect(html).toContain('id="slot-list"');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- signup-admin-page.test.ts`
Expected: FAIL — there's no `#add-slot` button yet (Task 5 rendered an empty `#slot-editor` fieldset with no add control).

- [ ] **Step 3: Write minimal implementation**

In `renderSignupAdminDetailPage`'s `body` template (from Task 5), change the `#slot-editor` fieldset from:

```html
      <fieldset id="slot-editor" hidden>
        <div class="toolbar"><strong>Items</strong></div>
        <div id="slot-list"></div>
      </fieldset>
```

to:

```html
      <fieldset id="slot-editor" hidden>
        <div class="toolbar">
          <strong>Items</strong>
          <button type="button" id="add-slot">Add item</button>
        </div>
        <div id="slot-list"></div>
      </fieldset>
```

Then, in the `script` template, add the slot-editor logic. Insert this block right after the `toggleSlotEditor`/`formTypeSelect` lines from Task 5 (before `async function loadEventOptions`):

```js
let claimCounts = {};

// Mirrors diffRemovedSlotIds() exported from signup-admin-page.ts, which is
// unit-tested there — this copy runs in the browser and must stay in sync.
function diffRemovedSlotIds(loadedSlotIds, currentRows) {
  const kept = new Set(currentRows.map((row) => row.id).filter(Boolean));
  return loadedSlotIds.filter((id) => !kept.has(id));
}

// Mirrors countClaimedFamiliesBySlot() exported from signup-admin-page.ts.
function countClaimedFamiliesBySlot(responses) {
  const counts = {};
  for (const response of responses) {
    for (const claim of response.claims) {
      counts[claim.slotId] = (counts[claim.slotId] || 0) + 1;
    }
  }
  return counts;
}

const slotList = document.querySelector('#slot-list');

function slotRow(slot) {
  const row = document.createElement('div');
  row.className = 'slot-row';
  row.dataset.slotId = slot && slot.id ? slot.id : '';

  const label = document.createElement('input');
  label.name = 'label';
  label.required = true;
  label.maxLength = 120;
  label.placeholder = 'Item';
  label.value = slot ? slot.label : '';

  const quantity = document.createElement('input');
  quantity.name = 'quantityNeeded';
  quantity.type = 'number';
  quantity.min = '1';
  quantity.max = '500';
  quantity.required = true;
  quantity.value = String(slot ? slot.quantityNeeded : 1);

  const notes = document.createElement('input');
  notes.name = 'notes';
  notes.maxLength = 300;
  notes.placeholder = 'Notes (optional)';
  notes.value = slot && slot.notes ? slot.notes : '';

  const up = document.createElement('button');
  up.type = 'button';
  up.textContent = '↑';
  up.addEventListener('click', () => {
    const prev = row.previousElementSibling;
    if (prev) row.parentElement.insertBefore(row, prev);
  });

  const down = document.createElement('button');
  down.type = 'button';
  down.textContent = '↓';
  down.addEventListener('click', () => {
    const next = row.nextElementSibling;
    if (next) row.parentElement.insertBefore(next, row);
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => row.remove());

  row.append(label, quantity, notes, up, down, remove);

  if (slot && slot.id) {
    const claimed = claimCounts[slot.id] || 0;
    const info = document.createElement('small');
    info.textContent = claimed > 0
      ? claimed + (claimed === 1 ? ' family has' : ' families have') + ' claimed this item'
      : 'No claims yet';
    row.append(info);
  }
  return row;
}

function renderSlotEditor(slots) {
  slotList.replaceChildren(...slots.map((slot) => slotRow(slot)));
}

function currentSlotRows() {
  return Array.from(slotList.querySelectorAll('.slot-row')).map((row) => ({
    id: row.dataset.slotId || undefined,
    label: row.querySelector('[name="label"]').value.trim(),
    quantityNeeded: Number(row.querySelector('[name="quantityNeeded"]').value),
    notes: row.querySelector('[name="notes"]').value.trim() || null,
  }));
}

document.querySelector('#add-slot').addEventListener('click', () => {
  slotList.append(slotRow(null));
});
```

Then replace the `loadForm` function from Task 5 with:

```js
async function loadForm() {
  const data = await request('/api/signups-admin/v1/forms/' + encodeURIComponent(FORM_ID));
  currentForm = data.form;
  claimCounts = countClaimedFamiliesBySlot(data.responses);
  populateSettingsForm(currentForm);
  renderSlotEditor(currentForm.slots);
  renderResponses(currentForm, data.responses, data.summary);
  await loadEventOptions(currentForm.eventId);
}
```

Replace the `settingsForm.addEventListener('submit', ...)` handler from Task 5 with:

```js
settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(settingsForm).entries());
  const formType = values.formType;
  const rows = formType === 'items' ? currentSlotRows() : [];

  if (currentForm) {
    const removedIds = diffRemovedSlotIds(
      currentForm.slots.map((slot) => slot.id),
      rows,
    );
    const removedClaimed = removedIds.filter((id) => (claimCounts[id] || 0) > 0);
    if (removedClaimed.length > 0) {
      const names = removedClaimed.map((id) => {
        const slot = currentForm.slots.find((entry) => entry.id === id);
        const count = claimCounts[id];
        return '"' + slot.label + '" (' + count + ' famil' + (count === 1 ? 'y' : 'ies') + ')';
      });
      const confirmed = window.confirm(
        'Removing ' + names.join(', ') + " deletes those families' claims. Continue?",
      );
      if (!confirmed) return;
    }
  }

  const payload = {
    slug: values.slug,
    eventId: values.eventId,
    formType,
    title: values.title,
    instructions: values.instructions,
    state: values.state,
    closesAt: utcValue(values.closesAt),
    slots: rows,
  };

  saveButton.disabled = true;
  try {
    if (MODE === 'create') {
      const created = await request('/api/signups-admin/v1/forms', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      window.location.href = '/admin/signups/' + encodeURIComponent(created.form.id);
      return;
    }
    await request('/api/signups-admin/v1/forms/' + encodeURIComponent(FORM_ID), {
      method: 'PUT',
      body: JSON.stringify({ ...payload, expectedRevision: currentForm.revision }),
    });
    showNotice('Signup saved.');
    await loadForm();
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    saveButton.disabled = false;
  }
});
```

Finally, replace the trailing `if (MODE === 'create') { ... } else { ... }` init block from Task 5 with:

```js
if (MODE === 'create') {
  renderSlotEditor([]);
  toggleSlotEditor('rsvp');
  loadEventOptions(null).catch((error) => showNotice(error.message, 'error'));
} else {
  loadForm().catch((error) => showNotice(error.message, 'error'));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:unit -- signup-admin-page.test.ts`
Expected: PASS, including all tests from Tasks 4 and 5.

- [ ] **Step 5: Run the full test suite and type-check**

Run: `bun run type-check && bun run test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/signup-admin-page.ts src/signup-admin-page.test.ts
git commit -m "feat(signups): add the item editor and the destructive-removal guard"
```

---

### Task 8: Correct docs/signups.md

**Files:**
- Modify: `docs/signups.md`

**Interfaces:** None — documentation only.

`docs/signups.md` currently tells volunteers the opposite of what's now true (Task 2 fixed the underlying bug it was describing), and doesn't mention the new `/admin/signups/new` route or its extra permission requirement.

- [ ] **Step 1: Update the routing note**

In `docs/signups.md`, the paragraph currently reading (lines 15-17):

```
`/admin/signups/:id` only accepts a `crypto.randomUUID()`-shaped id, which is
how every signup form id is generated. Anything else, including a stray path
segment, returns a plain 404 before the page template ever renders.
```

becomes:

```
`/admin/signups/:id` only accepts a `crypto.randomUUID()`-shaped id, which is
how every signup form id is generated. Anything else, including a stray path
segment, returns a plain 404 before the page template ever renders — except
the literal `/admin/signups/new`, which opens the create form instead of a
specific signup. Creating a form additionally requires the `calendar.manage`
permission, since choosing which event to attach to reuses the calendar
admin's event list; editing an existing form degrades gracefully to a
disabled, unchanged event field for a volunteer who holds `signups.manage`
alone.
```

- [ ] **Step 2: Correct the destructive-editing claim**

The paragraph currently reading (lines 28-34):

```
Editing an `items` form's slot list is destructive to existing claims:
`signup_slots` is replaced wholesale whenever the submitted list differs from
the stored one in any item's label, order, quantity, or notes, and
`signup_claims.slot_id` cascades on delete. Reordering or renaming an item
after families have claimed it deletes their claims along with the old slot
row, even though the family's response otherwise survives untouched. **Add new
items instead of reordering or renaming existing ones once a form is open.**
A save that changes only the title, instructions, deadline, or open/closed
state leaves the slot rows and every claim in place; the "updated" audit row
records `slotsReplaced` so an operator can tell the two cases apart. If claims
do disappear this way, `signup_audit` still has the "updated" record showing
the old slot count, and the response's own audit trail shows what it
originally claimed.
```

becomes:

```
Editing an `items` form's slot list reconciles by each item's id: adding a new
item, or editing an existing item's label, quantity, or notes, never touches
any family's claims. **Only removing an item deletes the claims on it** — an
inherent consequence of the item no longer existing, not a side effect of
saving. Switching a form's type from `items` to `rsvp` removes every item and
so deletes every claim on the form. The "updated" audit row records
`slotsChanged: { added, updated, removed }` so an operator can tell exactly
what happened. If claims are lost to a removal, `signup_audit` still has the
"updated" record showing the removed count, and the response's own audit
trail shows what it originally claimed.
```

- [ ] **Step 3: Commit**

```bash
git add docs/signups.md
git commit -m "docs(signups): correct slot-edit behavior and document /admin/signups/new"
```

---

## Final verification

After Task 8, from `/Users/kerry.hatcher/projects/hatek/macon170/worktrees/signup-admin-crud`:

```bash
bun run type-check
bun run test
bun run deploy:dry
```

All three must be clean. `deploy:dry` catches a `wrangler.jsonc` config problem before any real deploy — this feature adds no new bindings or secrets, so it should need no config changes at all.
