-- Upgrade persisted subagent cards and completion notices to the shared contracts.
-- Cards that cannot still be linked to an admitted run become explicit admission
-- failures; malformed completion notices are removed and their turn chain is
-- reconnected below.
WITH source AS (
	SELECT
		b.id,
		b.turn_id,
		b.content,
		b.created_at,
		CASE WHEN jsonb_typeof(b.content->'props') = 'object' THEN b.content->'props' ELSE '{}'::jsonb END AS props,
		COALESCE(child_from_card.id, child_from_report.id) AS child_thread_id,
		COALESCE(revision.slug, NULLIF(b.content->'props'->>'agentSlug', ''), 'subagent') AS agent_slug,
		CASE
			WHEN revision.id IS NOT NULL THEN COALESCE(NULLIF(revision.definition->'metadata'->>'name', ''), revision.slug)
			WHEN b.content->'props'->>'reason' = 'This saved subagent card used an older format and could not be linked to a run.' THEN b.content->'props'->>'agentName'
			WHEN COALESCE(NULLIF(b.content->'props'->>'agentSlug', ''), 'subagent') = 'subagent' THEN 'Subagent'
			ELSE COALESCE(NULLIF(b.content->'props'->>'agentSlug', ''), 'subagent')
		END AS agent_name
	FROM turn_blocks b
	LEFT JOIN threads child_from_card ON child_from_card.id::text = b.content->'props'->>'childThreadId'
	LEFT JOIN thread_execution_reports report ON report.assistant_turn_id::text = b.content->'props'->>'execution'
	LEFT JOIN threads child_from_report ON child_from_report.id = report.child_thread_id
	LEFT JOIN threads child ON child.id = COALESCE(child_from_card.id, child_from_report.id)
	LEFT JOIN thread_agent_bindings binding ON binding.thread_id = child.id
	LEFT JOIN agent_definition_revisions revision ON revision.id = binding.definition_revision_id
	WHERE b.block_type = 'custom'
	  AND b.content->>'kind' = 'helper-result'
), normalized AS (
	SELECT
		id,
		jsonb_build_object(
			'agentSlug', agent_slug,
			'agentName', agent_name,
			'parentTurnId', COALESCE(NULLIF(props->>'parentTurnId', ''), turn_id::text),
			'toolCallId', COALESCE(NULLIF(props->>'toolCallId', ''), id::text),
			'deliveryMode', CASE WHEN props->>'deliveryMode' IN ('direct', 'background_notification') THEN props->>'deliveryMode' ELSE 'direct' END,
			'startedAt', COALESCE(NULLIF(props->>'startedAt', ''), created_at::text),
			'terminalAt', CASE
				WHEN props->'terminalAt' = 'null'::jsonb THEN NULL
				WHEN jsonb_typeof(props->'terminalAt') = 'string' THEN props->>'terminalAt'
				ELSE created_at::text
			END
		)
		|| CASE WHEN jsonb_typeof(props->'title') = 'string' THEN jsonb_build_object('title', props->'title') ELSE '{}'::jsonb END
		|| CASE
			WHEN props->>'deliveryMode' IN ('direct', 'background_notification')
			 AND child_thread_id IS NOT NULL
			 AND props->'terminalAt' = 'null'::jsonb
			 AND (NOT (props ? 'execution') OR props->'execution' = 'null'::jsonb OR jsonb_typeof(props->'execution') = 'string')
			 AND NOT (props ? 'outcome')
			THEN jsonb_build_object(
				'childThreadId', child_thread_id::text,
				'execution', CASE WHEN jsonb_typeof(props->'execution') = 'string' THEN props->'execution' ELSE 'null'::jsonb END,
				'terminalAt', 'null'::jsonb
			)
			WHEN props->>'deliveryMode' IN ('direct', 'background_notification')
			 AND child_thread_id IS NOT NULL
			 AND jsonb_typeof(props->'execution') = 'string'
			 AND jsonb_typeof(props->'terminalAt') = 'string'
			 AND COALESCE(props->>'outcome', CASE props->>'status' WHEN 'completed' THEN 'succeeded' WHEN 'cancelled' THEN 'cancelled' WHEN 'failed' THEN 'failed' ELSE NULL END) IN ('succeeded', 'failed', 'cancelled')
			THEN jsonb_build_object(
				'childThreadId', child_thread_id::text,
				'execution', props->'execution',
				'terminalAt', props->'terminalAt',
				'outcome', COALESCE(props->'outcome', to_jsonb(CASE props->>'status' WHEN 'completed' THEN 'succeeded' WHEN 'cancelled' THEN 'cancelled' ELSE 'failed' END))
			)
			ELSE jsonb_build_object(
				'terminalAt', CASE WHEN jsonb_typeof(props->'terminalAt') = 'string' THEN props->'terminalAt' ELSE to_jsonb(created_at::text) END,
				'reason', COALESCE(NULLIF(props->>'reason', ''), 'This saved subagent card used an older format and could not be linked to a run.')
			)
		END AS props
	FROM source
)
UPDATE turn_blocks b
SET content = jsonb_set(
	CASE WHEN jsonb_typeof(b.content) = 'object' THEN b.content ELSE '{}'::jsonb END,
	'{props}', normalized.props, true
)
FROM normalized
WHERE b.id = normalized.id;
--> statement-breakpoint

