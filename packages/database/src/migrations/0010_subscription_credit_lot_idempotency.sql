ALTER TABLE "credit_lots" DROP CONSTRAINT "credit_lots_grant_reason";--> statement-breakpoint
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_grant_reason" CHECK ("credit_lots"."source_type" IN ('grant', 'subscription') OR "credit_lots"."grant_reason" IS NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_subscription_reason" ON "credit_lots" USING btree ("user_id","grant_reason") WHERE "credit_lots"."source_type" = 'subscription' AND "credit_lots"."grant_reason" IS NOT NULL;
