ALTER TABLE "devices" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;
--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "created_by_device_id" uuid;
--> statement-breakpoint
-- Existing installs treated every paired device as a peer. Keep the oldest
-- active one as owner so someone can still administer; the rest become members.
UPDATE "devices"
SET "role" = 'owner'
WHERE "id" = (
  SELECT "id" FROM "devices"
  WHERE "revoked_at" IS NULL
  ORDER BY "created_at" ASC
  LIMIT 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX "devices_one_active_owner_idx" ON "devices" USING btree ("role") WHERE "devices"."role" = 'owner' and "devices"."revoked_at" is null;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_created_by_device_id_devices_id_fk" FOREIGN KEY ("created_by_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "sessions_created_by_device_id_idx" ON "sessions" USING btree ("created_by_device_id");
