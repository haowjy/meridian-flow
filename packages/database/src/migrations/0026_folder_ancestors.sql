CREATE TABLE "folder_ancestors" (
	"folder_id" uuid NOT NULL,
	"ancestor_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	CONSTRAINT "folder_ancestors_folder_id_ancestor_id_pk" PRIMARY KEY("folder_id","ancestor_id"),
	CONSTRAINT "folder_ancestors_depth_nonneg" CHECK ("folder_ancestors"."depth" >= 0)
);
--> statement-breakpoint
ALTER TABLE "folder_ancestors" ADD CONSTRAINT "folder_ancestors_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_ancestors" ADD CONSTRAINT "folder_ancestors_ancestor_id_folders_id_fk" FOREIGN KEY ("ancestor_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folder_ancestors_ancestor" ON "folder_ancestors" USING btree ("ancestor_id");