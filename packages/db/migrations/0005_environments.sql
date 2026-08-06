CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"branch_pattern" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"config_override" jsonb,
	"snapshot_image" text,
	"environment_draft" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "environments_project_id_position_idx" ON "environments" USING btree ("project_id","position");
--> statement-breakpoint
CREATE UNIQUE INDEX "environments_project_id_name_idx" ON "environments" USING btree ("project_id","name");
--> statement-breakpoint
-- Existing single environments become one row each. The pattern is `**` and
-- not `*` because a single star stops at a slash, so `*` would silently stop
-- matching branches like `refact/auth` that work today.
INSERT INTO "environments" ("project_id", "name", "branch_pattern", "position", "config_override", "snapshot_image", "environment_draft")
SELECT "id", 'Default', '**', 0, "config_override", "snapshot_image", "environment_draft"
FROM "projects"
WHERE "config_override" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "environment_id" uuid;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "sessions_environment_id_idx" ON "sessions" USING btree ("environment_id");
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "config_override";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "snapshot_image";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "environment_draft";
