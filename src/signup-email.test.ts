import { describe, expect, it, vi } from "vitest";

import {
  renderSignupEmail,
  sendSignupLinkEmail,
  signupLinkUrl,
} from "./signup-email";
import type { SignupBindings } from "./signups";

const env = {
  PUBLIC_SITE_ORIGIN: "https://www.macon170.com",
  POSTMARK_SERVER_TOKEN: "key-test",
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
  it("sends text and HTML through Postmark with open tracking enabled and link tracking disabled", async () => {
    const send = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ ErrorCode: 0, Message: "OK", MessageID: "message-test", To: "parent@example.com", SubmittedAt: "2026-10-07T22:00:00Z" })));
    await sendSignupLinkEmail(
      env,
      { email: "parent@example.com", name: "Hatcher" },
      options,
      send,
    );
    expect(send).toHaveBeenCalledOnce();
    const [url, request] = send.mock.calls[0];
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect(request.headers["X-Postmark-Server-Token"]).toBe("key-test");
    expect(request.headers["Content-Type"]).toBe("application/json");
    expect(request.redirect).toBe("manual");
    const body = JSON.parse(request.body);
    expect(body.From).toBe("Pack 170 Volunteers <volunteers@macon170.com>");
    expect(body.To).toBe("parent@example.com");
    expect(body.TextBody).toContain(options.linkUrl);
    expect(body.HtmlBody).toContain(options.linkUrl);
    expect(body.ReplyTo).toBe("contact@macon170.com");
    expect(body.MessageStream).toBe("outbound");
    expect(body.TrackLinks).toBe("None");
    expect(body.TrackOpens).toBe(true);
  });

  it("omits Reply-To when SIGNUP_REPLY_TO is unset", async () => {
    const send = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ ErrorCode: 0, Message: "OK", MessageID: "message-test", To: "parent@example.com", SubmittedAt: "2026-10-07T22:00:00Z" })));
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
    expect(JSON.parse(send.mock.calls[0][1].body)).not.toHaveProperty("ReplyTo");
  });

  it("throws when the Postmark server token is missing", async () => {
    const { POSTMARK_SERVER_TOKEN, ...withoutKey } = env as unknown as Record<
      string,
      unknown
    >;
    await expect(
      sendSignupLinkEmail(
        withoutKey as unknown as SignupBindings,
        { email: "parent@example.com", name: "Hatcher" },
        options,
      ),
    ).rejects.toThrow("Postmark");
  });

  it("throws when Postmark rejects the message", async () => {
    await expect(
      sendSignupLinkEmail(
        env,
        { email: "parent@example.com", name: "Hatcher" },
        options,
        vi.fn().mockResolvedValue(new Response("rejected", { status: 500 })),
      ),
    ).rejects.toThrow("500");
  });

  it("sanitizes network failures instead of exposing credentials or message content", async () => {
    await expect(sendSignupLinkEmail(env, { email: "parent@example.com", name: "Parent" }, options,
      vi.fn().mockRejectedValue(new Error("key-test token=abc parent@example.com")),
    )).rejects.toThrow(/^Postmark request failed\.$/);
  });

  it.each([
    { ErrorCode: 10, Message: "key-test token=abc" },
    { ErrorCode: 0, MessageID: "" },
    { MessageID: "message-test" },
    null,
  ])("rejects an unconfirmed provider result without exposing its body: %j", async (result) => {
    const send = vi.fn(() => Promise.resolve(Response.json(result)));
    await expect(sendSignupLinkEmail(env, { email: "parent@example.com", name: "Parent" }, options, send)).rejects.toThrow(/^Postmark request failed\.$/);
    expect(send).toHaveBeenCalledOnce();
  });

  it("rejects malformed JSON even with HTTP success", async () => {
    await expect(sendSignupLinkEmail(env, { email: "parent@example.com", name: "Parent" }, options,
      vi.fn(() => Promise.resolve(new Response("key-test token=abc"))),
    )).rejects.toThrow(/^Postmark request failed\.$/);
  });

  it.each(["POSTMARK_API_TEST", " POSTMARK_API_TEST ", "\tPOSTMARK_API_TEST\t"])("refuses the no-delivery test token %j in production before contacting Postmark", async (token) => {
    const send = vi.fn(() => Promise.resolve(Response.json({ ErrorCode: 0, MessageID: "test-only" })));
    await expect(sendSignupLinkEmail({ ...env, ENVIRONMENT: "production", POSTMARK_SERVER_TOKEN: token },
      { email: "parent@example.com", name: "Parent" }, options, send,
    )).rejects.toThrow("not configured");
    expect(send).not.toHaveBeenCalled();
  });
});
