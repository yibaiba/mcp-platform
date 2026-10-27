CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"source_task_id" uuid NOT NULL,
	"target_profile_id" uuid NOT NULL,
	"target_revision" integer NOT NULL,
	"summary" text NOT NULL,
	"artifact_ids" jsonb NOT NULL,
	"mode" text NOT NULL,
	"credential_id" uuid,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"task_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handoffs_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
CREATE TABLE "permission_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"task_id" uuid,
	"profile_revision" integer NOT NULL,
	"bindings" jsonb NOT NULL,
	"requested" jsonb NOT NULL,
	"approved" jsonb,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"deadline" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temporary_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"task_id" uuid,
	"request_id" uuid,
	"profile_revision" integer NOT NULL,
	"bindings" jsonb NOT NULL,
	"permissions" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "temporary_grants_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"revision" integer NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "profile_id" uuid;--> statement-breakpoint
ALTER TABLE "authorization_bindings" ADD COLUMN "credentials" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "credential_id" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "binding_id" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "entry" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "correlation_id" uuid;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "phase" text DEFAULT 'dispatch' NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "requestable" jsonb DEFAULT '{"toolIds":[],"contentIds":[],"artifactIds":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "connection_identities" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "handoff_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_target_profile_id_profiles_id_fk" FOREIGN KEY ("target_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_requests" ADD CONSTRAINT "permission_requests_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_requests" ADD CONSTRAINT "permission_requests_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temporary_grants" ADD CONSTRAINT "temporary_grants_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temporary_grants" ADD CONSTRAINT "temporary_grants_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_events" ADD CONSTRAINT "workspace_events_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "handoff_idempotency" ON "handoffs" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_request_idempotency" ON "permission_requests" USING btree ("profile_id","subject","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_event_revision" ON "workspace_events" USING btree ("aggregate_id","revision");