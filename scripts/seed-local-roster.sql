-- Local development data only. This never runs against the production D1 database.
INSERT INTO content (id, collection_id, slug, title, data, status, published_at, author_id, created_at, updated_at)
VALUES
  ('local-roster-cubmaster', (SELECT id FROM collections WHERE name = 'leadership-roster'), 'cubmaster', 'Cubmaster', '{"title":"Cubmaster","name":"Kerry Hatcher","section":"pack-leadership","sortOrder":10}', 'published', unixepoch() * 1000, 'system-form-submission', unixepoch() * 1000, unixepoch() * 1000),
  ('local-roster-committee-chair', (SELECT id FROM collections WHERE name = 'leadership-roster'), 'committee-chair', 'Committee Chair', '{"title":"Committee Chair","name":"Will Roche","section":"pack-leadership","sortOrder":20}', 'published', unixepoch() * 1000, 'system-form-submission', unixepoch() * 1000, unixepoch() * 1000),
  ('local-roster-chartered-org-representative', (SELECT id FROM collections WHERE name = 'leadership-roster'), 'chartered-organization-representative', 'Chartered Organization Representative', '{"title":"Chartered Organization Representative","name":"Rev. Caitlin Childers Brown","section":"pack-leadership","sortOrder":30}', 'published', unixepoch() * 1000, 'system-form-submission', unixepoch() * 1000, unixepoch() * 1000),
  ('local-roster-lion-den-leader', (SELECT id FROM collections WHERE name = 'leadership-roster'), 'lion-den-leader-k', 'Lion Den Leader (K)', '{"title":"Lion Den Leader (K)","name":"Rev. Caitlin Childers Brown","section":"den-leaders","sortOrder":10}', 'published', unixepoch() * 1000, 'system-form-submission', unixepoch() * 1000, unixepoch() * 1000),
  ('local-roster-tiger-den-leader', (SELECT id FROM collections WHERE name = 'leadership-roster'), 'tiger-den-leader-1st', 'Tiger Den Leader (1st)', '{"title":"Tiger Den Leader (1st)","name":"","section":"den-leaders","sortOrder":20}', 'published', unixepoch() * 1000, 'system-form-submission', unixepoch() * 1000, unixepoch() * 1000),
  ('local-roster-wolf-den-leader', (SELECT id FROM collections WHERE name = 'leadership-roster'), 'wolf-den-leader-2nd', 'Wolf Den Leader (2nd)', '{"title":"Wolf Den Leader (2nd)","name":"","section":"den-leaders","sortOrder":30}', 'published', unixepoch() * 1000, 'system-form-submission', unixepoch() * 1000, unixepoch() * 1000),
  ('local-roster-bear-den-leader', (SELECT id FROM collections WHERE name = 'leadership-roster'), 'bear-den-leader-3rd', 'Bear Den Leader (3rd)', '{"title":"Bear Den Leader (3rd)","name":"","section":"den-leaders","sortOrder":40}', 'published', unixepoch() * 1000, 'system-form-submission', unixepoch() * 1000, unixepoch() * 1000),
  ('local-roster-webelos-den-leader', (SELECT id FROM collections WHERE name = 'leadership-roster'), 'webelos-den-leader-4th', 'Webelos Den Leader (4th)', '{"title":"Webelos Den Leader (4th)","name":"Stephanie Hatcher","section":"den-leaders","sortOrder":50}', 'published', unixepoch() * 1000, 'system-form-submission', unixepoch() * 1000, unixepoch() * 1000),
  ('local-roster-arrow-of-light-den-leader', (SELECT id FROM collections WHERE name = 'leadership-roster'), 'arrow-of-light-den-leader-5th', 'Arrow of Light Den Leader (5th)', '{"title":"Arrow of Light Den Leader (5th)","name":"","section":"den-leaders","sortOrder":60}', 'published', unixepoch() * 1000, 'system-form-submission', unixepoch() * 1000, unixepoch() * 1000)
ON CONFLICT(id) DO UPDATE SET
  collection_id = excluded.collection_id,
  slug = excluded.slug,
  title = excluded.title,
  data = excluded.data,
  status = excluded.status,
  published_at = excluded.published_at,
  updated_at = excluded.updated_at;
