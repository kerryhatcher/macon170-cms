import {
  smokeCalendar,
  type CalendarSmokeResult,
} from "./calendar-smoke";
import {
  smokeContact,
  type ContactSmokeResult,
} from "./contact-smoke";

type RetryOptions = {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  sleepImpl?: (delayMs: number) => Promise<void>;
  onRetry?: (message: string) => void;
};

type DeploymentSmokeOptions = {
  baseUrl: string;
  publicOrigin: string;
  expectedVersion?: string;
  fetchImpl?: typeof fetch;
  versionRetry?: Partial<RetryOptions>;
  smokeRetry?: Partial<RetryOptions>;
};

export type DeploymentSmokeResult = CalendarSmokeResult &
  ContactSmokeResult & {
  deploymentVersion: string | null;
};

const defaultVersionRetry: RetryOptions = {
  maxAttempts: 6,
  initialDelayMs: 1_000,
  maxDelayMs: 10_000,
};

const defaultSmokeRetry: RetryOptions = {
  maxAttempts: 4,
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
};

const sleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function retryWithBackoff<T>(
  label: string,
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleepImpl = options.sleepImpl ?? sleep;
  let delayMs = options.initialDelayMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === options.maxAttempts) break;
      options.onRetry?.(
        `${label} attempt ${attempt} failed: ${errorMessage(error)}; retrying in ${delayMs}ms`,
      );
      await sleepImpl(delayMs);
      delayMs = Math.min(delayMs * 2, options.maxDelayMs);
    }
  }

  throw new Error(
    `${label} failed after ${options.maxAttempts} attempts: ${errorMessage(lastError)}`,
  );
}

function retryOptions(
  defaults: RetryOptions,
  overrides: Partial<RetryOptions> | undefined,
): RetryOptions {
  return { ...defaults, ...overrides };
}

export async function waitForDeploymentVersion({
  baseUrl,
  expectedVersion,
  fetchImpl = fetch,
  retry,
}: {
  baseUrl: string;
  expectedVersion: string;
  fetchImpl?: typeof fetch;
  retry?: Partial<RetryOptions>;
}): Promise<string> {
  const origin = baseUrl.replace(/\/$/, "");
  return retryWithBackoff(
    "deployment version check",
    async (attempt) => {
      const url = new URL("/api/version", origin);
      url.searchParams.set("expected", expectedVersion);
      url.searchParams.set("attempt", String(attempt));
      const response = await fetchImpl(url, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status !== 200) {
        throw new Error(`version endpoint returned ${response.status}`);
      }
      const payload = (await response.json()) as {
        version?: unknown;
      };
      if (payload.version !== expectedVersion) {
        throw new Error(
          `expected ${expectedVersion}, received ${String(payload.version)}`,
        );
      }
      return expectedVersion;
    },
    retryOptions(defaultVersionRetry, retry),
  );
}

export async function smokeDeployment({
  baseUrl,
  publicOrigin,
  expectedVersion,
  fetchImpl = fetch,
  versionRetry,
  smokeRetry,
}: DeploymentSmokeOptions): Promise<DeploymentSmokeResult> {
  const deploymentVersion = expectedVersion
    ? await waitForDeploymentVersion({
        baseUrl,
        expectedVersion,
        fetchImpl,
        ...(versionRetry ? { retry: versionRetry } : {}),
      })
    : null;

  const result = await retryWithBackoff(
    "CMS smoke test",
    async () => ({
      ...(await smokeCalendar({ baseUrl, publicOrigin, fetchImpl })),
      ...(await smokeContact({ baseUrl, publicOrigin, fetchImpl })),
    }),
    retryOptions(defaultSmokeRetry, smokeRetry),
  );

  return { ...result, deploymentVersion };
}
