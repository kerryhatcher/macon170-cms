CREATE TABLE inbound_emails (
 id TEXT PRIMARY KEY, sender TEXT NOT NULL COLLATE NOCASE,
 sender_name TEXT NOT NULL, recipient TEXT NOT NULL COLLATE NOCASE,
 subject TEXT NOT NULL, sent_at TEXT NOT NULL, received_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed','archived','spam')),
 attachment_count INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX inbound_received ON inbound_emails(received_at DESC,id);
CREATE INDEX inbound_sender ON inbound_emails(sender,received_at DESC);
CREATE INDEX inbound_status ON inbound_emails(status,received_at DESC);
CREATE INDEX inbound_recipient ON inbound_emails(recipient,received_at DESC);
CREATE TABLE inbound_audit (
 id TEXT PRIMARY KEY, email_id TEXT NOT NULL REFERENCES inbound_emails(id),
 actor_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO permissions(id,name,description,category,created_at)
VALUES('perm_inbox_manage','inbox.manage','Review private inbound emails and contact history','content',unixepoch()*1000);
INSERT OR IGNORE INTO role_permissions(id,role,permission_id,created_at)
VALUES('role_perm_admin_inbox_manage','admin','perm_inbox_manage',unixepoch()*1000);
