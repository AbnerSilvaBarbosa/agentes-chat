import type { FactoryHome } from "@agenteschat/client";
import { usePoOverview } from "@agenteschat/client";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { TalkToPo } from "@/components/po/TalkToPo";
import { SpaceMark } from "@/pages/IssueProjects";
import "./factory.css";

/**
 * One panel per company (ADR 0184): its mark and name, the open tasks of A fazer, Em andamento and Em revisão, and
 * what it concluded in the last 7 days. Late and waiting show only above zero. The whole panel opens the company's
 * Painel; past the panels the server sent, a link goes to the companies' page of Tarefas. Where the workspace has a PO,
 * a live company's panel also offers "Conversar com o PO" under the stats (ADR 0185): a button cannot sit inside the
 * link, so the card is the list item and the link its body.
 */
export function FactoryPanels({ home }: { home: FactoryHome }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const po = usePoOverview(org.id).data;
  return (
    <>
      <ul className="fh-panels">
        {home.companies.map((c) => (
          <li key={c.id} className="ac-card ac-card--padded fh-panel">
            <Link
              className="fh-panel__link"
              to="/org/$orgId/issues"
              params={{ orgId: org.id }}
              search={{ space: c.id, tab: "painel" } as never}
              aria-label={t("home.factory.openPanel", { name: c.name })}
            >
              <span className="fh-panel__name">
                <SpaceMark space={c} />
                <span className="fh-panel__nametext">{c.name}</span>
              </span>
              <dl className="fh-panel__stats">
                {(["todo", "in_progress", "in_review"] as const).map((stage) => (
                  <div className="fh-panel__stat" key={stage}>
                    <dt>{t(`issues.status.${stage}`)}</dt>
                    <dd>{c.stages[stage]}</dd>
                  </div>
                ))}
                <div className="fh-panel__stat">
                  <dt>{t("home.factory.doneLabel")}</dt>
                  <dd>{c.stages.done}</dd>
                </div>
              </dl>
              {(c.late > 0 || c.waiting > 0) && (
                <span className="fh-panel__flags">
                  {c.late > 0 && (
                    <span className="fh-panel__late">{t("home.factory.lateLabel", { count: c.late })}</span>
                  )}
                  {c.waiting > 0 && (
                    <span className="fh-panel__waiting">{t("home.factory.waitingLabel", { count: c.waiting })}</span>
                  )}
                </span>
              )}
            </Link>
            {po?.agentId && po.companies.some((p) => p.id === c.id) && (
              <div className="fh-panel__talk">
                <TalkToPo agentId={po.agentId} spaceId={c.id} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {home.companiesTotal > home.companies.length && (
        <Link className="home-sec__more fh-more" to="/org/$orgId/issues" params={{ orgId: org.id }}>
          {t("home.factory.moreCompanies", { count: home.companiesTotal })}
        </Link>
      )}
    </>
  );
}
