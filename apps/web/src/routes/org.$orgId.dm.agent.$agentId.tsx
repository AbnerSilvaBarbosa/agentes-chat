import { usePoOverview } from "@agenteschat/client";
import { isPaidReturn } from "@agenteschat/client/lib/billing";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { threadSearch } from "@/lib/open-param";
import { ChannelSkeleton } from "@/pages/ChannelPage";
import { DmPage } from "@/pages/DmPage";

/** Direct message with an agent (sidebar "Agentes"); the workspace's PO opens its PO view instead (ADR 0185). */
export const Route = createFileRoute("/org/$orgId/dm/agent/$agentId")({
  // `?m=<message>` opens the DM at that message (a search hit); `?paid`: back from paying for the workspace (the hold
  // banner says the payment is being confirmed), where a new workspace opens its right hand's DM (ADR 0137); `?thread=`
  // is the one in its panel.
  validateSearch: (search: Record<string, unknown>): { m?: string; paid?: true } & ReturnType<typeof threadSearch> => ({
    ...threadSearch(search),
    ...(typeof search.m === "string" && search.m ? { m: search.m } : {}),
    ...(isPaidReturn(search) ? { paid: true as const } : {}),
  }),
  component: function AgentDm() {
    const { orgId, agentId } = Route.useParams();
    const focus = Route.useSearch().m;
    const po = usePoOverview(orgId);
    // The workspace's PO has no plain DM: its address opens the PO view (ADR 0185). The overview is read before any
    // agent's DM draws, so a PO's chat never shows for a moment.
    if (!po.data && !po.isError) return <ChannelSkeleton dm="agent" />;
    if (po.data?.agentId === agentId) return <Navigate to="/org/$orgId/po" params={{ orgId }} replace />;
    return <DmPage key={agentId} target={{ agentId }} focusMessageId={focus} />;
  },
});
