-- CMS-owned Pack 170 event signup forms: attendance intent and item claims.
CREATE TABLE IF NOT EXISTS signup_forms (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  slug TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL REFERENCES calendar_events(id),
  form_type TEXT NOT NULL CHECK (form_type IN ('rsvp', 'items')),
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'open', 'closed')),
  closes_at TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signup_forms_event
  ON signup_forms(event_id);
CREATE INDEX IF NOT EXISTS idx_signup_forms_state
  ON signup_forms(state, slug);

CREATE TABLE IF NOT EXISTS signup_slots (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES signup_forms(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  label TEXT NOT NULL,
  quantity_needed INTEGER NOT NULL CHECK (quantity_needed >= 1),
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signup_slots_form
  ON signup_slots(form_id, position);

CREATE TABLE IF NOT EXISTS signup_responses (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES signup_forms(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  family_name TEXT NOT NULL,
  attending INTEGER NOT NULL DEFAULT 1 CHECK (attending IN (0, 1)),
  adults INTEGER NOT NULL DEFAULT 0 CHECK (adults >= 0 AND adults <= 20),
  children INTEGER NOT NULL DEFAULT 0 CHECK (children >= 0 AND children <= 20),
  dietary_notes TEXT,
  status TEXT NOT NULL DEFAULT 'unconfirmed'
    CHECK (status IN ('unconfirmed', 'confirmed')),
  confirmed_at INTEGER,
  token_hash TEXT NOT NULL UNIQUE,
  ip_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(form_id, email),
  CHECK (status != 'confirmed' OR confirmed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_signup_responses_form
  ON signup_responses(form_id, created_at);
CREATE INDEX IF NOT EXISTS idx_signup_responses_unconfirmed
  ON signup_responses(status, created_at);

CREATE TABLE IF NOT EXISTS signup_claims (
  id TEXT PRIMARY KEY,
  response_id TEXT NOT NULL REFERENCES signup_responses(id) ON DELETE CASCADE,
  slot_id TEXT NOT NULL REFERENCES signup_slots(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  created_at INTEGER NOT NULL,
  UNIQUE(response_id, slot_id)
);

CREATE INDEX IF NOT EXISTS idx_signup_claims_slot
  ON signup_claims(slot_id);
CREATE INDEX IF NOT EXISTS idx_signup_claims_response
  ON signup_claims(response_id);

-- Capacity is enforced in the schema so every write path is protected and an
-- oversubscribed claim aborts the enclosing D1 batch transaction.
--
-- The guard is a bare `SELECT RAISE(...) WHERE <condition>` rather than the more obvious
-- `SELECT CASE WHEN <condition> THEN RAISE(...) END`. Both abort identically — a false condition
-- yields zero rows, so RAISE is never evaluated — but a `CASE ... END` inside a trigger body
-- cannot be applied to a remote D1. `wrangler d1 migrations apply --remote` posts the whole file
-- to the D1 /query API as one string, and that server-side splitter ends the trigger at the
-- CASE's `END;`, leaving the trigger's own `END;` as an incomplete statement
-- (`incomplete input: SQLITE_ERROR [code: 7500]`). A local D1 applies the CASE form fine, so the
-- migration contract test cannot catch it; scripts/check-migration-sql.mjs is what does.
CREATE TRIGGER IF NOT EXISTS signup_claims_capacity_insert
BEFORE INSERT ON signup_claims
BEGIN
  SELECT RAISE(ABORT, 'signup slot is full')
  WHERE (
    SELECT COALESCE(SUM(quantity), 0) FROM signup_claims
    WHERE slot_id = NEW.slot_id
  ) + NEW.quantity > (
    SELECT quantity_needed FROM signup_slots WHERE id = NEW.slot_id
  );
END;

CREATE TRIGGER IF NOT EXISTS signup_claims_capacity_update
BEFORE UPDATE ON signup_claims
BEGIN
  SELECT RAISE(ABORT, 'signup slot is full')
  WHERE (
    SELECT COALESCE(SUM(quantity), 0) FROM signup_claims
    WHERE slot_id = NEW.slot_id AND id != NEW.id
  ) + NEW.quantity > (
    SELECT quantity_needed FROM signup_slots WHERE id = NEW.slot_id
  );
END;

CREATE TABLE IF NOT EXISTS signup_audit (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('form', 'response')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signup_audit_entity
  ON signup_audit(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_signup_audit_created
  ON signup_audit(created_at);

INSERT OR IGNORE INTO permissions
  (id, name, description, category, created_at)
VALUES
  (
    'perm_signups_manage',
    'signups.manage',
    'Create and manage Pack event signup forms and their responses',
    'content',
    unixepoch() * 1000
  );

INSERT OR IGNORE INTO role_permissions
  (id, role, permission_id, created_at)
VALUES
  (
    'role_perm_admin_signups_manage',
    'admin',
    'perm_signups_manage',
    unixepoch() * 1000
  );
