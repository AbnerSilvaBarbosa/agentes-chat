import { usePoOverview } from "@agenteschat/client";
import { isPaidReturn } from "@agenteschat/client/lib/billing";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { ErrorState } from "@/components/Loading";
import { agentPanelSearch, threadSearch } from "@/lib/open-param";
import { prefetchDm } from "@/lib/prefetch";
import { ChannelSkeleton } from "@/pages/ChannelPage";
import { DmPage } from "@/pages/DmPage";

/** Direct message with an agent (sidebar "Agentes"); the workspace's PO opens its PO view instead, its plain DM at a message (ADR 0229). */
export const Route = createFileRoute("/org/$orgId/dm/agent/$agentId")({
  // `?m=<message>` opens the DM at that message (a search hit); `?paid`: back from paying for the workspace (the hold
  // banner says the payment is being confirmed), where a new workspace opens its right hand's DM (ADR 0137); `?thread=`
  // is the one in its panel, `?agent=` the agent's page there instead.
  validateSearch: (
    search: Record<string, unknown>,
  ): { m?: string; paid?: true } & ReturnType<typeof threadSearch> & ReturnType<typeof agentPanelSearch> => ({
    ...threadSearch(search),
    ...agentPanelSearch(search),
    ...(typeof search.m === "string" && search.m ? { m: search.m } : {}),
    ...(isPaidReturn(search) ? { paid: true as const } : {}),
  }),
  // A DM already in my list opens with its messages read on the link's hover, and no round trip to find it.
  loader: ({ context: { queryClient, api }, params: { orgId, agentId } }) =>
    prefetchDm(queryClient, api, orgId, "agent", agentId),
  component: function AgentDm() {
    const { orgId, agentId } = Route.useParams();
    const focus = Route.useSearch().m;
    const po = usePoOverview(orgId);
    // The workspace's PO has no plain DM: its address opens the PO view (ADR 0229). The overview is read before any
    // agent's DM draws, so a PO's chat never shows for a moment.
    if (po.isError)
      return (
        <main className="shell__main">
          <div className="page page--mid">
            <ErrorState error={po.error} onRetry={() => void po.refetch()} />
          </div>
        </main>
      );
    if (!po.data) return <ChannelSkeleton dm="agent" />;
    // …but a link to one of its messages (a notice, a search hit) is its plain DM, where routines write, at that message.
    if (po.data.agentId === agentId)
      return focus ? (
        <Navigate to="/org/$orgId/po/general" params={{ orgId }} search={{ m: focus }} replace />
      ) : (
        <Navigate to="/org/$orgId/po" params={{ orgId }} replace />
      );
    return <DmPage key={agentId} target={{ agentId }} focusMessageId={focus} />;
  },
});
