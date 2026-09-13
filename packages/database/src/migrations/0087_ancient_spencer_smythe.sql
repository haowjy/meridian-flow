CREATE TABLE "context_operation_receipts" (
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_operation_receipts_user_id_project_id_operation_id_pk" PRIMARY KEY("user_id","project_id","operation_id")
);
--> statement-breakpoint
ALTER TABLE "context_operation_receipts" ADD CONSTRAINT "context_operation_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_operation_receipts" ADD CONSTRAINT "context_operation_receipts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;