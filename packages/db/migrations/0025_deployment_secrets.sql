CREATE TABLE "deployment_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
