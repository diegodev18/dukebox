ALTER TABLE "sessions" ADD COLUMN "permission_mode" text;
--> statement-breakpoint
-- Pre-migration Claude Code sessions always ran in bypass. OpenCode rows
-- were left null (it had no modes yet); the server now treats those as bypass.
UPDATE "sessions" SET "permission_mode" = 'bypass' WHERE "agent_id" = 'claude-code';
