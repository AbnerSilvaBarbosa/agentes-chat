CREATE TABLE "po_card_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"requester_user_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"message_id" uuid,
	"space_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duplicate_of_issue_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"issue_id" uuid,
	"spec_state" text,
	"spec_run_id" uuid,
	"spec_queued_at" timestamp with time zone,
	"spec_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "po_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "spec_page_id" uuid;--> statement-breakpoint
ALTER TABLE "po_card_proposals" ADD CONSTRAINT "po_card_proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_card_proposals" ADD CONSTRAINT "po_card_proposals_space_id_issue_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."issue_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_card_proposals" ADD CONSTRAINT "po_card_proposals_project_id_issue_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."issue_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_card_proposals" ADD CONSTRAINT "po_card_proposals_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "po_card_proposals_org_id_requester_user_id_status_index" ON "po_card_proposals" USING btree ("org_id","requester_user_id","status");--> statement-breakpoint
CREATE INDEX "po_card_proposals_space_id_spec_state_spec_queued_at_index" ON "po_card_proposals" USING btree ("space_id","spec_state","spec_queued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "po_card_proposals_issue_id_index" ON "po_card_proposals" USING btree ("issue_id") WHERE "po_card_proposals"."issue_id" is not null;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_po_agent_id_agents_id_fk" FOREIGN KEY ("po_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_spec_page_id_wiki_pages_id_fk" FOREIGN KEY ("spec_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE set null ON UPDATE no action;