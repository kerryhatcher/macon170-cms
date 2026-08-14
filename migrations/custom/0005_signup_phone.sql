-- Private contact number for event signup responses. Nullable so responses
-- created before phone collection was introduced remain editable and retained.
ALTER TABLE signup_responses ADD COLUMN phone TEXT;