-- Resolve notices from their launch card first, then from the child ref/handle.
WITH updates AS (
	SELECT
		n.id,
		n.thread_id,
		n.metadata,
		COALESCE(card_child.id, ref_child.id) AS child_thread_id,
		COALESCE(card.report_execution, ref_report.assistant_turn_id) AS report_execution,
		COALESCE(
			card.outcome,
			card.card_props->>'outcome',
			CASE card.card_props->>'status' WHEN 'completed' THEN 'succeeded' WHEN 'cancelled' THEN 'cancelled' WHEN 'failed' THEN 'failed' END,
			ref_report.outcome,
			ref_child.spawn_status
		) AS report_outcome,
		COALESCE(card.agent_slug, ref_report.agent_slug, card.card_props->>'agentSlug', 'subagent') AS agent_slug,
		card.card_props,
		COALESCE(card_revision.id, ref_revision.id) AS revision_id,
		COALESCE(card_revision.slug, ref_revision.slug) AS revision_slug,
		COALESCE(card_revision.definition->'metadata'->>'name', ref_revision.definition->'metadata'->>'name') AS revision_name
	FROM turns n
	LEFT JOIN LATERAL (
		SELECT b.content->'props' AS card_props, child.id AS child_id, report.child_thread_id AS report_child_id,
			report.assistant_turn_id AS report_execution, report.outcome, report.agent_slug
		FROM turns parent
		JOIN turn_blocks b ON b.turn_id = parent.id
		LEFT JOIN threads child ON child.id::text = b.content->'props'->>'childThreadId'
		LEFT JOIN thread_execution_reports report ON report.assistant_turn_id::text = b.content->'props'->>'execution'
		WHERE parent.thread_id = n.thread_id
		  AND b.block_type = 'custom'
		  AND b.content->>'kind' = 'helper-result'
		  AND b.content->'props'->>'execution' = n.metadata->>'execution'
		ORDER BY b.created_at DESC
		LIMIT 1
	) card ON true
	LEFT JOIN threads card_child ON card_child.id = COALESCE(card.child_id, card.report_child_id)
	LEFT JOIN threads ref_child ON ref_child.root_thread_id = n.thread_id AND ref_child.ref = n.metadata->>'handle'
	LEFT JOIN LATERAL (
		SELECT r.* FROM thread_execution_reports r WHERE r.child_thread_id = ref_child.id
		ORDER BY r.created_at DESC LIMIT 1
	) ref_report ON true
	LEFT JOIN thread_agent_bindings card_binding ON card_binding.thread_id = card_child.id
	LEFT JOIN agent_definition_revisions card_revision ON card_revision.id = card_binding.definition_revision_id
	LEFT JOIN thread_agent_bindings ref_binding ON ref_binding.thread_id = ref_child.id
	LEFT JOIN agent_definition_revisions ref_revision ON ref_revision.id = ref_binding.definition_revision_id
	WHERE n.metadata->>'kind' = 'subagent_update'
), repaired AS (
	SELECT
		updates.id,
		updates.metadata,
		updates.child_thread_id,
		COALESCE(NULLIF(updates.metadata->>'handle', ''), child.ref) AS handle,
		CASE WHEN jsonb_typeof(updates.metadata->'execution') = 'string' THEN updates.metadata->>'execution' ELSE updates.report_execution::text END AS execution,
		COALESCE(
			CASE WHEN updates.metadata->>'outcome' IN ('succeeded', 'failed', 'cancelled') THEN updates.metadata->>'outcome' END,
			CASE WHEN updates.metadata->>'outcome' = 'success' THEN 'succeeded' END,
			CASE WHEN updates.report_outcome IN ('succeeded', 'failed', 'cancelled') THEN updates.report_outcome END
		) AS outcome,
		CASE
			WHEN updates.revision_id IS NOT NULL THEN COALESCE(NULLIF(updates.revision_name, ''), updates.revision_slug)
			WHEN updates.agent_slug = 'subagent' THEN 'Subagent'
			ELSE updates.agent_slug
		END AS agent_name
	FROM updates
	LEFT JOIN threads child ON child.id = updates.child_thread_id
)
UPDATE turns n
SET metadata = n.metadata || jsonb_build_object(
	'handle', repaired.handle,
	'execution', COALESCE(to_jsonb(repaired.execution), 'null'::jsonb),
	'outcome', repaired.outcome,
	'childThreadId', repaired.child_thread_id::text,
	'agentName', repaired.agent_name
)
FROM repaired
WHERE n.id = repaired.id
  AND repaired.child_thread_id IS NOT NULL
  AND repaired.handle IS NOT NULL
  AND repaired.outcome IS NOT NULL
  AND repaired.agent_name IS NOT NULL;
