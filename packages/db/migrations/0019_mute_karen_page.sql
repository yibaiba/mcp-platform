CREATE TABLE "ssh_accesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"username" text NOT NULL,
	"identity_file" text NOT NULL,
	"reconnect_interval_seconds" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssh_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"access_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"local_port" integer NOT NULL,
	"remote_port" integer NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ssh_accesses" ADD CONSTRAINT "ssh_accesses_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_bindings" ADD CONSTRAINT "ssh_bindings_access_id_ssh_accesses_id_fk" FOREIGN KEY ("access_id") REFERENCES "public"."ssh_accesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_bindings" ADD CONSTRAINT "ssh_bindings_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_connection_unique" ON "ssh_bindings" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_listener_unique" ON "ssh_bindings" USING btree ("host","port","remote_port");