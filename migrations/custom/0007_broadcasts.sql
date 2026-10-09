CREATE TABLE IF NOT EXISTS broadcast_lists (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS broadcast_contacts (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL DEFAULT '',
 tag TEXT NOT NULL DEFAULT '' CHECK(tag IN ('','bounced','unsubscribed','complaint','suppressed')),
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS broadcast_memberships (
 contact_id TEXT NOT NULL REFERENCES broadcast_contacts(id),
 list_id TEXT NOT NULL REFERENCES broadcast_lists(id),
 state TEXT NOT NULL CHECK(state IN ('active','unsubscribed')),
 PRIMARY KEY(contact_id,list_id)
);
CREATE INDEX IF NOT EXISTS broadcast_memberships_list ON broadcast_memberships(list_id,state);
CREATE TABLE IF NOT EXISTS broadcasts (
 id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES broadcast_lists(id),
 subject TEXT NOT NULL, body TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','queued','complete')),
 created_at INTEGER NOT NULL, sent_at INTEGER, actor_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS broadcast_recipients (
 id TEXT PRIMARY KEY, broadcast_id TEXT NOT NULL REFERENCES broadcasts(id),
 contact_id TEXT NOT NULL REFERENCES broadcast_contacts(id), email TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','unknown','skipped')),
 message_id TEXT UNIQUE, attempted_at INTEGER,
 delivered INTEGER NOT NULL DEFAULT 0, opened INTEGER NOT NULL DEFAULT 0,
 clicked INTEGER NOT NULL DEFAULT 0, bounced INTEGER NOT NULL DEFAULT 0,
 UNIQUE(broadcast_id,contact_id)
);
CREATE INDEX IF NOT EXISTS broadcast_recipients_pending ON broadcast_recipients(state,broadcast_id);
CREATE INDEX IF NOT EXISTS broadcast_recipients_contact ON broadcast_recipients(contact_id,bounced);
-- A distinct bounced recipient/message counts once, even when Postmark retries.
CREATE TRIGGER IF NOT EXISTS broadcast_bounce_suppression AFTER UPDATE OF bounced ON broadcast_recipients
WHEN NEW.bounced = 1
BEGIN
 UPDATE broadcast_contacts SET tag = 'bounced' WHERE id = NEW.contact_id
 AND (SELECT COUNT(*) FROM broadcast_recipients WHERE contact_id = NEW.contact_id AND bounced = 1) > 1;
 UPDATE broadcast_memberships SET state = 'unsubscribed' WHERE contact_id = NEW.contact_id
 AND EXISTS(SELECT 1 FROM broadcast_contacts WHERE id = NEW.contact_id AND tag = 'bounced');
END;
INSERT OR IGNORE INTO permissions(id,name,description,category,created_at)
VALUES('perm_broadcasts_manage','broadcasts.manage','Manage email contacts, lists and broadcasts','content',unixepoch()*1000);
INSERT OR IGNORE INTO role_permissions(id,role,permission_id,created_at)
VALUES('role_perm_admin_broadcasts_manage','admin','perm_broadcasts_manage',unixepoch()*1000);

CREATE TABLE IF NOT EXISTS broadcast_confirmations (
 id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES broadcast_contacts(id),
 list_id TEXT NOT NULL REFERENCES broadcast_lists(id), expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS broadcast_confirmations_expiry ON broadcast_confirmations(expires_at);
