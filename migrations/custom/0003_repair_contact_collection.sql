-- Production databases that applied the original contact migration before its
-- form-backed collection was added need this immutable follow-up. The content
-- row for every parent submission references this collection, so do not make
-- the public form available without it.
INSERT OR IGNORE INTO collections (
  id,
  name,
  display_name,
  description,
  schema,
  is_active,
  managed,
  source_type,
  source_id,
  created_at,
  updated_at
) VALUES (
  'collection-form-contact',
  'form_contact',
  'Pack 170 parent contact submissions (Form)',
  'Private form-backed records for Pack 170 parent and guardian inquiries.',
  '{"type":"object","properties":{"title":{"type":"string","title":"Title","required":true},"parentName":{"type":"string","title":"Parent or guardian name","required":true},"email":{"type":"string","format":"email","title":"Your email","required":true},"phone":{"type":"string","title":"Parent phone (optional)"},"childGrade":{"type":"select","title":"Child grade (optional, no child name)","enum":["","Kindergarten","1st grade","2nd grade","3rd grade","4th grade","5th grade"],"enumLabels":["Choose a grade","Kindergarten","1st grade","2nd grade","3rd grade","4th grade","5th grade"]},"topic":{"type":"select","title":"What can we help with?","required":true,"enum":["Planning a first visit","Calendar or event detail","Finding my child’s den","Volunteering","Website or privacy question","Something else"],"enumLabels":["Planning a first visit","Calendar or event detail","Finding my child’s den","Volunteering","Website or privacy question","Something else"]},"message":{"type":"string","title":"Your question","required":true},"website":{"type":"string","title":"Leave this blank"}},"required":["title","parentName","email","topic","message"]}',
  1,
  1,
  'form',
  'default-contact-form',
  unixepoch() * 1000,
  unixepoch() * 1000
);
