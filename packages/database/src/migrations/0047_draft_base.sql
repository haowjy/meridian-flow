ALTER TABLE "branch_write_journal" ADD COLUMN "draft_base_update_seq" bigint;--> statement-breakpoint
UPDATE "branch_write_journal" AS journal
SET "draft_base_update_seq" = coalesce(
	(
		SELECT min(candidate.seq)
		FROM (
			SELECT lineage."upstream_update_seq" AS seq
			FROM "push_lineage" AS lineage
			WHERE lineage."branch_id" = journal."branch_id"
				AND lineage."upstream_update_seq" IS NOT NULL
				AND lineage."created_at" <= journal."created_at"
			ORDER BY lineage."created_at" DESC, lineage."id" DESC
			LIMIT 1
		) AS candidate
	),
	(
		SELECT max(live."id")
		FROM "document_yjs_updates" AS live
		JOIN "document_branches" AS branch ON branch."id" = journal."branch_id"
		WHERE live."document_id" = branch."document_id"
			AND live."created_at" <= branch."created_at"
	),
	0
);--> statement-breakpoint
ALTER TABLE "branch_write_journal" ALTER COLUMN "draft_base_update_seq" SET NOT NULL;
