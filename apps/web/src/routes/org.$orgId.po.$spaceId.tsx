import { usePoOverview } from "@agenteschat/client";
import { EmptyState } from "@agenteschat/ui";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ErrorState } from "@/components/Loading";
import { threadSearch } from "@/lib/open-param";
import { ChannelSkeleton } from "@/pages/ChannelPage";
import { DmPage } from "@/pages/DmPage";

/**
 * The person's chat with the workspace's PO about one company (ADR 0185). With no PO, or a company that is not one of
 * the live ones, the page says so instead of failing.
 */
export const Route = createFileRoute("/org/$orgId/po/$spaceId")({
  // `?m=<message>` opens the chat at that message (a search hit, a notice); `?thread=` is the one in its panel.
  validateSearch: (search: Record<string, unknown>): { m?: string } & ReturnType<typeof threadSearch> => ({
    ...threadSearch(search),
    ...(typeof search.m === "string" && search.m ? { m: search.m } : {}),
  }),
  component: function PoChat() {
    const { t } = useTranslation();
    const { orgId, spaceId } = Route.useParams();
    const overview = usePoOverview(orgId);
    const focus = Route.useSearch().m;
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
    if (!agentId || !companies.some((c) => c.id === spaceId))
      return (
        <main className="shell__main">
          <div className="page page--mid">
            <EmptyState icon="agent">{t("dm.poNone")}</EmptyState>
          </div>
        </main>
      );
    return <DmPage key={spaceId} target={{ agentId }} po={{ spaceId }} focusMessageId={focus} />;
  },
});
