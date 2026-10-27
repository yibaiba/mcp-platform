ALTER TABLE "authorization_bindings" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;