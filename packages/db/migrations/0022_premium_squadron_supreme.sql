CREATE TABLE "mcpb_installs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"package_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"connection_id" uuid,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "mcpb_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"sha256" text NOT NULL,
	"manifest" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcpb_installs" ADD CONSTRAINT "mcpb_installs_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcpb_installs" ADD CONSTRAINT "mcpb_installs_package_id_mcpb_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."mcpb_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcpb_installs" ADD CONSTRAINT "mcpb_installs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcpb_packages" ADD CONSTRAINT "mcpb_packages_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcpb_owner_digest" ON "mcpb_packages" USING btree ("owner_id","sha256");