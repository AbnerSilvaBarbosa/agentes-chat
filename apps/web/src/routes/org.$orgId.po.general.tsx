import { usePoOverview } from "@agenteschat/client";
import { EmptyState } from "@agenteschat/ui";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ErrorState } from "@/components/Loading";
import { threadSearch } from "@/lib/open-param";
import { ChannelSkeleton } from "@/pages/ChannelPage";
import { DmPage } from "@/pages/DmPage";

/**
 * The PO's plain DM with the person, reached from the PO view as "Avisos e rotinas" (ADR 0229 addendum): its routines
 * and hand-offs write here, about no one company. With no PO, the page says so.
 */
export const Route = createFileRoute("/org/$orgId/po/general")({
  // `?m=<message>` opens the DM at that message (a notice, a search hit); `?thread=` is the one in its panel.
  validateSearch: (search: Record<string, unknown>): { m?: string } & ReturnType<typeof threadSearch> => ({
    ...threadSearch(search),
    ...(typeof search.m === "string" && search.m ? { m: search.m } : {}),
  }),
  component: function PoGeneral() {
    const { t } = useTranslation();
    const { orgId } = Route.useParams();
    const focus = Route.useSearch().m;
    const overview = usePoOverview(orgId);
    if (overview.isError)
      return (
        <main className="shell__main">
          <div className="page page--mid">
            <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
          </div>
        </main>
      );
    if (!overview.data) return <ChannelSkeleton dm="agent" />;
    const { agentId } = overview.data;
    if (!agentId)
      return (
        <main className="shell__main">
          <div className="page page--mid">
            <EmptyState icon="agent">{t("dm.poNone")}</EmptyState>
          </div>
        </main>
      );
    return <DmPage key="general" target={{ agentId }} poGeneral focusMessageId={focus} />;
  },
});
