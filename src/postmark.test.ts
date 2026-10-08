import { afterEach, describe, expect, it, vi } from "vitest";
import { sendPostmarkEmail } from "./postmark";

afterEach(() => vi.useRealTimers());

describe("Postmark delivery deadline", () => {
  it.each(["accepted", "rejected", "malformed"])("clears the deadline immediately after a quick %s response", async (outcome) => {
    vi.useFakeTimers();
    const send = vi.fn<typeof fetch>(async () => outcome === "accepted"
      ? Response.json({ ErrorCode: 0, MessageID: "message-test", Message: "OK", To: "parent@example.test", SubmittedAt: "2026-10-07T22:00:00Z" })
      : new Response("private provider details", { status: outcome === "rejected" ? 403 : 200 }));
    const delivery = sendPostmarkEmail({ POSTMARK_SERVER_TOKEN: "private-key" }, {
      from: "volunteers@example.test", to: "parent@example.test", subject: "Setup",
      text: "Setup", html: "Setup",
    }, send);
    if (outcome === "accepted") await expect(delivery).resolves.toBeUndefined();
    else await expect(delivery).rejects.toThrow(outcome === "rejected" ? "403" : /^Postmark request failed\.$/);
    // No clock advance: this catches a missing finally cleanup even on success.
    expect(vi.getTimerCount()).toBe(0);
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(["headers", "body"])("fails safely when the provider stalls at %s, without retrying", async (stage) => {
    vi.useFakeTimers();
    const send = vi.fn<typeof fetch>((_url, init) => {
      const failure = new Error("private-key token=private-link");
      if (stage === "headers") {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(failure), { once: true });
        });
      }
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(failure), { once: true });
        },
      })));
    });
    const delivery = sendPostmarkEmail({ POSTMARK_SERVER_TOKEN: "private-key" }, {
      from: "volunteers@example.test", to: "parent@example.test", subject: "Setup",
      text: "token=private-link", html: "token=private-link",
    }, send);
    const result = expect(delivery).rejects.toThrow(/^Postmark request failed\.$/);
    expect(send.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
