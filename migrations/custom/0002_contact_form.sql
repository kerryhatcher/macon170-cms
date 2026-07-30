-- CMS-owned Pack 170 parent contact form, private review audit, and retention fields.
-- The SonicJS core migration already creates this form ID; update it in place so
-- the CMS never has two competing contact forms.
UPDATE forms
SET
  display_name = 'Pack 170 parent contact form',
  description = 'Parent and guardian questions routed to authorized Pack 170 adult volunteers.',
  category = 'contact',
  formio_schema = json_object(
    'display', 'form',
    'components', json_array(
      json_object(
        'type', 'textfield',
        'key', 'parentName',
        'label', 'Parent or guardian name',
        'input', json('true'),
        'validate', json_object('required', json('true'), 'minLength', 2, 'maxLength', 120)
      ),
      json_object(
        'type', 'email',
        'key', 'email',
        'label', 'Your email',
        'input', json('true'),
        'validate', json_object('required', json('true'), 'minLength', 5, 'maxLength', 254)
      ),
      json_object(
        'type', 'phoneNumber',
        'key', 'phone',
        'label', 'Parent phone (optional)',
        'input', json('true'),
        'validate', json_object('required', json('false'), 'maxLength', 40)
      ),
      json_object(
        'type', 'select',
        'key', 'childGrade',
        'label', 'Child grade (optional, no child name)',
        'input', json('true'),
        'data', json_object(
          'values', json_array(
            json_object('label', 'Choose a grade', 'value', ''),
            json_object('label', 'Kindergarten', 'value', 'Kindergarten'),
            json_object('label', '1st grade', 'value', '1st grade'),
            json_object('label', '2nd grade', 'value', '2nd grade'),
            json_object('label', '3rd grade', 'value', '3rd grade'),
            json_object('label', '4th grade', 'value', '4th grade'),
            json_object('label', '5th grade', 'value', '5th grade')
          )
        ),
        'validate', json_object('required', json('false'))
      ),
      json_object(
        'type', 'select',
        'key', 'topic',
        'label', 'What can we help with?',
        'input', json('true'),
        'data', json_object(
          'values', json_array(
            json_object('label', 'Planning a first visit', 'value', 'Planning a first visit'),
            json_object('label', 'Calendar or event detail', 'value', 'Calendar or event detail'),
            json_object('label', 'Finding my child’s den', 'value', 'Finding my child’s den'),
            json_object('label', 'Volunteering', 'value', 'Volunteering'),
            json_object('label', 'Website or privacy question', 'value', 'Website or privacy question'),
            json_object('label', 'Something else', 'value', 'Something else')
          )
        ),
        'validate', json_object('required', json('true'))
      ),
      json_object(
        'type', 'textarea',
        'key', 'message',
        'label', 'Your question',
        'description', 'Please do not send a child’s full name, school, address, medical information, or other sensitive details.',
        'rows', 6,
        'input', json('true'),
        'validate', json_object('required', json('true'), 'minLength', 10, 'maxLength', 4000)
      ),
      json_object(
        'type', 'hidden',
        'key', 'website',
        'label', 'Leave this blank',
        'input', json('true'),
        'persistent', json('false')
      ),
      json_object(
        'type', 'button',
        'key', 'submit',
        'label', 'Send securely to pack adults',
        'action', 'submit',
        'theme', 'primary'
      )
    )
  ),
  settings = json_object(
    'version', 'pack-contact-v1',
    'emailNotifications', json('false'),
    'successMessage', 'Your note is in the volunteer queue.',
    'redirectUrl', 'https://www.macon170.com/contact/?submitted=success#contact-form',
    'allowAnonymous', json('true'),
    'requireAuth', json('false'),
    'submitButtonText', 'Send securely to pack adults',
    'saveProgress', json('false')
  ),
  is_active = 1,
  is_public = 1,
  managed = 1,
  turnstile_enabled = 0,
  turnstile_settings = json_object('inherit', json('false')),
  updated_at = unixepoch() * 1000
WHERE id = 'default-contact-form' AND name = 'contact';

-- The custom endpoint verifies the Worker-secret-backed Turnstile token.
-- Keep SonicJS's database-configured plugin inactive and scrub any keys so a
-- CMS settings change cannot leave the verification secret in D1.
INSERT OR IGNORE INTO plugins (
  id, name, display_name, description, version, author, category, icon,
  status, is_core, settings, permissions, dependencies, installed_at, last_updated
) VALUES (
  'turnstile',
  'turnstile',
  'Cloudflare Turnstile',
  'Disabled for the Pack contact form; verification uses a Worker secret.',
  '1.0.0',
  'SonicJS',
  'security',
  'shield-check',
  'inactive',
  1,
  '{"siteKey":"","secretKey":"","theme":"auto","size":"normal","mode":"managed","appearance":"always","preClearanceEnabled":false,"preClearanceLevel":"managed","enabled":false}',
  '["settings:write","admin:access"]',
  '[]',
  unixepoch(),
  unixepoch()
);

UPDATE plugins
SET
  status = 'inactive',
  settings = '{"siteKey":"","secretKey":"","theme":"auto","size":"normal","mode":"managed","appearance":"always","preClearanceEnabled":false,"preClearanceLevel":"managed","enabled":false}',
  activated_at = NULL,
  error_message = NULL,
  last_updated = unixepoch(),
  updated_at = unixepoch()
WHERE id = 'turnstile' OR name = 'turnstile';

ALTER TABLE form_submissions ADD COLUMN source_path TEXT;
ALTER TABLE form_submissions ADD COLUMN country_code TEXT;
ALTER TABLE form_submissions ADD COLUMN last_viewed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_form_submissions_contact_queue
  ON form_submissions(form_id, status, submitted_at DESC);

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

CREATE TABLE IF NOT EXISTS contact_submission_audit (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES form_submissions(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('viewed', 'status_changed')),
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_submission_audit_submission
  ON contact_submission_audit(submission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_contact_submission_audit_created
  ON contact_submission_audit(created_at);

-- Keep retention set-based: deleting a contact submission also removes its
-- private form-backed content record after the foreign key is released.
CREATE TRIGGER IF NOT EXISTS delete_contact_submission_content
AFTER DELETE ON form_submissions
WHEN
  OLD.form_id = 'default-contact-form'
  AND OLD.content_id IS NOT NULL
BEGIN
  DELETE FROM content WHERE id = OLD.content_id;
END;

UPDATE forms
SET submission_count = (
  SELECT COUNT(*) FROM form_submissions
  WHERE form_id = 'default-contact-form'
)
WHERE id = 'default-contact-form';
