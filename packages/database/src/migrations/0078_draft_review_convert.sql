-- migration: no-transaction
-- migration: code 0078_draft_review_convert.ts sha256:60cf5f51c70ac6833920a94f9d2e9cd0ecf582a27c6f37fef9395ce7a0cf9c25
-- The runner commits one draft at a time before checking this barrier and recording completion.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM document_drafts
    WHERE kind = 'work_draft' AND status = 'active' AND live_cut IS NOT NULL) THEN
    RAISE EXCEPTION 'Draft review conversion is incomplete; retry db:migrate before starting servers.';
  END IF;
END $$;
