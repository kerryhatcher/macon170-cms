import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  countClaimedFamiliesBySlot,
  diffRemovedSlotIds,
  renderSignupAdminPage,
  renderSignupAdminDetailPage,
} from "./signup-admin-page";

// A minimal stand-in for a form/DOM element: just enough surface for the
// signup-admin-page inline script to read/write against.
interface FakeElement {
  value: string;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  className: string;
  type: string;
  dataset: Record<string, string>;
  addEventListener: (type: string, handler: (event: unknown) => unknown) => void;
  append: (...children: unknown[]) => void;
  replaceChildren: (...children: unknown[]) => void;
}

function makeFakeElement(): FakeElement {
  return {
    value: "",
    disabled: false,
    hidden: false,
    textContent: "",
    className: "",
    type: "",
    dataset: {},
    addEventListener() {},
    append() {},
    replaceChildren() {},
  };
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
  const byId: Record<string, unknown> = {
    "#notice": makeFakeElement(),
    "#settings-form": settingsFormEl,
    "#save": makeFakeElement(),
    "#event-select": eventSelectEl,
    "#form-type": makeFakeElement(),
    "#slot-editor": makeFakeElement(),
    "#responses": makeFakeElement(),
  };

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
          responses: [],
          summary: { families: 0, attending: 0, adults: 0, children: 0, unconfirmed: 0 },
        }),
      };
    }
    if (path === "/api/calendar-admin/v1/events") {
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
    window: { location: { href: "" } },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  return { eventSelectEl, settingsFormListeners, requests };
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
  it("links to the new-signup route", () => {
    const html = renderSignupAdminPage("csrf-token");
    expect(html).toContain('href="/admin/signups/new"');
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
});
