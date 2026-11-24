import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { boardSearch } from "@/lib/open-param";
import { IssuesPage } from "@/pages/IssuesPage";

/**
 * Minhas tarefas (ADR 0225): the tasks assigned to the member, from every company and board, as the board of Tarefas.
 * It takes the same search as that page: `?project=` and `?space=` narrow it, `?open=131` opens a task's details.
 */
export const Route = createFileRoute("/org/$orgId/my-tasks")({
  validateSearch: boardSearch,
  component: () => (
    <Main>
      <IssuesPage mine />
    </Main>
  ),
});
