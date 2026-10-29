CREATE TABLE "library_entries" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"locator" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "library_owner_kind_name" ON "library_entries" USING btree ("owner_id","kind","name");--> statement-breakpoint
CREATE UNIQUE INDEX "library_owner_kind_locator" ON "library_entries" USING btree ("owner_id","kind","locator");