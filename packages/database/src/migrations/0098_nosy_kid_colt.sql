CREATE TABLE "account_skill_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_skill_installs" ADD CONSTRAINT "account_skill_installs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (table is created empty above)--> statement-breakpoint
CREATE UNIQUE INDEX "account_skill_installs_owner_slug" ON "account_skill_installs" USING btree ("owner_user_id","slug"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table is created empty above)