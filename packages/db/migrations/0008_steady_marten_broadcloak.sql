CREATE TABLE "config_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"declaration" jsonb NOT NULL,
	"mappings" jsonb NOT NULL,
	"mode" text DEFAULT 'upsert' NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"encrypted" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "deployment_state" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "catalog" jsonb DEFAULT '{"toolNaming":"stable","connectionAliases":{},"tools":{},"content":{}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "config_manifests" ADD CONSTRAINT "config_manifests_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_secrets" ADD CONSTRAINT "config_secrets_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "config_manifests_owner_name" ON "config_manifests" USING btree ("owner_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "config_secrets_owner_name" ON "config_secrets" USING btree ("owner_id","name");