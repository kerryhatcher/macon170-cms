# Event Payment Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a volunteer attach a Stripe payment link to a calendar event, shown on the event page and in the signup success notice and confirmation email.

**Architecture:** A new nullable `payment_url` column on `calendar_events` mirrors `registration_url` and is carried through the CMS calendar contract, admin editor, MCP tools, the public signup-form projection, and the signup confirmation email. The frontend parses `paymentUrl` and renders a "Pay now" link in two places. The CMS deploys first; the frontend parser requires the field.

**Tech Stack:** Cloudflare Workers + D1 (SonicJS CMS, TypeScript, vitest, bun) in `macon170-cms`; Astro + Playwright + vitest in `macon170.com`.

**Spec:** `docs/superpowers/specs/2026-10-12-event-payment-link-design.md`

## Global Constraints

- Payment URL must use `https:`; max length 2000 characters (spec: "requires the `https:` scheme", same max as `registrationUrl`).
- `registrationUrl` and the signup-URL process are not changed.
- No payment tracking, no per-family amounts, no Stripe-domain restriction.
- CMS lands and deploys before the frontend; both submodule pointers are bumped in one meta-repo commit.
- Never work in the primary submodule checkouts. CMS work happens in `worktrees/event-payment-link` (branch `feat/event-payment-link`, already created). Frontend work happens in `worktrees/event-payment-link-site`, created in Task 6.
- Conventional Commits. End commit messages with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Do not deploy, apply remote migrations, push, or open PRs without the user's explicit approval (Task 9 is gated).

## Review Focus

- A payment URL that is not https (`http://`, `javascript:`, `ftp:`, a bare host) must be rejected on write, not stored. Pinned in Task 1.
- An edit that omits `paymentUrl` (an MCP `update_calendar_event` with only `changes: { title }`) must keep the saved link, because PATCH merges over the current event. Pinned in Task 2.
- The INSERT/UPDATE SQL in `src/calendar.ts` has hand-counted `?` placeholders; a mismatch only fails against real D1. Pinned in Task 1 (placeholder-count assertion) and Task 2 (real-SQLite MCP test).
- An event title or payment URL containing HTML or `&` must be escaped in the HTML email and left raw in the text part. Pinned in Task 4.
- A draft/unknown event or an event without a payment URL must yield no payment line, and a lookup failure must not rotate a token without sending the email. Pinned in Task 5.
- A frontend page whose CMS response lacks `paymentUrl` currently throws in the parser; the plan keeps that (CMS deploys first) and updates every fixture. Pinned in Tasks 6-8.

---

## File Structure

CMS (`worktrees/event-payment-link`):
- Create `migrations/custom/0011_calendar_payment_url.sql` - the column.
- Modify `src/calendar.ts` - type, row mapping, validation, select/insert/update SQL, history snapshot.
- Modify `src/calendar.test.ts`, `src/request-handler.test.ts` - fixtures and new tests.
- Modify `src/calendar-admin-page.ts` (+ test) - editor input and payload.
- Modify `src/mcp/tools.ts`, `src/mcp/mcp.integration.test.ts` - tool schema and a real-DB test.
- Modify `src/signups.ts`, `src/signup-store.ts` (+ `src/signup-store.test.ts`) - public projection and the `getSignupEventPayment` lookup.
- Modify `src/signup-email.ts` (+ test) - payment block.
- Modify `src/signup-public.ts`, `src/signup-admin.ts` (+ tests) - pass the lookup into the email.
- Modify `docs/calendar.md`, `docs/signups.md`.

Frontend (`worktrees/event-payment-link-site`):
- Modify `src/lib/calendar-client.ts` (+ test), `src/pages/events/index.astro`, `e2e/event-links.spec.ts`.
- Modify `src/lib/signup-client.ts` (+ test), `src/pages/signups/index.astro`, `e2e/signup-form.spec.ts`, `e2e/signup-edit.spec.ts` if it stubs a form with an `event`.

---

## Task 1: Calendar data model, validation, and persistence (CMS)

**Files:**
- Create: `migrations/custom/0011_calendar_payment_url.sql`
- Modify: `src/calendar.ts:13-37` (type), `:55-79` (row), `:174-209` (validation + return), `:212-241` (rowToEvent), `:243-248` (selectColumns), `:303-331` (insert), `:429-461` (update)
- Modify: `src/calendar.test.ts`, `src/request-handler.test.ts:338`
- Modify: `docs/calendar.md`

**Interfaces:**
- Consumes: existing `validateCalendarInput`, `createCalendarEvent`, `updateCalendarEvent`.
- Produces: `CalendarEvent.paymentUrl: string | null`; `CalendarEventInput.paymentUrl: string | null` (the input type is derived from `CalendarEvent`, so it follows automatically); D1 column `calendar_events.payment_url`.

- [ ] **Step 1: Write the failing tests**

In `src/calendar.test.ts`, add `paymentUrl: null,` after `registrationUrl: null,` in the `input` constant (line 29). Then add these tests inside `describe("calendar validation", ...)`, after the existing "rejects invalid order, timezone, URL scheme, enum, and milestone" test:

```ts
  it("accepts an https payment URL and trims it", () => {
    expect(
      validateCalendarInput({
        ...input,
        paymentUrl: "  https://buy.stripe.com/9B68wOdMpef0c9rfKpdjO00  ",
      }).paymentUrl,
    ).toBe("https://buy.stripe.com/9B68wOdMpef0c9rfKpdjO00");
  });

  it("treats a missing, empty, or null payment URL as null", () => {
    const { paymentUrl: _omitted, ...withoutPayment } = input;
    expect(validateCalendarInput(withoutPayment).paymentUrl).toBeNull();
    expect(
      validateCalendarInput({ ...input, paymentUrl: "" }).paymentUrl,
    ).toBeNull();
    expect(
      validateCalendarInput({ ...input, paymentUrl: null }).paymentUrl,
    ).toBeNull();
  });

  it("rejects payment URLs that are not https, not URLs, or too long", () => {
    for (const paymentUrl of [
      "http://buy.stripe.com/x",
      "javascript:alert(1)",
      "ftp://example.com/x",
    ]) {
      expect(() =>
        validateCalendarInput({ ...input, paymentUrl }),
      ).toThrow("Payment URL must use HTTPS");
    }
    expect(() =>
      validateCalendarInput({ ...input, paymentUrl: "buy.stripe.com/x" }),
    ).toThrow("Invalid paymentUrl");
    expect(() =>
      validateCalendarInput({
        ...input,
        paymentUrl: `https://example.com/${"a".repeat(2000)}`,
      }),
    ).toThrow("Invalid paymentUrl");
  });
