CREATE TABLE "mcp_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"locator" text NOT NULL,
	"definition" jsonb NOT NULL,
	"available" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "protocol_version" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "content_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_entries" ADD CONSTRAINT "mcp_entries_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_entries" ADD CONSTRAINT "mcp_entries_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_entries_owner" ON "mcp_entries" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_entries_connection_locator" ON "mcp_entries" USING btree ("connection_id","kind","locator");