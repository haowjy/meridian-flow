-- Pre-canonical change details cannot be folded safely because their display
-- hashes are presentation values. There is no production data to preserve, so
-- reset the aggregate instead of carrying a dual-key compatibility path.
TRUNCATE TABLE "change_trail_shells" CASCADE;