```

Add this helper and two tests inside `describe("calendar persistence", ...)`, after the existing "creates an event and its initial history in one batch" test:

```ts
  const stripeLink = "https://buy.stripe.com/9B68wOdMpef0c9rfKpdjO00";

  function rowFor(source: typeof event) {
    return {
      id: source.id,
      revision: source.revision,
      slug: source.slug,
      publication_state: source.publicationState,
      event_status: source.eventStatus,
      category: source.category,
      title: source.title,
      summary: source.summary,
      description: source.description,
      starts_at: source.startsAt,
      ends_at: source.endsAt,
      all_day: source.allDay ? 1 : 0,
      timezone: source.timezone,
      location_name: source.locationName,
      address: source.address,
      audience: source.audience,
      what_to_bring: source.whatToBring,
      cost: source.cost,
      registration_url: source.registrationUrl,
      payment_url: source.paymentUrl,
      milestone: source.milestone,
      created_at: Date.parse(source.createdAt),
      updated_at: Date.parse(source.updatedAt),
      published_at: Date.parse(source.publishedAt),
    };
  }

  function capturingDb(row: ReturnType<typeof rowFor>) {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        sql,
        values: [] as unknown[],
        bind(...values: unknown[]) {
          this.values = values;
          statements.push(this);
          return this;
        },
        first: async () => row,
      }),
      batch: vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, {}]),
    };
    return { db, statements };
  }

  it("writes payment_url on create with one bind per placeholder", async () => {
    const { db, statements } = capturingDb(
      rowFor({ ...event, paymentUrl: stripeLink }),
    );
    const created = await createCalendarEvent(
      { DB: db } as unknown as Bindings,
      validateCalendarInput({ ...input, paymentUrl: stripeLink }),
      "admin-1",
    );
    const insert = statements.find((s) =>
      s.sql.includes("INSERT INTO calendar_events"),
    )!;
    expect(insert.sql).toContain("payment_url");
    expect(insert.values).toContain(stripeLink);
    expect(insert.sql.match(/\?/g)).toHaveLength(insert.values.length);
    const history = statements.find((s) =>
      s.sql.includes("INSERT INTO calendar_event_history"),
    )!;
    expect(JSON.parse(String(history.values[2])).paymentUrl).toBe(stripeLink);
    expect(created.paymentUrl).toBe(stripeLink);
  });

  it("writes payment_url on update with one bind per placeholder", async () => {
    const { db, statements } = capturingDb(rowFor(event));
    await updateCalendarEvent(
      { DB: db } as unknown as Bindings,
      event.id,
      validateCalendarInput({ ...input, paymentUrl: stripeLink }),
      event.revision,
      "admin-1",
    );
    const update = statements.find((s) =>
      s.sql.includes("UPDATE calendar_events SET"),
    )!;
    expect(update.sql).toContain("payment_url = ?");
    expect(update.values).toContain(stripeLink);
    expect(update.sql.match(/\?/g)).toHaveLength(update.values.length);
    const history = statements.find((s) =>
      s.sql.includes("INSERT INTO calendar_event_history"),
    )!;
    expect(JSON.parse(String(history.values[4])).paymentUrl).toBe(stripeLink);
  });
```

In both `src/calendar.test.ts` row fixtures that contain `registration_url: event.registrationUrl,` (lines ~199 and ~245), add `payment_url: event.paymentUrl,` on the next line. In `src/calendar.test.ts:145` and `src/request-handler.test.ts:338`, add `payment_url: null,` after `registration_url: null,`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/calendar.test.ts`
Expected: FAIL. `paymentUrl` is undefined on the validated input and the new persistence tests report `expected ... to contain 'payment_url'`.

- [ ] **Step 3: Add the migration**

Create `migrations/custom/0011_calendar_payment_url.sql`:

```sql
-- Optional Stripe (or other https) payment link volunteers attach to an event.
ALTER TABLE calendar_events ADD COLUMN payment_url TEXT;
```

- [ ] **Step 4: Implement the contract changes in `src/calendar.ts`**

1. In `CalendarEvent` (after `registrationUrl: string | null;`, line 32) add: `paymentUrl: string | null;`
2. In `CalendarRow` (after `registration_url: string | null;`, line 74) add: `payment_url: string | null;`
3. In `validateCalendarInput`, directly after the `registrationUrl` block (after line 185) add:

```ts
  const paymentUrl = optional("paymentUrl", 2000);
  if (paymentUrl) {
    let parsedPayment: URL;
    try {
      parsedPayment = new URL(paymentUrl);
    } catch {
      throw new Error("Invalid paymentUrl");
    }
    if (parsedPayment.protocol !== "https:") {
      throw new Error("Payment URL must use HTTPS");
    }
  }
```

and in the returned object add `paymentUrl,` after `registrationUrl,` (line 207).
4. In `rowToEvent` add `paymentUrl: row.payment_url,` after `registrationUrl: row.registration_url,`.
5. In `selectColumns` change `cost, registration_url, milestone` to `cost, registration_url, payment_url, milestone`.
6. In `createCalendarEvent`, replace the INSERT with (note the extra column and one extra `?`, 18 after `'draft'`; the NULL and final `?` are unchanged):

