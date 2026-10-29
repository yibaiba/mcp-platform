CREATE TABLE "network_configuration" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"encrypted" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "update_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text,
	"connection_id" uuid,
	"fingerprint" text NOT NULL,
	"scheduled" boolean DEFAULT false NOT NULL,
	"result" jsonb,
	"next_check_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "update_checks" ADD CONSTRAINT "update_checks_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_checks" ADD CONSTRAINT "update_checks_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;