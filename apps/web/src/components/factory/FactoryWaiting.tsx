import type { FactoryCompany, FactoryHome } from "@agenteschat/client";
import { formatSpan } from "@agenteschat/client/lib/span";
import { GroupHeading } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useNow } from "@/hooks/useNow";
import { SpaceMark } from "@/pages/IssueProjects";
import "./factory.css";

/**
 * "Esperando seu teste" (ADR 0184): the tasks sitting in a column flagged as one that waits for a person, longest
 * first, as the server sent them. Each row opens the task; past the rows shown, "Ver tudo" opens Tarefas filtered to
 * those columns. Without a task it draws nothing.
 */
export function FactoryWaiting({
  waiting,
  companies,
}: {
  waiting: FactoryHome["waiting"];
  /** The panels: a row takes its company's mark from here (a company past the first 20 shows the plain dot). */
  companies: FactoryCompany[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const now = useNow(60_000);
  if (waiting.items.length === 0) return null;
  return (
    <section className="home-sec" aria-label={t("home.factory.waitingTitle")}>
      <GroupHeading
        title={t("home.factory.waitingTitle")}
        count={waiting.total}
        aside={
          waiting.total > waiting.items.length ? (
            <Link
              className="home-sec__more"
              to="/org/$orgId/issues"
              params={{ orgId: org.id }}
              search={{ all: "1", waiting: "person" } as never}
            >
              {t("home.factory.seeAll")}
            </Link>
          ) : null
        }
      />
      <ul className="list-card home-list">
        {waiting.items.map((task) => (
          <li key={task.id}>
            <Link
              className="home-row fh-row"
              to="/org/$orgId/issues/$number"
              params={{ orgId: org.id, number: String(task.number) }}
            >
              <span className="fh-row__title">
                <span className="fh-row__number">#{task.number}</span> {task.title}
              </span>
              <span className="fh-row__time">
                {t("home.factory.waitingFor", { span: formatSpan(now - Date.parse(task.since)) })}
              </span>
              <span className="fh-row__where">
                <SpaceMark space={companies.find((c) => c.id === task.spaceId) ?? { color: "", image: null }} />
                <span className="fh-row__wheretext">
                  {task.spaceName} · {task.projectName}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
