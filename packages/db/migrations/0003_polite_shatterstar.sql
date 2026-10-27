CREATE TABLE "authorization_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"identity" text NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"binding_id" text NOT NULL,
	"capability_key" text NOT NULL,
	"encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "server_info" jsonb;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "instructions" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "instructions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "authorization_bindings" ADD CONSTRAINT "authorization_bindings_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_bindings" ADD CONSTRAINT "authorization_bindings_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_snapshots" ADD CONSTRAINT "catalog_snapshots_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_snapshots" ADD CONSTRAINT "catalog_snapshots_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_snapshots" ADD CONSTRAINT "catalog_snapshots_binding_id_authorization_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."authorization_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "binding_identity" ON "authorization_bindings" USING btree ("connection_id","identity");