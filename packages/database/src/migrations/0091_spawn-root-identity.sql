ALTER TABLE "threads" ADD COLUMN "root_thread_id" uuid;--> statement-breakpoint
WITH RECURSIVE spawn_roots AS (
  SELECT id, project_id, id AS root_id FROM threads WHERE kind = 'primary'
  UNION ALL
  SELECT child.id, child.project_id, parent.root_id
  FROM threads child JOIN spawn_roots parent
    ON child.parent_thread_id = parent.id AND child.project_id = parent.project_id
  WHERE child.kind = 'subagent'
)
UPDATE threads SET root_thread_id = spawn_roots.root_id
FROM spawn_roots WHERE threads.id = spawn_roots.id AND threads.kind = 'subagent';--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_spawn_root_same_project_fk" FOREIGN KEY ("project_id","root_thread_id") REFERENCES "public"."threads"("project_id","id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "threads" VALIDATE CONSTRAINT "threads_spawn_root_same_project_fk";--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_spawn_root_required" CHECK ("threads"."kind" != 'subagent' OR "threads"."root_thread_id" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "threads" VALIDATE CONSTRAINT "threads_spawn_root_required";