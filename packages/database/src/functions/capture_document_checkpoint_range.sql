-- Capture only generation-qualified checkpoint and journal references. The
-- exception block releases its own mutation lock without rolling back sibling
-- statements or retaining capture-acquired locks in an ambient transaction.
CREATE OR REPLACE FUNCTION capture_document_checkpoint_range(
  p_document_id text,
  p_authority_id uuid,
  p_generation bigint
)
RETURNS TABLE (base_id bigint, floor_seq bigint, ceiling_seq bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  v_matches boolean := false;
  v_base_id bigint;
  v_floor bigint;
  v_ceiling bigint;
BEGIN
  BEGIN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('document-mutation:' || p_document_id, 0::bigint)
    );
    SELECT EXISTS (
      SELECT 1 FROM document_yjs_heads h
      WHERE h.document_id = p_document_id::uuid
        AND h.authority_id = p_authority_id
        AND h.authority_generation = p_generation
    ) INTO v_matches;
    IF v_matches THEN
      SELECT c.id, c.up_to_seq INTO v_base_id, v_floor
      FROM document_yjs_checkpoints c
      WHERE c.document_id = p_document_id::uuid
        AND c.authority_id = p_authority_id
        AND c.authority_generation = p_generation
      ORDER BY c.up_to_seq DESC, c.id DESC
      LIMIT 1;
      v_floor := coalesce(v_floor, 0);
      -- Admissions allocate IDs under the mutation lock. The generation's
      -- admission index avoids scanning retained rows of retired generations.
      SELECT u.id INTO v_ceiling FROM document_yjs_updates u
      WHERE u.document_id = p_document_id::uuid
        AND u.authority_id = p_authority_id
        AND u.authority_generation = p_generation
      ORDER BY u.admission_sequence DESC, u.batch_ordinal DESC
      LIMIT 1;
      v_ceiling := greatest(v_floor, coalesce(v_ceiling, 0));
    END IF;
    -- PL/pgSQL variables survive this subtransaction rollback; locks do not.
    RAISE EXCEPTION USING ERRCODE = 'MFC01', MESSAGE = 'release checkpoint snapshot lock';
  EXCEPTION WHEN SQLSTATE 'MFC01' THEN
    NULL;
  END;
  IF v_matches THEN
    RETURN QUERY SELECT v_base_id, v_floor, v_ceiling;
  END IF;
END;
$$;
