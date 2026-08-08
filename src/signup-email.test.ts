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
