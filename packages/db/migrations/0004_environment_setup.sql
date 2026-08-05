ALTER TABLE "projects" ADD COLUMN "environment_draft" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "purpose" text DEFAULT 'coding' NOT NULL;