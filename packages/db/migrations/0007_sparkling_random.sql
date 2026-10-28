CREATE TABLE "system_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"event" text NOT NULL,
	"owner_id" text,
	"code" text,
	"method" text,
	"route" text,
	"status" integer,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "connection_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"credential_mode" text DEFAULT 'independent' NOT NULL,
	"tool_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"receiver_config" text,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" DROP CONSTRAINT "devices_token_hash_unique";--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "share_id" uuid;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "share_version" integer;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "resource_owner_id" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "credential_owner_id" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "credential_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "pairings" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "connection_shares" ADD CONSTRAINT "connection_shares_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_shares" ADD CONSTRAINT "connection_shares_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_shares" ADD CONSTRAINT "connection_shares_recipient_id_user_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "system_logs_time" ON "system_logs" USING btree ("at","id");--> statement-breakpoint
CREATE INDEX "system_logs_level_time" ON "system_logs" USING btree ("level","at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_share_recipient" ON "connection_shares" USING btree ("connection_id","recipient_id");--> statement-breakpoint
CREATE INDEX "connection_shares_recipient" ON "connection_shares" USING btree ("recipient_id","revoked");--> statement-breakpoint
ALTER TABLE "pairings" ADD CONSTRAINT "pairings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_subject_idx" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "calls_owner_time" ON "calls" USING btree ("owner_id","created_at","id");--> statement-breakpoint
CREATE INDEX "calls_owner_tool_time" ON "calls" USING btree ("owner_id","tool_id","created_at","id");--> statement-breakpoint
CREATE INDEX "calls_owner_connection_time" ON "calls" USING btree ("owner_id","connection_id","created_at","id");--> statement-breakpoint
CREATE INDEX "calls_owner_device_time" ON "calls" USING btree ("owner_id","device_id","created_at","id");--> statement-breakpoint
CREATE INDEX "calls_owner_profile_time" ON "calls" USING btree ("owner_id","profile_id","created_at","id");--> statement-breakpoint
CREATE INDEX "calls_owner_status_time" ON "calls" USING btree ("owner_id","status","created_at","id");--> statement-breakpoint
ALTER TABLE "devices" DROP COLUMN "token_hash";