--> statement-breakpoint

-- Remove only unrepaired completion notices. Preserve the rest of the turn chain.
CREATE TEMP TABLE invalid_subagent_update_turns ON COMMIT DROP AS
SELECT n.id, n.thread_id, n.parent_turn_id
FROM turns n
WHERE n.metadata->>'kind' = 'subagent_update'
  AND (
	NOT (n.metadata ? 'childThreadId')
	OR NOT (n.metadata ? 'agentName')
	OR NOT (n.metadata ? 'handle')
	OR NOT (n.metadata ? 'execution')
	OR NOT (n.metadata ? 'outcome')
	OR NULLIF(n.metadata->>'childThreadId', '') IS NULL
	OR NULLIF(n.metadata->>'agentName', '') IS NULL
	OR NULLIF(n.metadata->>'handle', '') IS NULL
	OR jsonb_typeof(n.metadata->'execution') NOT IN ('string', 'null')
	OR COALESCE(n.metadata->>'outcome', '') NOT IN ('succeeded', 'failed', 'cancelled')
  );
--> statement-breakpoint

-- Walk through adjacent invalid notices so surviving turns never point at a
-- deleted ancestor, even if several consecutive notices could not be repaired.
CREATE TEMP TABLE invalid_subagent_update_reparents ON COMMIT DROP AS
WITH RECURSIVE parent_paths(invalid_id, thread_id, parent_id, visited) AS (
	SELECT id, thread_id, parent_turn_id, ARRAY[id] FROM invalid_subagent_update_turns
	UNION ALL
	SELECT paths.invalid_id, paths.thread_id, invalid_parent.parent_turn_id, paths.visited || invalid_parent.id
	FROM parent_paths paths
	JOIN invalid_subagent_update_turns invalid_parent
	  ON invalid_parent.id = paths.parent_id AND invalid_parent.thread_id = paths.thread_id
	WHERE NOT (invalid_parent.id = ANY(paths.visited))
), nearest_valid_parent AS (
	SELECT DISTINCT ON (paths.invalid_id) paths.invalid_id, paths.thread_id, paths.parent_id
	FROM parent_paths paths
	WHERE paths.parent_id IS NULL
	   OR NOT EXISTS (SELECT 1 FROM invalid_subagent_update_turns invalid WHERE invalid.id = paths.parent_id)
	ORDER BY paths.invalid_id, cardinality(paths.visited) DESC
)
SELECT invalid_id, thread_id, parent_id FROM nearest_valid_parent;
--> statement-breakpoint

UPDATE turns child
SET parent_turn_id = reparent.parent_id
FROM invalid_subagent_update_reparents reparent
WHERE child.thread_id = reparent.thread_id AND child.parent_turn_id = reparent.invalid_id;
--> statement-breakpoint

UPDATE threads t
SET active_leaf_turn_id = CASE
		WHEN EXISTS (
			SELECT 1 FROM invalid_subagent_update_reparents r WHERE r.invalid_id = t.active_leaf_turn_id
		) THEN (
			SELECT r.parent_id FROM invalid_subagent_update_reparents r WHERE r.invalid_id = t.active_leaf_turn_id
		)
		ELSE t.active_leaf_turn_id
	END,
	conversational_leaf_turn_id = CASE
		WHEN EXISTS (
			SELECT 1 FROM invalid_subagent_update_reparents r WHERE r.invalid_id = t.conversational_leaf_turn_id
		) THEN (
			SELECT r.parent_id FROM invalid_subagent_update_reparents r WHERE r.invalid_id = t.conversational_leaf_turn_id
		)
		ELSE t.conversational_leaf_turn_id
	END
WHERE EXISTS (
	SELECT 1 FROM invalid_subagent_update_reparents r
	WHERE r.thread_id = t.id
	  AND (r.invalid_id = t.active_leaf_turn_id OR r.invalid_id = t.conversational_leaf_turn_id)
);
--> statement-breakpoint

DELETE FROM event_journal e USING invalid_subagent_update_turns invalid WHERE e.turn_id = invalid.id;
--> statement-breakpoint

DELETE FROM turns n USING invalid_subagent_update_turns invalid WHERE n.id = invalid.id;
--> statement-breakpoint

DROP TABLE invalid_subagent_update_reparents;
--> statement-breakpoint

DROP TABLE invalid_subagent_update_turns;
--> statement-breakpoint
