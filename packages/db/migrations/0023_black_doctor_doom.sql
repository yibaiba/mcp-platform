ALTER TABLE "mcpb_installs" ADD COLUMN "phase" text DEFAULT 'verify' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcpb_installs" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "mcpb_installs" ADD COLUMN "connection_revision" integer;--> statement-breakpoint
ALTER TABLE "mcpb_installs" ADD COLUMN "destination" text;--> statement-breakpoint
ALTER TABLE "mcpb_packages" ADD COLUMN "removed_at" timestamp with time zone;