-- Optional Stripe (or other https) payment link volunteers attach to an event.
ALTER TABLE calendar_events ADD COLUMN payment_url TEXT;
