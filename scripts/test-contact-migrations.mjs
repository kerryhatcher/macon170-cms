import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const persistTo = await mkdtemp(join(tmpdir(), "macon170-cms-contact-"));

async function run(args) {
  const child = Bun.spawn(args, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${args.join(" ")} failed (${exitCode})\n${stdout}\n${stderr}`,
    );
  }
  return stdout;
}

try {
  const base = [
    "bunx",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "macon170-cms",
    "--local",
    "--persist-to",
    persistTo,
  ];
  await run([...base, "--config", "wrangler.jsonc"]);
  await run([...base, "--config", "wrangler.custom-migrations.jsonc"]);

  // Reproduce the early-production state: the original contact migration was
  // ledgered without its form-backed collection. The repair must restore that
  // dependency before the Worker can insert a linked content record.
  await run([
    "bunx",
    "wrangler",
    "d1",
    "execute",
    "macon170-cms",
    "--local",
    "--persist-to",
    persistTo,
    "--config",
    "wrangler.jsonc",
    "--command",
    "DELETE FROM collections WHERE id = 'collection-form-contact'",
  ]);
  await run([
    "bunx",
    "wrangler",
    "d1",
    "execute",
    "macon170-cms",
    "--local",
    "--persist-to",
    persistTo,
    "--config",
    "wrangler.custom-migrations.jsonc",
    "--file",
    "migrations/custom/0003_repair_contact_collection.sql",
  ]);

  // Re-applying the tracked custom migrations must be a no-op, not a duplicate
  // ALTER/INSERT failure.
  await run([...base, "--config", "wrangler.custom-migrations.jsonc"]);

  const output = await run([
    "bunx",
    "wrangler",
    "d1",
    "execute",
    "macon170-cms",
    "--local",
    "--persist-to",
    persistTo,
    "--config",
    "wrangler.jsonc",
    "--json",
    "--command",
    `SELECT
       forms.id,
       forms.name,
       json_extract(forms.settings, '$.version') AS version,
       json_array_length(json_extract(forms.formio_schema, '$.components')) AS component_count,
       forms.turnstile_enabled,
       json_extract(forms.turnstile_settings, '$.inherit') AS inherits_turnstile,
       collections.id AS collection_id,
       (SELECT COUNT(*) FROM pragma_table_info('form_submissions')
        WHERE name IN ('source_path', 'country_code', 'last_viewed_at')) AS contact_columns,
       (SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'table' AND name = 'contact_submission_audit') AS audit_table,
       (SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'trigger' AND name = 'delete_contact_submission_content') AS retention_trigger,
       (SELECT status FROM plugins WHERE id = 'turnstile') AS turnstile_plugin_status,
       (SELECT json_extract(settings, '$.enabled')
        FROM plugins WHERE id = 'turnstile') AS turnstile_plugin_enabled,
       (SELECT json_extract(settings, '$.secretKey')
        FROM plugins WHERE id = 'turnstile') AS turnstile_plugin_secret
     FROM forms
     JOIN collections
       ON collections.source_type = 'form'
      AND collections.source_id = forms.id
     WHERE forms.id = 'default-contact-form'`,
  ]);
  const result = JSON.parse(output);
  const row = result[0]?.results?.[0];
  const expected = {
    id: "default-contact-form",
    name: "contact",
    version: "pack-contact-v1",
    component_count: 8,
    turnstile_enabled: 0,
    inherits_turnstile: 0,
    collection_id: "collection-form-contact",
    contact_columns: 3,
    audit_table: 1,
    retention_trigger: 1,
    turnstile_plugin_status: "inactive",
    turnstile_plugin_enabled: 0,
    turnstile_plugin_secret: "",
  };
  if (JSON.stringify(row) !== JSON.stringify(expected)) {
    throw new Error(
      `Contact migration contract mismatch:\n${JSON.stringify(row, null, 2)}`,
    );
  }
  console.log(
    JSON.stringify({
      status: "ok",
      migration: "0002_contact_form.sql",
      version: row.version,
      idempotent: true,
    }),
  );
} finally {
  await rm(persistTo, { recursive: true, force: true });
}
