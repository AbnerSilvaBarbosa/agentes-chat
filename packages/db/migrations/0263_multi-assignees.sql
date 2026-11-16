CREATE TABLE "issue_co_assignees" (
	"issue_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"position" integer NOT NULL,
	"added_by_type" text NOT NULL,
	"added_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_co_assignees_issue_id_user_id_pk" PRIMARY KEY("issue_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "issue_co_assignees" ADD CONSTRAINT "issue_co_assignees_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_co_assignees" ADD CONSTRAINT "issue_co_assignees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_co_assignees" ADD CONSTRAINT "issue_co_assignees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_co_assignees_org_id_user_id_index" ON "issue_co_assignees" USING btree ("org_id","user_id");