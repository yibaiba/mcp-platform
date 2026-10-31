CREATE TABLE "connection_team_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"credential_mode" text DEFAULT 'independent' NOT NULL,
	"tool_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_team_shares_connection_id_unique" UNIQUE("connection_id")
);
--> statement-breakpoint
ALTER TABLE "connection_shares" ADD COLUMN "team_share_id" uuid;--> statement-breakpoint
ALTER TABLE "connection_team_shares" ADD CONSTRAINT "connection_team_shares_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_team_shares" ADD CONSTRAINT "connection_team_shares_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_shares" ADD CONSTRAINT "connection_shares_team_share_id_connection_team_shares_id_fk" FOREIGN KEY ("team_share_id") REFERENCES "public"."connection_team_shares"("id") ON DELETE cascade ON UPDATE no action;