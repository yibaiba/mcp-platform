CREATE TABLE "result_originals" (
	"artifact_id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"tool_id" text NOT NULL,
	"call_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "result_presentation" jsonb DEFAULT '{"enabled":false,"thresholdBytes":32768,"retainBytes":8192}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "result_originals" ADD CONSTRAINT "result_originals_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;