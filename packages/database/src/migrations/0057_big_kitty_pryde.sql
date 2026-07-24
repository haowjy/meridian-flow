DROP TABLE "model_response_causal_cuts" CASCADE;--> statement-breakpoint
DROP TABLE "model_response_observation_entries" CASCADE;--> statement-breakpoint
DROP TABLE "model_response_observation_snapshots" CASCADE;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "lineage_evidence";