CREATE TABLE "issue_column_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_columns" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_column_templates" ADD CONSTRAINT "issue_column_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_column_templates_org_name" ON "issue_column_templates" USING btree ("org_id",lower("name"));--> statement-breakpoint
ALTER TABLE "issue_columns" ADD CONSTRAINT "issue_columns_project_id_issue_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."issue_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_columns_project_id_index" ON "issue_columns" USING btree ("project_id");