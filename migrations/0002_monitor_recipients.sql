-- Per-monitor alert recipients. NULL = use the default recipients from Settings.
ALTER TABLE monitors ADD COLUMN email_to TEXT;   -- comma separated email addresses
ALTER TABLE monitors ADD COLUMN wasend_to TEXT;  -- comma separated E.164 WhatsApp numbers
