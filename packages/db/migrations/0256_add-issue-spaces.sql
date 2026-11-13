CREATE TABLE "issue_spaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'graphite' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_projects" ADD COLUMN "space_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_spaces" ADD CONSTRAINT "issue_spaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_spaces_org_name" ON "issue_spaces" USING btree ("org_id",lower("name"));--> statement-breakpoint
ALTER TABLE "issue_projects" ADD CONSTRAINT "issue_projects_space_id_issue_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."issue_spaces"("id") ON DELETE set null ON UPDATE no action;