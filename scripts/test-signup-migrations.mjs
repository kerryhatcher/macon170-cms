import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const persistTo = await mkdtemp(join(tmpdir(), "macon170-cms-signups-"));

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

function execute(command) {
  return run([
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
    command,
  ]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await run([...base, "--config", "wrangler.jsonc"]);
  await run([...base, "--config", "wrangler.custom-migrations.jsonc"]);
  // Re-applying tracked custom migrations must be a no-op.
  await run([...base, "--config", "wrangler.custom-migrations.jsonc"]);

  const shape = JSON.parse(
    await execute(
      `SELECT
         (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'
           AND name IN ('signup_forms','signup_slots','signup_responses',
                        'signup_claims','signup_audit')) AS tables,
         (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'
           AND name IN ('signup_claims_capacity_insert',
                        'signup_claims_capacity_update')) AS triggers,
         (SELECT COUNT(*) FROM permissions WHERE name = 'signups.manage')
           AS permission,
         (SELECT COUNT(*) FROM role_permissions
           WHERE permission_id = 'perm_signups_manage' AND role = 'admin')
           AS admin_grant`,
    ),
  );
  const counts = shape.at(-1).results[0];
  assert(counts.tables === 5, `expected 5 signup tables, got ${counts.tables}`);
  assert(counts.triggers === 2, `expected 2 capacity triggers, got ${counts.triggers}`);
  assert(counts.permission === 1, "signups.manage permission missing");
  assert(counts.admin_grant === 1, "admin role grant missing");

  // Seed one event, one form, one slot needing 2.
  await execute(
    `INSERT INTO calendar_events (
       id, revision, slug, publication_state, event_status, category, title,
       summary, description, starts_at, ends_at, timezone, audience,
       created_at, updated_at, published_at
     ) VALUES (
       'evt-1', 0, 'lego-derby', 'published', 'scheduled', 'pack', 'Lego Derby',
       'Race day', 'Race day details', '2027-03-01T18:00:00.000Z', NULL,
       'America/New_York', 'All families', 1, 1, 1
     );
     INSERT INTO signup_forms (
       id, revision, slug, event_id, form_type, title, instructions, state,
       closes_at, created_at, updated_at
     ) VALUES (
       'frm-1', 0, 'lego-derby-food', 'evt-1', 'items', 'Food', '', 'open',
       NULL, 1, 1
     );
     INSERT INTO signup_slots (
       id, form_id, position, label, quantity_needed, notes,
       created_at, updated_at
     ) VALUES ('slt-1', 'frm-1', 0, 'Hot dog buns', 2, NULL, 1, 1);
     INSERT INTO signup_responses (
       id, form_id, email, family_name, attending, adults, children,
       dietary_notes, status, confirmed_at, token_hash, ip_hash,
       created_at, updated_at
     ) VALUES
       ('rsp-1', 'frm-1', 'a@example.com', 'Alpha', 1, 2, 1, NULL,
        'unconfirmed', NULL, 'hash-a', NULL, 1, 1),
       ('rsp-2', 'frm-1', 'b@example.com', 'Beta', 1, 2, 0, NULL,
        'unconfirmed', NULL, 'hash-b', NULL, 1, 1);`,
  );

  // Claiming the full quantity succeeds.
  await execute(
    `INSERT INTO signup_claims (id, response_id, slot_id, quantity, created_at)
     VALUES ('clm-1', 'rsp-1', 'slt-1', 2, 1);`,
  );

  // Over-subscribing the same slot must abort.
  let aborted = false;
  try {
    await execute(
      `INSERT INTO signup_claims (id, response_id, slot_id, quantity, created_at)
       VALUES ('clm-2', 'rsp-2', 'slt-1', 1, 1);`,
    );
  } catch (error) {
    aborted = /signup slot is full/.test(String(error));
  }
  assert(aborted, "capacity trigger did not abort an oversubscribed claim");

  // Deleting a response releases its claims through the cascade.
  await execute(`DELETE FROM signup_responses WHERE id = 'rsp-1';`);
  const after = JSON.parse(
    await execute(
      `SELECT COALESCE(SUM(quantity), 0) AS claimed FROM signup_claims
       WHERE slot_id = 'slt-1'`,
    ),
  );
  assert(
    after.at(-1).results[0].claimed === 0,
    "claims did not cascade when the response was deleted",
  );

  console.log("signup migration contract OK");
} finally {
  await rm(persistTo, { recursive: true, force: true });
}
