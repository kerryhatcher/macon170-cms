import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  countClaimedFamiliesBySlot,
  diffRemovedSlotIds,
  renderSignupAdminPage,
  renderSignupAdminDetailPage,
} from "./signup-admin-page";

// A minimal stand-in for a form/DOM element: just enough surface for the
// signup-admin-page inline script to read/write against. Extended (beyond
// Task 5's plain field-value surface) with a real parent/child tree,
// querySelector/querySelectorAll, remove(), and click() so the item-editor
// script's slotRow()/currentSlotRows()/#add-slot wiring — which builds a real
// row hierarchy and reads it back — can be driven end-to-end through the
// actual shipped script, not just asserted against as static markup.
interface FakeElement {
  name: string;
  value: string;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  className: string;
  type: string;
  dataset: Record<string, string>;
  parentElement: FakeElement | null;
  children: FakeElement[];
  addEventListener: (type: string, handler: (event: unknown) => unknown) => void;
  append: (...children: FakeElement[]) => void;
  replaceChildren: (...children: FakeElement[]) => void;
  remove: () => void;
  click: () => void;
  querySelector: (selector: string) => FakeElement | null;
  querySelectorAll: (selector: string) => FakeElement[];
}

function makeFakeElement(): FakeElement {
  const listeners: Record<string, Array<(event: unknown) => unknown>> = {};
  const self: FakeElement = {
    name: "",
    value: "",
    disabled: false,
    hidden: false,
    textContent: "",
    className: "",
    type: "",
    dataset: {},
    parentElement: null,
    children: [],
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
    append(...kids) {
      for (const kid of kids) {
        kid.parentElement = self;
        self.children.push(kid);
      }
    },
    replaceChildren(...kids) {
      self.children = [];
      self.append(...kids);
    },
    remove() {
      if (self.parentElement) {
        self.parentElement.children = self.parentElement.children.filter(
          (child) => child !== self,
        );
        self.parentElement = null;
      }
    },
    click() {
      for (const handler of listeners.click ?? []) handler({});
    },
    querySelector(selector) {
      // Only the one selector shape the shipped script actually uses on a
      // row: '[name="fieldName"]'.
      const match = /^\[name="([^"]+)"\]$/.exec(selector);
      if (!match) return null;
      return self.children.find((child) => child.name === match[1]) ?? null;
    },
    querySelectorAll(selector) {
      // Only the one selector shape the shipped script actually uses on the
      // slot list: '.slot-row'.
      const className = selector.startsWith(".") ? selector.slice(1) : null;
      if (!className) return [];
      return self.children.filter((child) => child.className === className);
    },
  };
  return self;
}

interface FakeRequest {
  path: string;
  method: string;
  body: string | undefined;
}

/**
 * Extracts the inline `<script type="module">` from a rendered signup admin
 * detail page and runs it against a hand-built DOM/fetch stand-in, so tests
 * can drive the *actual shipped script* (not a reimplementation of its
 * logic) through a save and inspect the resulting network request.
 */
