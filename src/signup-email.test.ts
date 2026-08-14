import { describe, expect, it, vi } from "vitest";

import {
  renderSignupEmail,
  sendSignupLinkEmail,
  signupLinkUrl,
} from "./signup-email";
import type { SignupBindings } from "./signups";

const env = {
  PUBLIC_SITE_ORIGIN: "https://www.macon170.com",
  MAILGUN_API_KEY: "key-test",
  MAILGUN_DOMAIN: "macon170.com",
  SIGNUP_FROM_EMAIL: "volunteers@macon170.com",
  SIGNUP_FROM_NAME: "Pack 170 Volunteers",
  SIGNUP_REPLY_TO: "contact@macon170.com",
} as unknown as SignupBindings;

const options = {
  name: "Kerry & <Family>",
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
    expect(message.text).toContain("Hi Kerry & <Family>,");
  });

  it("mentions the deadline only when one is set", () => {
    expect(renderSignupEmail(options).text).toMatch(/February 28, 2027/);
    expect(
      renderSignupEmail({ ...options, closesAt: null }).text,
    ).not.toMatch(/Sign up by/);
  });
});

describe("signup email delivery", () => {
  it("sends text and HTML through Mailgun with tracking disabled", async () => {
    const send = vi.fn().mockResolvedValue(new Response("accepted", { status: 200 }));
    await sendSignupLinkEmail(
      env,
      { email: "parent@example.com", name: "Hatcher" },
      options,
      send,
    );
    expect(send).toHaveBeenCalledOnce();
    const [url, request] = send.mock.calls[0];
    expect(url).toBe("https://api.mailgun.net/v3/macon170.com/messages");
    expect(request.headers.Authorization).toBe(`Basic ${btoa("api:key-test")}`);
    const body = request.body as FormData;
    expect(body.get("from")).toBe("Pack 170 Volunteers <volunteers@macon170.com>");
    expect(body.get("to")).toBe("parent@example.com");
    expect(body.get("text")).toContain(options.linkUrl);
    expect(body.get("html")).toContain(options.linkUrl);
    expect(body.get("h:Reply-To")).toBe("contact@macon170.com");
    expect(body.get("o:tracking")).toBe("no");
    expect(body.get("o:tracking-clicks")).toBe("no");
    expect(body.get("o:tracking-opens")).toBe("no");
  });

  it("omits Reply-To when SIGNUP_REPLY_TO is unset", async () => {
    const send = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const { SIGNUP_REPLY_TO, ...withoutReplyTo } = env as unknown as Record<
      string,
      unknown
    >;
    await sendSignupLinkEmail(
      withoutReplyTo as unknown as SignupBindings,
      { email: "parent@example.com", name: "Hatcher" },
      options,
      send,
    );
    expect((send.mock.calls[0][1].body as FormData).has("h:Reply-To")).toBe(false);
  });

  it("throws when the Mailgun key is missing", async () => {
    const { MAILGUN_API_KEY, ...withoutKey } = env as unknown as Record<
      string,
      unknown
    >;
    await expect(
      sendSignupLinkEmail(
        withoutKey as unknown as SignupBindings,
        { email: "parent@example.com", name: "Hatcher" },
        options,
      ),
    ).rejects.toThrow("Mailgun");
  });

  it("throws when Mailgun rejects the message", async () => {
    await expect(
      sendSignupLinkEmail(
        env,
        { email: "parent@example.com", name: "Hatcher" },
        options,
        vi.fn().mockResolvedValue(new Response("rejected", { status: 500 })),
      ),
    ).rejects.toThrow("500");
  });
});
