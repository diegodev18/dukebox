ALTER TABLE "sessions" ADD COLUMN "permission_mode" text;
--> statement-breakpoint
-- Pre-migration Claude Code sessions always ran in bypass. OpenCode has no
-- modes, so those rows stay null and the picker stays hidden.
UPDATE "sessions" SET "permission_mode" = 'bypass' WHERE "agent_id" = 'claude-code';
