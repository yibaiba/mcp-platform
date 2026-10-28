CREATE TABLE "tool_vectors" (
	"owner_id" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"tool_id" text NOT NULL,
	"definition_hash" text NOT NULL,
	"vector" double precision[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_vectors_owner_id_profile_id_scope_tool_id_pk" PRIMARY KEY("owner_id","profile_id","scope","tool_id")
);
--> statement-breakpoint
CREATE TABLE "rest_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"tool_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"idempotency_hash" text,
	"status" text DEFAULT 'running' NOT NULL,
	"interaction_id" uuid,
	"result_digest" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "discovery_mode" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "pinned_tools" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "embedding" jsonb;--> statement-breakpoint
ALTER TABLE "tool_vectors" ADD CONSTRAINT "tool_vectors_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_vectors" ADD CONSTRAINT "tool_vectors_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rest_calls" ADD CONSTRAINT "rest_calls_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rest_calls" ADD CONSTRAINT "rest_calls_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_vectors_scope" ON "tool_vectors" USING btree ("owner_id","profile_id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "rest_calls_idempotency" ON "rest_calls" USING btree ("owner_id","profile_id","credential_id","idempotency_hash");--> statement-breakpoint
CREATE INDEX "rest_calls_owner_status" ON "rest_calls" USING btree ("owner_id","status");