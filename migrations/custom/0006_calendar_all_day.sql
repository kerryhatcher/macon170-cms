-- Existing events stay timed until a volunteer marks them all-day.
ALTER TABLE calendar_events ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0
  CHECK (all_day IN (0, 1));
