-- Older create Undo rows did not record which retained draft they closed. Backfill only when
-- the lifecycle interval identifies exactly one closed work draft; ambiguous rows remain without
-- provenance and are treated as gone rather than restored from a guess.
WITH inverse_rows AS (
  SELECT e.id, e.document_id,
         (e.tree_change->'destination'->>'branchId')::uuid AS branch_id,
         e.created_at
  FROM document_edits e
  WHERE e.kind = 'undo'
    AND e.tree_change->>'op' = 'delete'
    AND e.tree_change->'destination'->>'kind' = 'draft'
    AND NOT (e.tree_change ? 'retiredDraftId')
), candidates AS (
  SELECT inverse.id AS edit_id, min(d.id) AS draft_id
  FROM inverse_rows inverse
  JOIN document_drafts d
    ON d.document_id = inverse.document_id
   AND d.branch_id = inverse.branch_id
   AND d.kind = 'work_draft'
   AND d.status = 'closed'
   AND d.created_at <= inverse.created_at
  LEFT JOIN document_drafts successor ON successor.id = d.successor_draft_id
  WHERE successor.id IS NULL OR successor.created_at > inverse.created_at
  GROUP BY inverse.id
  HAVING count(*) = 1
)
UPDATE document_edits e
SET tree_change = jsonb_set(e.tree_change, '{retiredDraftId}', to_jsonb(candidates.draft_id))
FROM candidates
WHERE e.id = candidates.edit_id;
