-- migration: no-transaction
-- migration: code 0078_draft_review_convert.ts sha256:3ef3958b44d9e2e2e2f550a207201f7789ff1dc1d103a42329a71fe38be0a02b
-- The runner commits one draft at a time before checking this barrier and recording completion.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM document_drafts
    WHERE kind = 'work_draft' AND status = 'active' AND live_cut IS NOT NULL) THEN
    RAISE EXCEPTION 'Draft review conversion is incomplete; retry db:migrate before starting servers.';
  END IF;
END $$;
