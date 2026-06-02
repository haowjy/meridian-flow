CREATE OR REPLACE FUNCTION validate_parent_turn_same_thread()
RETURNS TRIGGER AS $$
DECLARE
  v_parent_thread_id UUID;
BEGIN
  IF NEW.parent_turn_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT thread_id INTO v_parent_thread_id
  FROM turns
  WHERE id = NEW.parent_turn_id;

  IF v_parent_thread_id IS NOT NULL AND v_parent_thread_id != NEW.thread_id THEN
    RAISE EXCEPTION 'parent_turn_id must reference a turn in the same thread';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_active_leaf_same_thread()
RETURNS TRIGGER AS $$
DECLARE
  v_leaf_thread_id UUID;
BEGIN
  IF NEW.active_leaf_turn_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT thread_id INTO v_leaf_thread_id
  FROM turns
  WHERE id = NEW.active_leaf_turn_id;

  IF v_leaf_thread_id IS NOT NULL AND v_leaf_thread_id != NEW.id THEN
    RAISE EXCEPTION 'active_leaf_turn_id must reference a turn in the same thread';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
