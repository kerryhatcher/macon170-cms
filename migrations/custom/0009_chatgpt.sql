-- OAuth grants and opaque credentials for the Pack 170 ChatGPT plugin.
-- 0008 is reserved for the concurrent broadcast HTML change.
CREATE TABLE IF NOT EXISTS mcp_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_grants_user ON mcp_grants(user_id);
CREATE TABLE IF NOT EXISTS mcp_codes (
  hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  used_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_tokens (
  hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
  used_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_tokens_grant ON mcp_tokens(grant_id);
CREATE TABLE IF NOT EXISTS mcp_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  success INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_audit_created ON mcp_audit(created_at);
