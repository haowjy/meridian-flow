CREATE TABLE "change_trail_document_occurrences" (
	"trail_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	CONSTRAINT "change_trail_document_occurrences_trail_id_document_id_pk" PRIMARY KEY("trail_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "change_trail_document_occurrences" ADD CONSTRAINT "change_trail_document_occurrences_trail_id_change_trail_shells_id_fk" FOREIGN KEY ("trail_id") REFERENCES "public"."change_trail_shells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