function runSignupDetailScript(
  html: string,
  loadedForm: {
    id: string;
    title: string;
    slug: string;
    state: string;
    instructions: string;
    closesAt: string | null;
    formType: string;
    eventId: string;
    revision: number;
    slots: unknown[];
  },
  loadedResponses: Array<{ claims: Array<{ slotId: string }> }> = [],
  // When provided, the calendar-admin event list resolves with these instead
  // of the 403 the degrade-path tests rely on.
  calendarEvents: Array<{
    id: string;
    title: string;
    startsAt: string;
    publicationState: string;
  }> | null = null,
) {
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("module script not found in rendered page");
  const script = match[1];

  const eventSelectEl = makeFakeElement();
  const elementsByName: Record<string, FakeElement> = {
    title: makeFakeElement(),
    slug: makeFakeElement(),
    eventId: eventSelectEl,
    state: makeFakeElement(),
    instructions: makeFakeElement(),
    closesAt: makeFakeElement(),
    formType: makeFakeElement(),
  };
  const settingsFormListeners: Record<string, (event: unknown) => unknown> = {};
  const settingsFormEl = {
    elements: { namedItem: (name: string) => elementsByName[name] },
    addEventListener(type: string, handler: (event: unknown) => unknown) {
      settingsFormListeners[type] = handler;
    },
  };
  const slotListEl = makeFakeElement();
  const slotEditorEl = makeFakeElement();
  const byId: Record<string, unknown> = {
    "#notice": makeFakeElement(),
    "#settings-form": settingsFormEl,
    "#save": makeFakeElement(),
    "#event-select": eventSelectEl,
    "#form-type": makeFakeElement(),
    "#slot-editor": slotEditorEl,
    "#add-slot": makeFakeElement(),
    "#slot-list": slotListEl,
    "#responses": makeFakeElement(),
  };

  const confirmCalls: string[] = [];
  let confirmResult = true;

  const requests: FakeRequest[] = [];
  const fakeFetch = async (path: string, options: { method?: string; body?: string } = {}) => {
    const method = options.method ?? "GET";
    requests.push({ path, method, body: options.body });
    if (path.startsWith("/api/signups-admin/v1/forms/") && method === "GET") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          form: loadedForm,
          responses: loadedResponses,
          summary: { families: 0, attending: 0, adults: 0, children: 0, unconfirmed: 0 },
        }),
      };
    }
    if (path === "/api/calendar-admin/v1/events") {
      if (calendarEvents) {
        return { ok: true, status: 200, json: async () => ({ events: calendarEvents }) };
      }
      return {
        ok: false,
        status: 403,
        json: async () => ({ error: { message: "Forbidden" } }),
      };
    }
    if (path.startsWith("/api/signups-admin/v1/forms/") && method === "PUT") {
      return { ok: true, status: 200, json: async () => ({ form: loadedForm }) };
    }
    throw new Error(`Unexpected fetch: ${method} ${path}`);
  };

  class FakeFormData {
    private readonly pairs: Array<[string, string]>;
    constructor() {
      this.pairs = Object.entries(elementsByName)
        .filter(([, element]) => !element.disabled)
        .map(([name, element]) => [name, element.value] as [string, string]);
    }
    entries() {
      return this.pairs[Symbol.iterator]();
    }
  }

  const sandbox: Record<string, unknown> = {
    document: {
      querySelector: (selector: string) => byId[selector] ?? null,
      createElement: () => makeFakeElement(),
    },
    fetch: fakeFetch,
    FormData: FakeFormData,
    Headers,
    window: {
      location: { href: "" },
      confirm: (message: string) => {
        confirmCalls.push(message);
        return confirmResult;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  return {
    eventSelectEl,
    settingsFormListeners,
    requests,
    slotListEl,
    slotEditorEl,
    elementsByName,
    confirmCalls,
    setConfirmResult: (result: boolean) => {
      confirmResult = result;
    },
  };
}

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
  it("links to the new-signup route when the volunteer can create forms", () => {
    const html = renderSignupAdminPage("csrf-token", true);
    expect(html).toContain('href="/admin/signups/new"');
    expect(html).toContain("New form");
  });

  it("hides the new-form link from a volunteer without calendar.manage", () => {
    // /admin/signups/new is gated on calendar.manage server-side, so offering
    // the link to a signups-only volunteer just leads them to a raw JSON 403.
    const html = renderSignupAdminPage("csrf-token", false);
    expect(html).not.toContain('href="/admin/signups/new"');
    expect(html).toContain("calendar.manage permission");
  });
});