```ts
        `INSERT INTO calendar_events (
          id, revision, slug, publication_state, event_status, category, title,
          summary, description, starts_at, ends_at, timezone, location_name,
          address, audience, what_to_bring, cost, registration_url, payment_url,
          milestone, created_at, updated_at, published_at, all_day
        ) VALUES (?, 0, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
```

and add `input.paymentUrl,` after `input.registrationUrl,` in the `.bind(...)` list (before `input.milestone`).
7. In `mutateCalendarEvent`, change `cost = ?, registration_url = ?, milestone = ?,` to `cost = ?, registration_url = ?, payment_url = ?, milestone = ?,` and add `nextInput.paymentUrl,` after `nextInput.registrationUrl,` in the bind list.

Placeholder arithmetic: the INSERT lists 24 columns, and three of them are literals (`revision` is `0`, `publication_state` is `'draft'`, `published_at` is `NULL`), so the VALUES list has 21 `?`: `id`, `slug`, 18 more between `'draft'` and `NULL`, then `all_day`. The `.bind(...)` list has the same 21 values. The test in Step 1 asserts that the two counts match.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run src/calendar.test.ts src/request-handler.test.ts && bun run type-check`
Expected: PASS, no type errors. If a type error names another file that builds a `CalendarEvent` literal, add `paymentUrl: null` there.

- [ ] **Step 6: Verify the migration applies and re-applies**

Run: `bun run test:sql && bun run test:migrations:signups`
Expected: both pass (the second applies core + custom migrations, including 0011, to a temporary local D1 and reapplies them as a no-op).

- [ ] **Step 7: Document the field**

In `docs/calendar.md`, add this section directly before `## Public API`:

```markdown
## Payment link

An event can carry one optional **Payment URL**, such as a Stripe payment link.
It must be an `https://` URL; `http://` and other schemes are rejected when the
event is saved. It is separate from **Registration URL**, which is where
volunteers paste the signup form link. The JSON contract exposes it as
`paymentUrl` (`null` when unset). Apply `0011_calendar_payment_url.sql` before
deploying the CMS update, deploy the CMS before the public site, then paste the
link into the event's Payment URL field in the admin editor.
```

- [ ] **Step 8: Commit**

```bash
git add migrations/custom/0011_calendar_payment_url.sql src/calendar.ts src/calendar.test.ts src/request-handler.test.ts docs/calendar.md
git commit -m "$(cat <<'EOF'
feat(calendar): add an https payment URL to events

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Admin editor field and MCP tools (CMS)

**Files:**
- Modify: `src/calendar-admin-page.ts:87` (input), `:159` (payload)
- Modify: `src/calendar-admin-page.test.ts`
- Modify: `src/mcp/tools.ts:37`
- Modify: `src/mcp/mcp.integration.test.ts`

**Interfaces:**
- Consumes: `validateCalendarInput` accepting `paymentUrl` (Task 1).
- Produces: a "Payment URL" input named `paymentUrl` (the editor's existing `edit()` loop fills it from the event automatically because it matches on `name`); MCP `create_calendar_event` / `update_calendar_event` accept `paymentUrl`.

- [ ] **Step 1: Write the failing tests**

In `src/calendar-admin-page.test.ts`, add inside the existing `describe`:

```ts
  it('offers a Payment URL field and sends it with the event payload', () => {
    const page = renderCalendarAdminPage('test-csrf-token')
    expect(page).toContain(
      '<label>Payment URL<input name="paymentUrl" type="url" maxlength="2000"></label>',
    )
    expect(page).toContain('paymentUrl: data.paymentUrl || null')
  })
```

In `src/mcp/mcp.integration.test.ts`, add after the "uses real calendar handlers, preserves revisions and enforces live CMS permissions" test (it uses the real SQLite database with all `migrations/custom` files applied, so it exercises the real INSERT/UPDATE SQL):

```ts
  it("stores a payment link, keeps it across a partial update, and rejects http", async () => {
    const a = await connect();
    const paymentUrl = "https://buy.stripe.com/9B68wOdMpef0c9rfKpdjO00";
    const created = await tool(a.access_token, "create_calendar_event", {
      ...event,
      slug: "fall-campout-payment",
      paymentUrl,
    });
    expect(created.isError).toBe(false);
    const row = JSON.parse(created.content[0]!.text).data.event;
    expect(row.paymentUrl).toBe(paymentUrl);

    const updated = await tool(a.access_token, "update_calendar_event", {
      id: row.id,
      expectedRevision: row.revision,
      changes: { title: "Fall Campout 2026" },
    });
    expect(updated.isError).toBe(false);
    expect(JSON.parse(updated.content[0]!.text).data.event.paymentUrl).toBe(
      paymentUrl,
    );

    const rejected = await tool(a.access_token, "create_calendar_event", {
      ...event,
      slug: "fall-campout-http",
      paymentUrl: "http://buy.stripe.com/x",
    });
    expect(rejected.isError).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/calendar-admin-page.test.ts src/mcp/mcp.integration.test.ts`
Expected: FAIL - the page lacks the input, and the MCP create is rejected by the strict schema (`Unrecognized key: paymentUrl`).

- [ ] **Step 3: Implement**

In `src/calendar-admin-page.ts`, after the Registration URL label (line 87) add:

```html
            <label>Payment URL<input name="paymentUrl" type="url" maxlength="2000"></label>
```

and change the payload line (159) to:

```js
        cost: data.cost || null, registrationUrl: data.registrationUrl || null, paymentUrl: data.paymentUrl || null,
```

In `src/mcp/tools.ts`, after `registrationUrl: optionalText,` (line 37) add `paymentUrl: optionalText,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/calendar-admin-page.test.ts src/mcp/mcp.integration.test.ts && bun run type-check`
Expected: PASS. If the `update_calendar_event` result nests the event differently than `data.event`, mirror the shape the existing tests in this file read for `created`.

- [ ] **Step 5: Commit**

```bash
git add src/calendar-admin-page.ts src/calendar-admin-page.test.ts src/mcp/tools.ts src/mcp/mcp.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(calendar): edit the payment URL in the admin editor and MCP tools

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Public signup form projection and the payment lookup (CMS)

**Files:**
- Modify: `src/signups.ts:127` (`PublicSignupForm.event`)
- Modify: `src/signup-store.ts` (`getPublicSignupForm` query and event object; new `getSignupEventPayment`)
- Modify: `src/signup-store.test.ts`

**Interfaces:**
- Consumes: the `calendar_events.payment_url` column (Task 1).
- Produces:
  - `PublicSignupForm.event.paymentUrl: string | null`
  - `getSignupEventPayment(env: SignupBindings, eventId: string): Promise<{ eventTitle: string; url: string } | null>`, exported from `src/signup-store.ts`; returns `null` when the event is missing or has no payment URL.

- [ ] **Step 1: Write the failing tests**

In `src/signup-store.test.ts`, change the import to also pull in `getSignupEventPayment`:

```ts
import {
  createSignupForm,
  getPublicSignupForm,
  getSignupEventPayment,
  updateSignupForm,
} from "./signup-store";
```

Then, next to the existing public projection tests, add (reusing `formRow` and the db-stub shape from "exposes only counts and never family data"; the slot query must return an empty `results`):

```ts
describe("public signup form payment link", () => {
  function publicDb(eventPaymentUrl: string | null) {
    return {
      prepare: (sql: string) => ({
        bind() {
          return this;
        },
        first: async () => ({
          ...formRow,
          event_slug: "fall-campout",
          event_title: "Fall Campout",
          event_starts_at: "2026-10-24T16:00:00.000Z",
          event_payment_url: eventPaymentUrl,
        }),
        all: async () => ({ results: [] }),
      }),
    };
  }

  it("includes the event's payment URL", async () => {
    const form = await getPublicSignupForm(
      { DB: publicDb("https://buy.stripe.com/x") } as unknown as SignupBindings,
      "lego-derby-food",
    );
    expect(form?.event.paymentUrl).toBe("https://buy.stripe.com/x");
  });

  it("reports null when the event has no payment URL", async () => {
    const form = await getPublicSignupForm(
      { DB: publicDb(null) } as unknown as SignupBindings,
      "lego-derby-food",
    );
    expect(form?.event.paymentUrl).toBeNull();
  });
});

describe("getSignupEventPayment", () => {
  function eventDb(row: Record<string, unknown> | null) {
    return {
      prepare: (sql: string) => ({
        sql,
        values: [] as unknown[],
        bind(...values: unknown[]) {
          this.values = values;
          return this;
        },
        first: async () => row,
      }),
    } as unknown as SignupBindings["DB"];
  }

  it("returns the event title and link when a payment URL is set", async () => {
    await expect(
      getSignupEventPayment(
        { DB: eventDb({ title: "Fall Campout", payment_url: "https://buy.stripe.com/x" }) } as unknown as SignupBindings,
        "evt-1",
      ),
    ).resolves.toEqual({ eventTitle: "Fall Campout", url: "https://buy.stripe.com/x" });
  });

  it("returns null when the event has no payment URL or does not exist", async () => {
    await expect(
      getSignupEventPayment(
        { DB: eventDb({ title: "Fall Campout", payment_url: null }) } as unknown as SignupBindings,
        "evt-1",
      ),
    ).resolves.toBeNull();
    await expect(
      getSignupEventPayment({ DB: eventDb(null) } as unknown as SignupBindings, "evt-missing"),
    ).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/signup-store.test.ts`
Expected: FAIL - `getSignupEventPayment` is not exported and `form.event.paymentUrl` is `undefined`.

- [ ] **Step 3: Implement**

In `src/signups.ts`, change the `PublicSignupForm` event type to:

```ts
  event: {
    slug: string;
    title: string;
    startsAt: string;
    paymentUrl: string | null;
  };
```

In `src/signup-store.ts`, in `getPublicSignupForm`:
- add `calendar_events.payment_url AS event_payment_url,` to the SELECT list after `calendar_events.starts_at AS event_starts_at`, adding the comma on the previous line;
- add `event_payment_url: string | null;` to the row type;
- add `paymentUrl: row.event_payment_url ?? null,` to the returned `event` object.

Add this exported function after `getPublicSignupForm`:

```ts
export async function getSignupEventPayment(
  env: SignupBindings,
  eventId: string,
): Promise<{ eventTitle: string; url: string } | null> {
  const row = await env.DB.prepare(
    `SELECT title, payment_url FROM calendar_events WHERE id = ? LIMIT 1`,
  )
    .bind(eventId)
    .first<{ title: string; payment_url: string | null }>();
  if (!row?.payment_url) return null;
  return { eventTitle: row.title, url: row.payment_url };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/signup-store.test.ts src/signup-public.test.ts src/signup-admin.test.ts && bun run type-check`
Expected: PASS. If an existing test deep-equals the form's `event` object, add `event_payment_url: null` to its mock row and `paymentUrl: null` to the expected object.

- [ ] **Step 5: Commit**

```bash
git add src/signups.ts src/signup-store.ts src/signup-store.test.ts
git commit -m "$(cat <<'EOF'
feat(signups): expose the event payment link on the public form

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Confirmation email payment block (CMS)

**Files:**
- Modify: `src/signup-email.ts:3-8` (options type), `:32-79` (`renderSignupEmail`)
- Modify: `src/signup-email.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SignupEmailOptions.payment?: { eventTitle: string; url: string } | null`. Task 5 passes the value returned by `getSignupEventPayment`.

- [ ] **Step 1: Write the failing test**

In `src/signup-email.test.ts`, add inside `describe("signup email rendering", ...)`:

```ts
  it("adds a payment link only when the event has one", () => {
    const without = renderSignupEmail(options);
    expect(without.text).not.toContain("Pay for");
    expect(without.html).not.toContain("Pay for");

    const payment = {
      eventTitle: "Fall <Campout>",
      url: "https://buy.stripe.com/9B68wOdMpef0c9rfKpdjO00?x=1&y=2",
    };
    const withPayment = renderSignupEmail({ ...options, payment });
    expect(withPayment.subject).toBe(without.subject);
    expect(withPayment.text).toContain("Pay for Fall <Campout>:");
    expect(withPayment.text).toContain(payment.url);
    expect(withPayment.html).toContain("Pay for Fall &lt;Campout&gt;");
    expect(withPayment.html).toContain("x=1&amp;y=2");
    expect(withPayment.html).not.toContain("Fall <Campout>");
    expect(withPayment.text.indexOf(options.linkUrl)).toBeLessThan(
      withPayment.text.indexOf(payment.url),
    );
    expect(withPayment.html.indexOf(options.linkUrl)).toBeLessThan(
      withPayment.html.indexOf(payment.url.replace("&", "&amp;")),
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/signup-email.test.ts`
Expected: FAIL - `expect(withPayment.text).toContain("Pay for Fall <Campout>:")` fails (and a type error on `payment` until the type is extended).

- [ ] **Step 3: Implement**

In `src/signup-email.ts`, add to `SignupEmailOptions`:

```ts
  payment?: { eventTitle: string; url: string } | null;
```

In `renderSignupEmail`, directly after `const deadlineLine = ...;` add:

```ts
  const paymentText = options.payment
    ? ["", `Pay for ${options.payment.eventTitle}:`, options.payment.url]
    : [];
```

In the `text` array, change the lines after the link to:

```ts
    "Keep the link. It is the only way to update your response.",
    ...paymentText,
    deadlineLine,
```

In the `html` template, directly after the "Keep this link. It is the only way to update your response." paragraph, add:

```ts
        ${options.payment ? `<p style="margin:28px 0"><a href="${escapeHtml(options.payment.url)}" style="display:inline-block;background:#fcd116;color:#002b5c;font-weight:700;padding:14px 20px;text-decoration:none;border-radius:9px 9px 3px 9px">Pay for ${escapeHtml(options.payment.eventTitle)}</a></p>` : ""}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/signup-email.test.ts && bun run type-check`
Expected: PASS, and the existing email tests still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/signup-email.ts src/signup-email.test.ts
git commit -m "$(cat <<'EOF'
feat(signups): include the event payment link in confirmation emails

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire the email call sites, document, and verify the CMS (CMS)

**Files:**
- Modify: `src/signup-public.ts:386` (submit path)
- Modify: `src/signup-admin.ts:209` (resend path)
- Modify: `src/signup-public.test.ts`, `src/signup-admin.test.ts`
- Modify: `docs/signups.md`

**Interfaces:**
- Consumes: `getSignupEventPayment(env, eventId)` (Task 3), `SignupEmailOptions.payment` (Task 4). `form.eventId` is on the `SignupFormDetail` that both call sites already hold.
- Produces: confirmation and resend emails that carry the payment block when the event has a payment URL.

- [ ] **Step 1: Write the failing tests**

In `src/signup-public.test.ts`, extend `stubDb` so it can answer the new lookup: add `event?: Record<string, unknown> | null;` to the options type, and inside `first` add, before the final `return null;`:

```ts
        if (sql.includes("FROM calendar_events")) return options.event ?? null;
```

Then add after "creates a response and emails exactly one link on a first submit":

```ts
  it("adds the event payment link to the confirmation email", async () => {
    const env = baseEnv({
      DB: stubDb({
        event: { title: "Fall Campout", payment_url: "https://buy.stripe.com/x" },
      }),
    });
    const provider = vi.fn((url: string | URL | Request, _init?: RequestInit) =>
      String(url).includes("challenges.cloudflare.com")
        ? turnstileOk()
        : Promise.resolve(Response.json({ ErrorCode: 0, MessageID: "message-test", Message: "OK", To: "parent@example.com", SubmittedAt: "2026-10-07T22:00:00Z" })),
    );
    const response = await handlePublicSignupRequest(
      submit(validSubmission),
      env,
      provider,
    );
    expect(response.status).toBe(201);
    const message = JSON.parse(String(provider.mock.calls[1]?.[1]?.body));
    expect(message.TextBody).toContain("Pay for Fall Campout:");
    expect(message.TextBody).toContain("https://buy.stripe.com/x");
    expect(message.HtmlBody).toContain('href="https://buy.stripe.com/x"');
  });

  it("sends no payment block when the event has no payment link", async () => {
    const provider = vi.fn((url: string | URL | Request, _init?: RequestInit) =>
      String(url).includes("challenges.cloudflare.com")
        ? turnstileOk()
        : Promise.resolve(Response.json({ ErrorCode: 0, MessageID: "message-test", Message: "OK", To: "parent@example.com", SubmittedAt: "2026-10-07T22:00:00Z" })),
    );
    await handlePublicSignupRequest(submit(validSubmission), baseEnv(), provider);
    const message = JSON.parse(String(provider.mock.calls[1]?.[1]?.body));
    expect(message.TextBody).not.toContain("Pay for");
    expect(message.HtmlBody).not.toContain("Pay for");
  });
```

In `src/signup-admin.test.ts`, extend `adminDb`: add `event?: Record<string, unknown> | null;` to its options type and, inside `first`, before `return null;`:

```ts
          if (sql.includes("FROM calendar_events")) return options.event ?? null;
```

Then add after "rotates the token and emails the family on resend":

```ts
  it("includes the event payment link when a volunteer resends", async () => {
    const { db } = adminDb({
      event: { title: "Fall Campout", payment_url: "https://buy.stripe.com/x" },
    });
    const send = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ ErrorCode: 0, MessageID: "message-test", Message: "OK", To: "parent@example.com", SubmittedAt: "2026-10-07T22:00:00Z" })));
    const response = await handleAdminSignupRequest(
      adminRequest("/responses/rsp-1/resend", { method: "POST" }),
      adminEnv(db),
      user,
      null,
      true,
      send,
    );
    expect(response.status).toBe(200);
    const message = JSON.parse(send.mock.calls[0][1].body);
    expect(message.TextBody).toContain("Pay for Fall Campout:");
    expect(message.HtmlBody).toContain('href="https://buy.stripe.com/x"');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/signup-public.test.ts src/signup-admin.test.ts`
Expected: the two new "payment link" tests FAIL (`TextBody` lacks "Pay for"); the "no payment block" test and all existing tests pass.

- [ ] **Step 3: Implement**

In `src/signup-public.ts`, add `getSignupEventPayment` to the `./signup-store` import. Directly before the `try { await sendSignupLinkEmail(` block (line ~383), add:

```ts
  const payment = await getSignupEventPayment(env, form.eventId);
```

and add `payment,` to the options object passed to `sendSignupLinkEmail` (after `closesAt: form.closesAt,`).

In `src/signup-admin.ts`, add `getSignupEventPayment` to the `./signup-store` import. Directly after the `if (!form) { throw ... }` check in the resend branch and before `issueSignupToken()`, add:

```ts
        // Resolve the payment link before rotating the token: a failed lookup
        // after rotation would invalidate the family's old link without sending
        // a new one.
        const payment = await getSignupEventPayment(env, form.eventId);
```

and add `payment,` to the options object passed to `sendSignupLinkEmail` (after `closesAt: form.closesAt,`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/signup-public.test.ts src/signup-admin.test.ts && bun run type-check`
Expected: PASS.

- [ ] **Step 5: Document**

In `docs/signups.md`, add this paragraph at the end of the "Email delivery and staged phone rollout" section (after the paragraph ending "with their own `INVITE_FROM_EMAIL`, `INVITE_FROM_NAME`, and `INVITE_REPLY_TO` settings."):

```markdown
When the signup's event has a **Payment URL** (see [calendar](calendar.md#payment-link)),
the confirmation and resend emails add a "Pay for {event}" button and a plain
link below the confirm-your-signup link, and the public form JSON returns it as
`event.paymentUrl`. Events without one send the email unchanged.
```

- [ ] **Step 6: Run the full CMS suite**

Run: `bun run test && bun run type-check`
Expected: all of `test:sql`, `test:unit`, `test:migrations`, and `test:migrations:signups` pass, with no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/signup-public.ts src/signup-admin.ts src/signup-public.test.ts src/signup-admin.test.ts docs/signups.md
git commit -m "$(cat <<'EOF'
feat(signups): send the event payment link with signup emails

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Frontend calendar parser (frontend)

**Files:**
- Modify: `src/lib/calendar-client.ts:24` (type), `:145` (parse)
- Modify: `src/lib/calendar-client.test.ts`
- Modify: `e2e/event-links.spec.ts:23`

All paths in Tasks 6-8 are relative to the frontend worktree.

**Interfaces:**
- Consumes: CMS responses that include `paymentUrl` (Tasks 1-5, deployed).
- Produces: `CalendarEvent.paymentUrl: string | null`. Task 7 reads it.

- [ ] **Step 1: Create the frontend worktree**

From the meta repo root (`/Users/kerry.hatcher/projects/hatek/macon170`):

```bash
git -C macon170.com worktree add ../worktrees/event-payment-link-site -b feat/event-payment-link
cd worktrees/event-payment-link-site
bun install --frozen-lockfile
```

Expected: the worktree is created on a new branch from the submodule's current `main`.

- [ ] **Step 2: Write the failing tests**

In `src/lib/calendar-client.test.ts`, add `paymentUrl: null,` after `registrationUrl: 'https://example.com/register',` in the `event` fixture. Then add after the "rejects unsafe registration URLs" test:

```ts
  it('returns the payment URL and accepts null', async () => {
    const paymentUrl = 'https://buy.stripe.com/9B68wOdMpef0c9rfKpdjO00';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ version: 'v1', event: { ...event, paymentUrl } })));
    expect((await getCalendarEvent('pack-meeting')).paymentUrl).toBe(paymentUrl);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ version: 'v1', event })));
    expect((await getCalendarEvent('pack-meeting')).paymentUrl).toBeNull();
  });

  it('rejects unsafe or malformed payment URLs', async () => {
    for (const paymentUrl of ['javascript:alert(1)', 'not a url', 42]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ version: 'v1', events: [{ ...event, paymentUrl }] })));
      await expect(getCalendarEvents()).rejects.toThrow('invalid paymentUrl');
    }
  });
