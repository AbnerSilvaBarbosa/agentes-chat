-- Our own "also with" table (issue_co_assignees) gives way to the shared list of who has a task (issue_assignees,
-- ADR 0188). The principal was already carried over by the list's own migration, as position 0; the people also with
-- come after it, in their order, skipping anyone already on the list. The old table stays one release, since a deploy migrates while the version before it still serves; a later migration drops it.
INSERT INTO "issue_assignees" ("org_id", "issue_id", "assignee_type", "assignee_id", "position")
SELECT c."org_id", c."issue_id", 'person', c."user_id",
	COALESCE((SELECT max(a."position") FROM "issue_assignees" a WHERE a."issue_id" = c."issue_id"), -1)
	+ row_number() OVER (PARTITION BY c."issue_id" ORDER BY c."position", c."created_at")
FROM "issue_co_assignees" c
WHERE EXISTS (SELECT 1 FROM "organization_members" m WHERE m."user_id" = c."user_id" AND m."org_id" = c."org_id")
ON CONFLICT ("issue_id", "assignee_type", "assignee_id") DO NOTHING;
