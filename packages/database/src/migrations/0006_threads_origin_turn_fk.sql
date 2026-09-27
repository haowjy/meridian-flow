-- Provenance is part of a derived thread's identity. Deleting its source turn
-- must fail while any fork or subagent still refers to it.
ALTER TABLE "threads" ADD CONSTRAINT "threads_origin_turn_id_turns_id_fk" FOREIGN KEY ("origin_turn_id") REFERENCES "public"."turns"("id") ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE NOT VALID;--> statement-breakpoint
ALTER TABLE "threads" VALIDATE CONSTRAINT "threads_origin_turn_id_turns_id_fk";
