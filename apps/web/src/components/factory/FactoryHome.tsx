import { useFactoryHome } from "@agenteschat/client";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { FactoryPanels } from "./FactoryPanels";
import { FactoryWaiting } from "./FactoryWaiting";
import "./factory.css";

/**
 * The "Fábrica" block on top of Início (ADR 0184): the tasks waiting for a person over one panel per company, from
 * one read. It draws nothing while loading, on an error or with no company that has a task: Início stays as it was.
 */
export function FactoryHome() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { data } = useFactoryHome(org.id);
  if (!data || data.companies.length === 0) return null;
  return (
    <section className="fh" aria-label={t("home.factory.title")}>
      <FactoryWaiting waiting={data.waiting} companies={data.companies} />
      <FactoryPanels home={data} />
    </section>
  );
}
