import { readFile, writeFile } from "node:fs/promises";

const [
  name,
  databaseName,
  databaseId,
  bucketName,
  siteOrigin,
  rateLimitNamespace,
] = process.argv.slice(2);
if (
  ![
    name,
    databaseName,
    databaseId,
    bucketName,
    siteOrigin,
    rateLimitNamespace,
  ].every(Boolean)
)
  throw new Error("missing preview configuration");

const config = JSON.parse(await readFile("wrangler.preview.jsonc", "utf8"));
config.name = name;
config.d1_databases[0].database_name = databaseName;
config.d1_databases[0].database_id = databaseId;
config.r2_buckets[0].bucket_name = bucketName;
config.ratelimits[0].namespace_id = rateLimitNamespace;
config.vars.CORS_ORIGINS = siteOrigin;
config.vars.PUBLIC_SITE_ORIGIN = siteOrigin;
config.vars.TURNSTILE_EXPECTED_HOSTNAMES = new URL(siteOrigin).hostname;
await writeFile(
  ".wrangler.preview.generated.json",
  `${JSON.stringify(config, null, 2)}\n`,
);

// A minimal Worker used only while closing a preview. It lists and deletes all
// objects before the bucket itself is removed; R2 will reject deleting a
// non-empty bucket.
const cleanupConfig = {
  name: `${name}-cleanup`,
  main: "scripts/empty-preview-bucket.ts",
  compatibility_date: config.compatibility_date,
  workers_dev: true,
  r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: bucketName }],
};
await writeFile(
  ".wrangler.preview.cleanup.generated.json",
  `${JSON.stringify(cleanupConfig, null, 2)}\n`,
);
config.d1_databases[0].migrations_dir = "./migrations/custom";
await writeFile(
  ".wrangler.preview.custom.generated.json",
  `${JSON.stringify(config, null, 2)}\n`,
);
