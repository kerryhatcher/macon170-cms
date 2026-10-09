-- Empty HTML preserves existing plain-text drafts and sent messages.
ALTER TABLE broadcasts ADD COLUMN body_html TEXT NOT NULL DEFAULT '';
