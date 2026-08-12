ALTER TABLE "sessions" ADD COLUMN "pr_title" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "pr_draft" boolean;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "pr_state" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "git_preferences" jsonb;
