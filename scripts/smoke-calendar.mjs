import { smokeDeployment } from "../src/deployment-smoke.ts";

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const result = await smokeDeployment({
  baseUrl: process.env.CMS_BASE_URL ?? "https://cms.macon170.com",
  publicOrigin:
    process.env.PUBLIC_SITE_ORIGIN ?? "https://www.macon170.com",
  expectedVersion: process.env.EXPECTED_VERSION?.trim() || undefined,
  versionRetry: {
    maxAttempts: positiveInteger(process.env.VERSION_MAX_ATTEMPTS, 6),
    onRetry: console.warn,
  },
  smokeRetry: {
    maxAttempts: positiveInteger(process.env.SMOKE_MAX_ATTEMPTS, 4),
    onRetry: console.warn,
  },
});

console.log(JSON.stringify({ status: "ok", ...result }));
