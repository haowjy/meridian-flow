ALTER TABLE "user_subscriptions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "user_subscriptions" CASCADE;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_free_tier_grant" ON "credit_lots" USING btree ("user_id","grant_reason") WHERE "credit_lots"."source_type" = 'grant' AND "credit_lots"."grant_reason" LIKE 'free_tier_%';