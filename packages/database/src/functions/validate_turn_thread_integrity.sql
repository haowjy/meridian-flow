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

CREATE OR REPLACE FUNCTION validate_parent_turn_links_same_thread()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM turns child
    JOIN turns parent ON parent.id = child.parent_turn_id
    WHERE child.thread_id != parent.thread_id
  ) THEN
    RAISE EXCEPTION 'parent_turn_id must reference a turn in the same thread';
  END IF;

  RETURN NULL;
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

CREATE OR REPLACE FUNCTION validate_active_leaf_is_leaf()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM threads th
    LEFT JOIN turns leaf ON leaf.id = th.active_leaf_turn_id
    WHERE th.active_leaf_turn_id IS NOT NULL
      AND (
        leaf.id IS NULL
        OR leaf.thread_id != th.id
        OR EXISTS (
          SELECT 1
          FROM turns child
          WHERE child.parent_turn_id = th.active_leaf_turn_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'active_leaf_turn_id must reference a leaf turn in the same thread';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
