import { useCompanyDashboard } from "@agenteschat/client";
import { Segmented } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];

/**
 * A company's Painel (ADR 0182): the numbers of the tasks on its boards for the last 7, 30 or 90 days, 30 at first.
 * Read when it opens and when the period changes; nothing here is built or refreshed by anyone.
 */
export function CompanyDashboard({ orgId, spaceId }: { orgId: string; spaceId: string }) {
  const { t } = useTranslation();
  const [days, setDays] = useState<Period>(30);
  const query = useCompanyDashboard(orgId, spaceId, days);
  return (
    <div className="cdash">
      <Segmented
        size="sm"
        label={t("issues.dashboard.periodLabel")}
        value={String(days)}
        onValueChange={(v) => setDays(Number(v) as Period)}
        options={PERIODS.map((d) => ({ value: String(d), label: t("issues.dashboard.days", { count: d }) }))}
      />
      {query.isLoading && <LoadingList count={4} avatar={false} />}
      {query.isError && !query.data && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
    </div>
  );
}
