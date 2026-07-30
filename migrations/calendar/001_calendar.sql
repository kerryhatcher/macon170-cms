-- CMS-owned Pack 170 calendar and immutable revision history.
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  slug TEXT NOT NULL UNIQUE,
  publication_state TEXT NOT NULL DEFAULT 'draft'
    CHECK (publication_state IN ('draft', 'published', 'archived')),
  event_status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (event_status IN ('scheduled', 'tentative', 'cancelled')),
  category TEXT NOT NULL CHECK (category IN ('pack', 'den', 'family')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/New_York'
    CHECK (timezone = 'America/New_York'),
  location_name TEXT,
  address TEXT,
  audience TEXT NOT NULL,
  what_to_bring TEXT,
  cost TEXT,
  registration_url TEXT,
  milestone TEXT
    CHECK (
      milestone IS NULL
      OR milestone IN ('lego-derby', 'fall-camp', 'pinewood-derby', 'blue-gold')
    ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  CHECK (publication_state != 'published' OR published_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_public
  ON calendar_events(publication_state, starts_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_updated
  ON calendar_events(updated_at);

CREATE TABLE IF NOT EXISTS calendar_event_history (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES calendar_events(id),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  action TEXT NOT NULL
    CHECK (action IN ('created', 'updated', 'published', 'archived')),
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  actor_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE(event_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_calendar_event_history_event
  ON calendar_event_history(event_id, revision);

CREATE TRIGGER IF NOT EXISTS calendar_history_no_update
BEFORE UPDATE ON calendar_event_history
BEGIN
  SELECT RAISE(ABORT, 'calendar history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS calendar_history_no_delete
BEFORE DELETE ON calendar_event_history
BEGIN
  SELECT RAISE(ABORT, 'calendar history is immutable');
END;

INSERT OR IGNORE INTO permissions
  (id, name, description, category, created_at)
VALUES
  (
    'perm_calendar_manage',
    'calendar.manage',
    'Create, update, publish, and archive Pack calendar events',
    'content',
    unixepoch() * 1000
  );

INSERT OR IGNORE INTO role_permissions
  (id, role, permission_id, created_at)
VALUES
  (
    'role_perm_admin_calendar_manage',
    'admin',
    'perm_calendar_manage',
    unixepoch() * 1000
  );

CREATE TABLE IF NOT EXISTS user_permissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_user_permissions_user
  ON user_permissions(user_id);
