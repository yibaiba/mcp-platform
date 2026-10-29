CREATE TABLE "local_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"baseline" jsonb NOT NULL,
	"content" jsonb NOT NULL,
	"local_digest" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"connection_id" uuid,
	"connection_revision" integer,
	"skill_version_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"resource_id" text,
	"request_digest" text NOT NULL,
	"action" text NOT NULL,
	"phase" text NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"metadata" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_bindings" ADD CONSTRAINT "local_bindings_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_bindings" ADD CONSTRAINT "local_bindings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_operations" ADD CONSTRAINT "local_operations_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_operations" ADD CONSTRAINT "local_operations_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_sources" ADD CONSTRAINT "local_sources_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_sources" ADD CONSTRAINT "local_sources_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_binding_resource" ON "local_bindings" USING btree ("device_id","resource_id");