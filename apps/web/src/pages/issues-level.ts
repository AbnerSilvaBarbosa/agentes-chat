/**
 * Which level of Tarefas a page shows, and the chrome that belongs to it (ADR 0180): the companies' root, one
 * company's boards, one board's kanban, or every task of the workspace, or the tasks assigned to the member (ADR 0181). Pure, so the rule is read in one place and
 * tested without drawing the page.
 */
export type IssuesLevel = "root" | "company" | "board" | "all" | "mine";

/** What the address says: `?project=` (a board, also "none"), `?space=` (a company), `?all=1`, `?columns=`. */
export interface IssuesAddress {
  project?: string;
  space?: string;
  all?: boolean;
  /** `?columns=` beside a company (ADR 0185 addendum): its tasks in those columns, read as the whole list of tasks. */
  columns?: boolean;
  /** The page of the member's own tasks (`/my-tasks`), which no address parameter reaches. */
  mine?: boolean;
}

export function levelOf({ project, space, all, columns, mine }: IssuesAddress): IssuesLevel {
  if (mine) return "mine";
  if (project) return "board";
  if (space) return columns ? "all" : "company";
  return all ? "all" : "root";
}

export interface IssuesChrome {
  /** What the header's main button makes: a company, a board in the company shown, or a task. */
  action: "company" | "board" | "task";
  /** The toolbar's Empresa and Board selects: only where the page shows tasks of more than one place. */
  filters: { space: boolean; board: boolean };
  /** `false`: "Filtro" offers no assignee choice, the page being that filter. Unset: it does. */
  assignee?: false;
}

export function chromeFor(level: IssuesLevel): IssuesChrome {
  switch (level) {
    case "root":
      return { action: "company", filters: { space: false, board: false } };
    case "company":
      return { action: "board", filters: { space: false, board: false } };
    case "board":
      return { action: "task", filters: { space: false, board: false } };
    case "all":
      return { action: "task", filters: { space: true, board: true } };
    case "mine":
      return { action: "task", filters: { space: true, board: true }, assignee: false };
  }
}
