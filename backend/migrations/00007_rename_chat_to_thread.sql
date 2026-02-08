-- +goose Up
-- +goose ENVSUB ON

-- Rename chats table to threads
ALTER TABLE ${TABLE_PREFIX}chats RENAME TO ${TABLE_PREFIX}threads;

-- Rename column in turns table from chat_id to thread_id
ALTER TABLE ${TABLE_PREFIX}turns RENAME COLUMN chat_id TO thread_id;

-- Rename indexes
ALTER INDEX idx_${TABLE_PREFIX}chats_project RENAME TO idx_${TABLE_PREFIX}threads_project;
ALTER INDEX idx_${TABLE_PREFIX}chats_user RENAME TO idx_${TABLE_PREFIX}threads_user;
ALTER INDEX idx_${TABLE_PREFIX}chats_last_viewed RENAME TO idx_${TABLE_PREFIX}threads_last_viewed;
ALTER INDEX idx_${TABLE_PREFIX}chats_deleted RENAME TO idx_${TABLE_PREFIX}threads_deleted;
ALTER INDEX idx_${TABLE_PREFIX}turns_chat RENAME TO idx_${TABLE_PREFIX}turns_thread;

-- Rename trigger (drop old, create new pointing to shared function)
DROP TRIGGER IF EXISTS update_chats_updated_at ON ${TABLE_PREFIX}threads;
CREATE TRIGGER update_threads_updated_at
    BEFORE UPDATE ON ${TABLE_PREFIX}threads
    FOR EACH ROW EXECUTE FUNCTION ${TABLE_PREFIX}update_updated_at_column();

-- Update table comment
COMMENT ON TABLE ${TABLE_PREFIX}threads IS 'Thread sessions within projects';

-- +goose Down
-- Reverse all changes for rollback

-- Drop trigger first (while table is still named threads)
DROP TRIGGER IF EXISTS update_threads_updated_at ON ${TABLE_PREFIX}threads;

-- Rename table back
ALTER TABLE ${TABLE_PREFIX}threads RENAME TO ${TABLE_PREFIX}chats;

-- Recreate trigger with old name (now that table is named chats)
CREATE TRIGGER update_chats_updated_at
    BEFORE UPDATE ON ${TABLE_PREFIX}chats
    FOR EACH ROW EXECUTE FUNCTION ${TABLE_PREFIX}update_updated_at_column();

-- Rename indexes back
ALTER INDEX idx_${TABLE_PREFIX}threads_project RENAME TO idx_${TABLE_PREFIX}chats_project;
ALTER INDEX idx_${TABLE_PREFIX}threads_user RENAME TO idx_${TABLE_PREFIX}chats_user;
ALTER INDEX idx_${TABLE_PREFIX}threads_last_viewed RENAME TO idx_${TABLE_PREFIX}chats_last_viewed;
ALTER INDEX idx_${TABLE_PREFIX}threads_deleted RENAME TO idx_${TABLE_PREFIX}chats_deleted;
ALTER INDEX idx_${TABLE_PREFIX}turns_thread RENAME TO idx_${TABLE_PREFIX}turns_chat;

-- Rename column back in turns table
ALTER TABLE ${TABLE_PREFIX}turns RENAME COLUMN thread_id TO chat_id;

-- Update table comment back
COMMENT ON TABLE ${TABLE_PREFIX}chats IS 'Chat sessions within projects';
