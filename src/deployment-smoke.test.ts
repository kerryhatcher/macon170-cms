import { describe, expect, it, vi } from "vitest";

import {
  retryWithBackoff,
  waitForDeploymentVersion,
} from "./deployment-smoke";

describe("deployment smoke orchestration", () => {
  it("retries with bounded exponential backoff", async () => {
    const sleepImpl = vi.fn(async () => undefined);
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValue("ok");

    await expect(
      retryWithBackoff("test operation", operation, {
        maxAttempts: 4,
        initialDelayMs: 100,
        maxDelayMs: 150,
        sleepImpl,
      }),
    ).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenNthCalledWith(1, 100);
    expect(sleepImpl).toHaveBeenNthCalledWith(2, 150);
  });

  it("fails after the configured number of attempts", async () => {
    const operation = vi.fn(async () => {
      throw new Error("still unavailable");
    });

    await expect(
      retryWithBackoff("test operation", operation, {
        maxAttempts: 2,
        initialDelayMs: 1,
        maxDelayMs: 1,
        sleepImpl: async () => undefined,
      }),
    ).rejects.toThrow(
      "test operation failed after 2 attempts: still unavailable",
    );
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("waits until the expected deployed version is served", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ version: "old-version" }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ version: "new-version" }));
    const sleepImpl = vi.fn(async () => undefined);

    await expect(
      waitForDeploymentVersion({
        baseUrl: "https://cms.macon170.com",
        expectedVersion: "new-version",
        fetchImpl,
        retry: {
          maxAttempts: 4,
          initialDelayMs: 10,
          maxDelayMs: 20,
          sleepImpl,
        },
      }),
    ).resolves.toBe("new-version");

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenNthCalledWith(1, 10);
    expect(sleepImpl).toHaveBeenNthCalledWith(2, 20);
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain("attempt=3");
  });
});
