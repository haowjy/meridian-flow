-- Stop the old release before cutover. Its projection repairs NULL cuts and its
-- DRAIN_APPLY_SETTLEMENT=1 worker completes or withdraws accepted Apply commands.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM document_drafts
    WHERE kind = 'work_draft' AND status = 'active' AND live_cut IS NULL) THEN
    RAISE EXCEPTION 'Draft review cutover refused: active Work drafts have NULL live_cut. Run the previous release projection to repair them before retrying db:migrate.';
  END IF;
  IF EXISTS (SELECT 1 FROM branch_push_settlement_batches WHERE state NOT IN ('completed', 'abandoned'))
    OR EXISTS (SELECT 1 FROM branch_push_settlement_outbox o
      JOIN branch_push_settlement_batches b ON b.id = o.batch_id
      WHERE b.state NOT IN ('completed', 'abandoned'))
    OR EXISTS (SELECT 1 FROM branch_push_outbox_updates u
      JOIN branch_push_settlement_outbox o ON o.push_id = u.push_id
      JOIN branch_push_settlement_batches b ON b.id = o.batch_id
      WHERE b.state NOT IN ('completed', 'abandoned')) THEN
    RAISE EXCEPTION 'Draft review cutover refused: unfinished Apply settlement. Run the previous release with DRAIN_APPLY_SETTLEMENT=1 until all batches complete or are withdrawn and every outbox/member belongs to a terminal batch, then stop it and retry db:migrate.';
  END IF;
  IF EXISTS (SELECT 1 FROM draft_write_journal j JOIN document_drafts d ON d.id = j.draft_id
    WHERE j.generation <> d.generation AND j.id > d.checkpoint_seq) THEN
    RAISE EXCEPTION 'Draft review cutover refused: an older-generation journal row is above its checkpoint. Repair the checkpoint using the previous release before retrying db:migrate.';
  END IF;
END $$;