describe("renderSignupAdminDetailPage", () => {
  it("never lets an attacker-controlled formId close the inline <script> element", () => {
    const hostile = "</script><script>alert(1)</script>";
    const html = renderSignupAdminDetailPage("csrf-token", hostile);
    expect(html).not.toContain("</script><script>");
  });

  it("escapes the CSRF token interpolation too", () => {
    // Same scriptSafeJson choke point, second call site. A mutation there
    // breaks both, so both need a case or one of them proves nothing.
    const html = renderSignupAdminDetailPage(
      "</script><script>alert(2)</script>",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(html).not.toContain("</script><script>");
  });

  it("renders the settings panel with the event picker and a hidden slot editor", () => {
    const html = renderSignupAdminDetailPage(
      "csrf-token",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(html).toContain('id="settings-form"');
    expect(html).toContain('id="event-select"');
    expect(html).toContain('id="slot-editor"');
  });

  it("labels the private volunteer response columns as Your Name and Phone", () => {
    const html = renderSignupAdminDetailPage(
      "csrf-token",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(html).toContain("'Your Name', 'Email', 'Phone'");
    expect(html).toContain("entry.phone ?? '—'");
    expect(html).not.toContain("['Family', 'Email'");
  });

  it("renders create mode without a form id and without a response section", () => {
    const html = renderSignupAdminDetailPage("csrf-token", null);
    expect(html).toContain("New signup form");
    expect(html).toContain("Create signup");
    expect(html).not.toContain('id="responses-section"');
  });

  it("keeps the loaded event id in the save payload when the event picker is disabled by a 403 degrade", async () => {
    const formId = "11111111-1111-4111-8111-111111111111";
    const html = renderSignupAdminDetailPage("csrf-token", formId);
    const loadedForm = {
      id: formId,
      title: "Fall Campout",
      slug: "fall-campout",
      state: "open",
      instructions: "Bring your own tent.",
      closesAt: null,
      formType: "rsvp",
      eventId: "event-1",
      revision: 3,
      slots: [],
    };

    const { eventSelectEl, settingsFormListeners, requests } = runSignupDetailScript(
      html,
      loadedForm,
    );

    // Let the immediately-invoked loadForm() — and the nested
    // loadEventOptions() 403 catch that disables #event-select — settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(eventSelectEl.disabled).toBe(true);

    const submitHandler = settingsFormListeners.submit;
    expect(typeof submitHandler).toBe("function");
    await submitHandler({ preventDefault() {} });

    const putRequest = requests.find((entry) => entry.method === "PUT");
    expect(putRequest).toBeDefined();
    const putBody = JSON.parse(putRequest?.body ?? "{}");
    // A disabled <select> is excluded from FormData, so without the
    // currentForm fallback this would be undefined and the server would
    // reject the save — the exact bug the degrade path exists to avoid.
    expect(putBody.eventId).toBe("event-1");
  });

  it("disables the slot editor, not just hides it, when the form is not an items form", async () => {
    // A hidden-but-enabled fieldset keeps its required item inputs in the
    // form's constraint validation, so an empty label left behind by switching
    // to RSVP makes the browser silently refuse to submit.
    const formId = "11111111-1111-4111-8111-111111111111";
    const html = renderSignupAdminDetailPage("csrf-token", formId);
    const loadedForm = {
      id: formId,
      title: "Fall Campout",
      slug: "fall-campout",
      state: "open",
      instructions: "",
      closesAt: null,
      formType: "rsvp",
      eventId: "event-1",
      revision: 3,
      slots: [],
    };

    const { slotEditorEl } = runSignupDetailScript(html, loadedForm);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(slotEditorEl.hidden).toBe(true);
    expect(slotEditorEl.disabled).toBe(true);
  });

  it("enables the slot editor for an items form", async () => {
    const formId = "11111111-1111-4111-8111-111111111111";
    const html = renderSignupAdminDetailPage("csrf-token", formId);
    const loadedForm = {
      id: formId,
      title: "Fall Campout",
      slug: "fall-campout",
      state: "open",
      instructions: "",
      closesAt: null,
      formType: "items",
      eventId: "event-1",
      revision: 3,
      slots: [],
    };

    const { slotEditorEl } = runSignupDetailScript(html, loadedForm);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(slotEditorEl.hidden).toBe(false);
    expect(slotEditorEl.disabled).toBe(false);
  });

  it("forces an explicit event choice in create mode and lists upcoming events first", async () => {
    const html = renderSignupAdminDetailPage("csrf-token", null);
    const past = new Date(Date.now() - 30 * 86400000).toISOString();
    const older = new Date(Date.now() - 400 * 86400000).toISOString();
    const soon = new Date(Date.now() + 7 * 86400000).toISOString();
    const later = new Date(Date.now() + 30 * 86400000).toISOString();

    const { eventSelectEl } = runSignupDetailScript(
      html,
      {
        id: "unused",
        title: "",
        slug: "",
        state: "draft",
        instructions: "",
        closesAt: null,
        formType: "rsvp",
        eventId: "",
        revision: 0,
        slots: [],
      },
      [],
      [
        { id: "older", title: "Older", startsAt: older, publicationState: "published" },
        { id: "later", title: "Later", startsAt: later, publicationState: "published" },
        { id: "past", title: "Past", startsAt: past, publicationState: "published" },
        { id: "soon", title: "Soon", startsAt: soon, publicationState: "published" },
      ],
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // An empty-valued first option is what makes the required <select> block a
    // save that never picked an event; without it the browser preselects a
    // real option and the signup silently lands on whatever sorted first.
    expect(eventSelectEl.children[0]?.value).toBe("");
    expect(eventSelectEl.children.map((option) => option.value)).toEqual([
      "",
      "soon",
      "later",
      "older",
      "past",
    ]);
  });

  it("renders the add-item button inside the slot editor", () => {
    const html = renderSignupAdminDetailPage(
      "csrf-token",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(html).toContain('id="add-slot"');
    expect(html).toContain('id="slot-list"');
  });

  it("confirms before saving when removing an item that has claims", async () => {
    const formId = "11111111-1111-4111-8111-111111111111";
    const html = renderSignupAdminDetailPage("csrf-token", formId);
    const loadedForm = {
      id: formId,
      title: "Fall Campout",
      slug: "fall-campout",
      state: "open",
      instructions: "",
      closesAt: null,
      formType: "items",
      eventId: "event-1",
      revision: 3,
      slots: [{ id: "slot-a", label: "Hot dogs", quantityNeeded: 20, notes: null }],
    };
    const loadedResponses = [
      { claims: [{ slotId: "slot-a" }] },
      { claims: [{ slotId: "slot-a" }] },
    ];

    const { slotListEl, settingsFormListeners, requests, confirmCalls } =
      runSignupDetailScript(html, loadedForm, loadedResponses);

    // Let loadForm() — which renders the slot editor from the loaded form —
    // settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rows = slotListEl.querySelectorAll(".slot-row");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.dataset.slotId).toBe("slot-a");

    // Simulate clicking the row's Remove button, exactly as a volunteer
    // would in the real DOM — not just deleting the row out from under the
    // script.
    const removeButton = row.children.find((child) => child.className === "danger");
    expect(removeButton).toBeDefined();
    removeButton?.click();
    expect(slotListEl.querySelectorAll(".slot-row")).toHaveLength(0);

    const submitHandler = settingsFormListeners.submit;
    expect(typeof submitHandler).toBe("function");
    await submitHandler({ preventDefault() {} });

    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]).toContain("Hot dogs");
    expect(confirmCalls[0]).toContain("2 families");

    // Confirm defaults to accepted, so the save still goes through with the
    // item gone from the payload.
    const putRequest = requests.find((entry) => entry.method === "PUT");
    expect(putRequest).toBeDefined();
    const putBody = JSON.parse(putRequest?.body ?? "{}");
    expect(putBody.slots).toEqual([]);
  });

  it("does not confirm when an existing item is only edited in place, not removed", async () => {
    const formId = "11111111-1111-4111-8111-111111111111";
    const html = renderSignupAdminDetailPage("csrf-token", formId);
    const loadedForm = {
      id: formId,
      title: "Fall Campout",
      slug: "fall-campout",
      state: "open",
      instructions: "",
      closesAt: null,
      formType: "items",
      eventId: "event-1",
      revision: 3,
      slots: [{ id: "slot-a", label: "Hot dogs", quantityNeeded: 20, notes: null }],
    };
    const loadedResponses = [{ claims: [{ slotId: "slot-a" }] }];

    const { slotListEl, settingsFormListeners, requests, confirmCalls } =
      runSignupDetailScript(html, loadedForm, loadedResponses);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rows = slotListEl.querySelectorAll(".slot-row");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.dataset.slotId).toBe("slot-a");

    // Edit the label in place — same id, different value — the way a
    // volunteer correcting a typo would, without removing the row.
    const labelInput = row.querySelector('[name="label"]');
    expect(labelInput).not.toBeNull();
    labelInput!.value = "Hot dogs (bring buns too)";

    const submitHandler = settingsFormListeners.submit;
    await submitHandler({ preventDefault() {} });

    expect(confirmCalls).toHaveLength(0);

    const putRequest = requests.find((entry) => entry.method === "PUT");
    expect(putRequest).toBeDefined();
    const putBody = JSON.parse(putRequest?.body ?? "{}");
    expect(putBody.slots).toEqual([
      { id: "slot-a", label: "Hot dogs (bring buns too)", quantityNeeded: 20, notes: null },
    ]);
  });
});
