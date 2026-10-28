CREATE TABLE "search_catalog_entries" (
	"snapshot_id" text NOT NULL,
	"name" text NOT NULL,
	"definition_hash" text NOT NULL,
	"encrypted" text NOT NULL,
	CONSTRAINT "search_catalog_entries_snapshot_id_name_pk" PRIMARY KEY("snapshot_id","name")
);
--> statement-breakpoint
CREATE TABLE "search_indexes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text,
	"profile_id" uuid,
	"scope" text NOT NULL,
	"family" text NOT NULL,
	"state" text NOT NULL,
	"fingerprint" text NOT NULL,
	"dimensions" integer NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_indexes_scope_unique" UNIQUE("scope")
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "search_options" jsonb DEFAULT '{"strategy":"exact","minScore":null,"hnsw":{"m":16,"efConstruction":64,"efSearch":100}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "search_catalog_entries" ADD CONSTRAINT "search_catalog_entries_snapshot_id_catalog_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."catalog_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_indexes" ADD CONSTRAINT "search_indexes_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_indexes" ADD CONSTRAINT "search_indexes_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;