```

In `e2e/event-links.spec.ts`, add `paymentUrl: null,` after `registrationUrl: null,` (line 23).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bunx vitest run src/lib/calendar-client.test.ts`
Expected: FAIL - `paymentUrl` is `undefined` on the parsed event, and the existing `toEqual([event])` test fails because the fixture now has a field the parser drops.

- [ ] **Step 4: Implement**

In `src/lib/calendar-client.ts`, add `paymentUrl: string | null;` after `registrationUrl: string | null;` in the `CalendarEvent` type (line 24), and `paymentUrl: nullableWebUrl(value, 'paymentUrl'),` after `registrationUrl: nullableWebUrl(value, 'registrationUrl'),` in the returned object (line 145).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run src/lib/calendar-client.test.ts && bun run check`
Expected: PASS. If a type error appears in `src/pages/**` constructing a `CalendarEvent`, add `paymentUrl: null` there.

- [ ] **Step 6: Commit**

```bash
git add src/lib/calendar-client.ts src/lib/calendar-client.test.ts e2e/event-links.spec.ts
git commit -m "$(cat <<'EOF'
feat(calendar): parse the event payment URL from the CMS

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: "Pay now" on the events page (frontend)

**Files:**
- Modify: `src/pages/events/index.astro:76` (derive), `:114-119` (render)
- Modify: `e2e/event-links.spec.ts`

**Interfaces:**
- Consumes: `CalendarEvent.paymentUrl` (Task 6); the page's existing local `webUrl(value)` and `esc(value)` helpers.
- Produces: an `.event-action` paragraph with a "Pay now" link, rendered when `paymentUrl` passes `webUrl`, and an `.event-action--broken` message when it is set but fails.

- [ ] **Step 1: Write the failing e2e tests**

In `e2e/event-links.spec.ts`, add at the end:

```ts
const paymentUrl = 'https://buy.stripe.com/9B68wOdMpef0c9rfKpdjO00';

async function openEvent(page: import('@playwright/test').Page, overrides: Record<string, unknown>) {
  await page.route('https://cms.macon170.com/api/calendar/v1/events**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: 'v1', event: { ...event, ...overrides } }),
    }),
  );
  await page.goto('/events/?event=fall-campout');
}

test('shows a Pay now link when the event has a payment URL', async ({ page }) => {
  await openEvent(page, { paymentUrl });
  const pay = page.getByRole('link', { name: 'Pay now' });
  await expect(pay).toHaveAttribute('href', paymentUrl);
  await expect(page.getByRole('link', { name: 'Open registration' })).toHaveCount(0);
});

test('shows Pay now beside registration when both are set', async ({ page }) => {
  await openEvent(page, { paymentUrl, registrationUrl: 'https://www.macon170.com/signups/?form=fall-campout' });
  await expect(page.getByRole('link', { name: 'Open registration' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Pay now' })).toHaveAttribute('href', paymentUrl);
});

test('shows no payment control when the event has no payment URL, and does not call it pending', async ({ page }) => {
  await openEvent(page, { paymentUrl: null });
  await expect(page.getByRole('link', { name: 'Pay now' })).toHaveCount(0);
  await expect(page.locator('.event-pending')).not.toContainText('payment');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx playwright test e2e/event-links.spec.ts`
Expected: the two "Pay now" tests FAIL (no such link). The existing tests still pass.

- [ ] **Step 3: Implement**

In `src/pages/events/index.astro`, after `const registration = ...` (line 76) add:

```ts
    const payment = e.paymentUrl ? webUrl(e.paymentUrl) : null;
```

and directly after the existing registration ternary (the entry that ends with `: '',` at line ~119, immediately before the `pending.length` entry), add:

```ts
        payment
          ? '<p class="event-action"><a class="button button--blue" href="' + esc(payment) + '">Pay now</a></p>'
          : e.paymentUrl
            ? '<p class="event-action event-action--broken">The payment link on file could not be opened. Ask the pack for a working link.</p>'
            : '',
```

Do not add `payment` to the `pending` list: payment is optional, so a missing link is not "still being confirmed".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx playwright test e2e/event-links.spec.ts && bun run check`
Expected: PASS. Because the events page changed, also open `/events/?event=fall-campout` in `bun run dev` against the stubbed or local CMS and look at the button at 1280px and 390px wide: it should sit under the registration action without horizontal scroll.

- [ ] **Step 5: Commit**

```bash
git add src/pages/events/index.astro e2e/event-links.spec.ts
git commit -m "$(cat <<'EOF'
feat(events): show a Pay now link for events with a payment URL

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Signup client and success notice (frontend)

**Files:**
- Modify: `src/lib/signup-client.ts:20` (type), `:186-190` (validate)
- Modify: `src/lib/signup-client.test.ts:20`
- Modify: `src/pages/signups/index.astro:34-41` (markup), `:~318` (script)
- Modify: `e2e/signup-form.spec.ts:19`, plus the `event:` fixture in `e2e/signup-edit.spec.ts` if it has one

**Interfaces:**
- Consumes: the CMS form JSON `event.paymentUrl: string | null` (Task 3, deployed). `PublicSignupForm` is also what `validateForm` returns.
- Produces: `PublicSignupForm.event.paymentUrl: string | null`; a `#signup-pay` link inside the `#signup-success` notice, hidden unless the event has a payment URL.

- [ ] **Step 1: Write the failing tests**

In `src/lib/signup-client.test.ts`, change the `event` entry at line 20 to include `paymentUrl: null`:

```ts
  event: { slug: 'lego-derby', title: 'Lego Derby', startsAt: '2026-09-12T22:00:00.000Z', paymentUrl: null },
```

and add a test next to the existing form-parsing tests (use the same fetch-stubbing helper those tests use; the snippet below assumes the file's `form` fixture and a `getSignupForm` import as in the neighboring tests):

```ts
  it('parses the event payment URL and rejects an unsafe one', async () => {
    const paymentUrl = 'https://buy.stripe.com/9B68wOdMpef0c9rfKpdjO00';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ version: 'v1', form: { ...form, event: { ...form.event, paymentUrl } } })));
    expect((await getSignupForm('lego-derby-food')).event.paymentUrl).toBe(paymentUrl);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ version: 'v1', form: { ...form, event: { ...form.event, paymentUrl: 'javascript:alert(1)' } } })));
    await expect(getSignupForm('lego-derby-food')).rejects.toThrow();
  });
```

In `e2e/signup-form.spec.ts`, add `paymentUrl: null` to the `baseForm.event` object (line 19), and add these tests after "submits JSON with the honeypot and Turnstile token, then says check your email":

```ts
async function submitFamily(page: Page) {
  await page.route(`${apiBase}/forms/${slug}/responses`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 'v1' }) }),
  );
  await page.goto(`/signups/?form=${slug}`);
  await page.fill('#family-name', 'The Hatchers');
  await page.fill('#email', 'family@example.com');
  await page.fill('#phone', '478-555-0123');
  await page.fill('[data-slot="buns"] input', '1');
  await page.click('#signup-submit');
  await expect(page.locator('#signup-success')).toBeVisible();
}

test('the success notice links to payment when the event has a payment URL', async ({ page }) => {
  const paymentUrl = 'https://buy.stripe.com/9B68wOdMpef0c9rfKpdjO00';
  await stubTurnstile(page);
  await stubForm(page, { ...baseForm, event: { ...baseForm.event, paymentUrl } });
  await submitFamily(page);
  await expect(page.locator('#signup-pay')).toBeVisible();
  await expect(page.locator('#signup-pay')).toHaveAttribute('href', paymentUrl);
});

test('the success notice has no payment link without a payment URL', async ({ page }) => {
  await stubTurnstile(page);
  await stubForm(page);
  await submitFamily(page);
  await expect(page.locator('#signup-pay')).toBeHidden();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/lib/signup-client.test.ts && bunx playwright test e2e/signup-form.spec.ts`
Expected: FAIL - `paymentUrl` is not parsed and `#signup-pay` does not exist.

- [ ] **Step 3: Implement the client**

In `src/lib/signup-client.ts`, change the `PublicSignupForm` event type (line 20) to:

```ts
  event: { slug: string; title: string; startsAt: string; paymentUrl: string | null };
```

and in `validateForm`, change the returned `event` to:

```ts
    event: {
      slug: requiredString(event, 'slug'),
      title: requiredString(event, 'title'),
      startsAt: requiredString(event, 'startsAt'),
      paymentUrl: nullableHttpsUrl(event, 'paymentUrl'),
    },
```

Add this helper next to `nullableString` in the same file:

```ts
function nullableHttpsUrl(value: Record<string, unknown>, key: string): string | null {
  const item = nullableString(value, key);
  if (item === null) return null;
  try {
    if (new URL(item).protocol !== 'https:') throw new Error('unsupported protocol');
    return item;
  } catch {
    throw new SignupClientError(`The signup service returned an invalid ${key}.`);
  }
}
```

- [ ] **Step 4: Implement the page**

In `src/pages/signups/index.astro`, inside the `#signup-success` notice, after the existing paragraph, add:

```html
            <p id="signup-pay-line" hidden>
              Payment for this event is separate. <a id="signup-pay" class="button button--blue" rel="noopener" href="#">Pay now</a>
            </p>
```

In the script, after `const success = ...` add:

```ts
  const payLine = document.querySelector<HTMLElement>('#signup-pay-line');
  const payLink = document.querySelector<HTMLAnchorElement>('#signup-pay');
```

In `load()`, directly after `const f = currentForm;`, add:

```ts
    if (f.event.paymentUrl && payLink && payLine) {
      payLink.href = f.event.paymentUrl;
      payLine.removeAttribute('hidden');
    }
```

(The link is set at load time, not at submit time, because the notice is only revealed after submit; this keeps the submit handler untouched.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run src/lib/signup-client.test.ts && bunx playwright test e2e/signup-form.spec.ts e2e/signup-edit.spec.ts && bun run check`
Expected: PASS. The parser now requires `event.paymentUrl`, so `e2e/signup-edit.spec.ts:13` (`event: { slug: 'lego-derby', title: 'Lego Derby', startsAt: '2026-09-12T22:00:00.000Z' }`) must also gain `paymentUrl: null` before its tests pass. Make that edit in this step.

- [ ] **Step 6: Run the full frontend suite**

Run: `bun run test && bun run lint && bun run format:check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/signup-client.ts src/lib/signup-client.test.ts src/pages/signups/index.astro e2e/signup-form.spec.ts e2e/signup-edit.spec.ts
git commit -m "$(cat <<'EOF'
feat(signups): link to payment from the signup success notice

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Release (requires explicit user approval at each gate)

This task changes shared systems. Do not run any command here without the user's go-ahead for that specific step; present it and wait.

**Files:** none (git and deployment operations).

- [ ] **Step 1: Ask the user to review both branches.** Summarize `feat/event-payment-link` in `macon170-cms` (Tasks 1-5) and in `macon170.com` (Tasks 6-8). Wait for approval to push and open PRs.
- [ ] **Step 2: CMS first.** After the CMS PR merges, and with approval: apply `0011_calendar_payment_url.sql` to remote D1 (`bun run db:migrate` from the CMS checkout) and deploy the CMS per `macon170-cms/AGENTS.md`. Then confirm `https://cms.macon170.com/api/calendar/v1/events` includes `"paymentUrl": null` on events.
- [ ] **Step 3: Frontend.** Only after step 2 is verified, merge the frontend PR and deploy it per `macon170.com/AGENTS.md`.
- [ ] **Step 4: Bump both pointers in one commit** in the meta repo:

```bash
git -C macon170-cms pull
git -C macon170.com pull
git add macon170-cms macon170.com
git commit -m "$(cat <<'EOF'
chore: bump submodules to the event payment link

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Set the link.** A volunteer opens the Fall Campout at `https://cms.macon170.com/admin/calendar`, pastes `https://buy.stripe.com/9B68wOdMpef0c9rfKpdjO00` into **Payment URL**, and saves. Verify `https://www.macon170.com/events/?event=fall-campout` shows "Pay now".
- [ ] **Step 6: Clean up the worktrees** once merged: `git -C macon170-cms worktree remove ../worktrees/event-payment-link` and `git -C macon170.com worktree remove ../worktrees/event-payment-link-site`.

---

## Self-review notes

- **Spec coverage:** migration and contract (Task 1), admin editor and MCP (Task 2), public projection (Task 3), email (Task 4), call sites and docs (Task 5), frontend parser/events page/signup notice (Tasks 6-8), rollout (Task 9). The spec's out-of-scope items have no tasks.
- **Spec corrections applied in the same commit as this plan:** the email option is a single `payment` object and the lookup is `getSignupEventPayment`; `pack.ts` and the manage-pack SKILL need no change.
- **Type consistency:** `paymentUrl: string | null` everywhere; `getSignupEventPayment` returns `{ eventTitle, url } | null`, which is exactly `SignupEmailOptions.payment`.
