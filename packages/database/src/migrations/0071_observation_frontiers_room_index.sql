-- migration: no-transaction
-- The latest-frontier lookup reads a room's rows newest first; built online, re-runnable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "observation_frontiers_room_latest" ON "observation_frontiers" USING btree ("room_key","recorded_seq" DESC NULLS LAST);
