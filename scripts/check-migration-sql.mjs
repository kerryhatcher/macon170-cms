// Guards the one migration bug local testing cannot catch.
//
// `wrangler d1 migrations apply --remote` sends the whole migration file to the D1 HTTP /query
// endpoint as a single `sql` string (see executeRemotely in wrangler: the --command path never
// calls wrangler's own splitSqlQuery). D1 then splits the statements server-side, and that
// splitter closes a `CREATE TRIGGER ... BEGIN` at the first `END;` it sees — it does not know
// that `CASE ... END` nests. A trigger body containing a CASE therefore gets cut in half and the
// trailing `END;` arrives on its own as an incomplete statement:
//
//   incomplete input: SQLITE_ERROR [code: 7500]
//
// `--local` does not use that API, and wrangler's client-side splitter does understand CASE
// (/\s(BEGIN|CASE)\s$/i), so the migration contract tests pass against a real local D1 while the
// production deploy fails. This check is the only thing standing in for that gap.
//
// Write the guard as a plain `SELECT RAISE(ABORT, '...') WHERE <condition>;` instead — one
// statement, one END, and identical behaviour: a false condition yields zero rows so RAISE is
// never evaluated. That is the shape 0001_calendar.sql and 0002_contact_form.sql already use.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MIGRATIONS_DIR = "migrations/custom";

// Strips comments and quoted strings so a CASE or END mentioned in either is never matched.
function stripNoise(sql) {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'(?:[^']|'')*'/g, "''");
}

// Returns the body of each CREATE TRIGGER: the text following the trigger's BEGIN, up to the next
// top-level CREATE or the end of the file. Coarse on purpose — it only has to be wide enough to
// catch a CASE that belongs to a trigger.
function triggerBodies(sql) {
  const bodies = [];
  const pattern = /\bCREATE\s+TRIGGER\b[\s\S]*?\bBEGIN\b/gi;
  let match;
  while ((match = pattern.exec(sql)) !== null) {
    const rest = sql.slice(match.index + match[0].length);
    const next = rest.search(/\bCREATE\s+(TABLE|TRIGGER|INDEX|VIEW)\b/i);
    bodies.push(next === -1 ? rest : rest.slice(0, next));
  }
  return bodies;
}

const failures = [];

for (const name of (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort()) {
  const sql = stripNoise(await readFile(join(MIGRATIONS_DIR, name), "utf8"));

  for (const body of triggerBodies(sql)) {
    if (/\bCASE\b/i.test(body)) {
      failures.push(
        `${name}: a CREATE TRIGGER body contains CASE. D1's remote /query splitter ends the ` +
          `trigger at the CASE's "END;", so this file fails to apply with "incomplete input" ` +
          `even though it applies cleanly to a local D1. Rewrite it as ` +
          `SELECT RAISE(ABORT, '...') WHERE <condition>;`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("migration SQL check FAILED\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("migration SQL check OK");
