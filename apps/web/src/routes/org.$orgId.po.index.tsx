import { usePoOverview } from "@agenteschat/client";
import { EmptyState } from "@agenteschat/ui";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ErrorState } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { poLanding, rememberedPoCompany } from "@/lib/po-landing";
import { ChannelSkeleton } from "@/pages/ChannelPage";

/**
 * The PO view without a company (the sidebar's PO row, the PO agent's row): it replaces itself with the chat of the
 * company the person opened last, else the first live one (ADR 0185). With no PO, or no company, the page says so.
 */
export const Route = createFileRoute("/org/$orgId/po/")({
  component: function PoLanding() {
    const { t } = useTranslation();
    const { orgId } = Route.useParams();
    const { me } = useOrg();
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
    const { agentId, companies } = overview.data;
    const spaceId = agentId ? poLanding(companies, rememberedPoCompany(me.user.id, orgId)) : null;
    if (!spaceId)
      return (
        <main className="shell__main">
          <div className="page page--mid">
            <EmptyState icon="agent">{t("dm.poNone")}</EmptyState>
          </div>
        </main>
      );
    return <Navigate to="/org/$orgId/po/$spaceId" params={{ orgId, spaceId }} replace />;
  },
});
