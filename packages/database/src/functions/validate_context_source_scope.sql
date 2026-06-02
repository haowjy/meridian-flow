CREATE OR REPLACE FUNCTION validate_context_source_thread_scope()
RETURNS TRIGGER AS $$
DECLARE
  v_thread_project_id UUID;
  v_thread_kind TEXT;
BEGIN
  IF NEW.thread_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT project_id, kind
  INTO v_thread_project_id, v_thread_kind
  FROM threads
  WHERE id = NEW.thread_id;

  IF v_thread_project_id IS NOT NULL AND v_thread_project_id != NEW.project_id THEN
    RAISE EXCEPTION 'session context source thread_id must reference a thread in the same project';
  END IF;

  IF v_thread_kind IS NOT NULL AND v_thread_kind != 'primary' THEN
    RAISE EXCEPTION 'session context source thread_id must reference a primary thread';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_thread_context_source_scope()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM context_sources cs
    WHERE cs.thread_id = NEW.id
      AND (cs.project_id != NEW.project_id OR NEW.kind != 'primary')
  ) THEN
    RAISE EXCEPTION 'referenced session context source requires same-project primary thread';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
