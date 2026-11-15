import type { DmTarget } from "@agenteschat/client";
import { addDm, useOpenPoChat, usePoOverview } from "@agenteschat/client";
import { audienceNotice, canTalk, seesDetails } from "@agenteschat/client/lib/audience";
import { greetingSuggestions } from "@agenteschat/client/lib/chat";
import { isGone } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { isRightHand, rightHandSeenKey } from "@agenteschat/client/lib/right-hand";
import { Avatar, BrainIcon, Button, EmptyState, ProviderLogo, Select } from "@agenteschat/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AudienceChip } from "@/components/AgentAudience";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentSetupIntro, useSetupSteps } from "@/components/AgentSetup";
import { useAgentPanelShown, useOpenAgentPanel } from "@/components/agent-panel-context";
import { ComputerButton } from "@/components/computer/ComputerDialog";
import { ErrorState } from "@/components/Loading";
import { NavToggle } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { ProfileTrigger } from "@/components/ProfileCard";
import { LetMeTalkButton } from "@/components/ReachLines";
import { RightHandIntro } from "@/components/RightHandIntro";
import { HeaderSearch } from "@/components/search/HeaderSearch";
import { AgentTasksPill } from "@/components/tasks/AgentTasksPanel";
import { useAgentThinks } from "@/hooks/useAgentThinks";
import { useDirectory } from "@/hooks/useDirectory";
import { rightHandSeen } from "@/lib/storage";
import { ChannelPage, ChannelSkeleton, type DmSideControl } from "./ChannelPage";
import { SpaceMark } from "./IssueProjects";

/**
 * A direct message with an agent or a person: the channel layout with its own header and empty state. With `po`, the
 * person's chat with that agent about one company (ADR 0185): opened for the company, each company its own history.
 */
export function DmPage({
  target,
  focusMessageId,
  po,
}: {
  target: DmTarget;
  focusMessageId?: string;
  po?: { spaceId: string };
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory(org.id);
  const kind = "agentId" in target ? "agent" : "person";
  const id = "agentId" in target ? target.agentId : target.userId;
  const openPo = useOpenPoChat(org.id);
  const dm = useQuery({
    queryKey: po ? ["org", org.id, "dm", kind, id, po.spaceId] : ["org", org.id, "dm", kind, id],
    queryFn: async () => {
      // A PO chat is no row of the DM list: it opens through the company's own route.
      if (po) return { channelId: (await openPo.mutateAsync(po.spaceId)).channelId };
      const res = await api.dms.open(org.id, target);
      // A DM opened for the first time is in the DM list from its own answer: its search holds to it.
      if (res.dm) addDm(qc, org.id, res.dm);
      return res;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  const agent = "agentId" in target ? dir.agentById.get(target.agentId) : undefined;
  const person = "userId" in target ? dir.memberById.get(target.userId) : undefined;
  const name = agent?.name ?? person?.name ?? "";
  const rightHand = isRightHand(agent);
  const thinks = useAgentThinks(agent);
  // A new agent's setup checklist (ADR 0155 §2) for whoever sets it up: its greeting and the checklist on top.
  const setup = useSetupSteps(agent).length > 0;
  // Its DM is open, from its row or any other way in: its row's "Novo" goes.
  useEffect(() => {
    if (rightHand) rightHandSeen.mark(rightHandSeenKey(me.user.id, org.id));
  }, [rightHand, me.user.id, org.id]);

  if (dm.isError) {
    // An old link to an archived agent, or to someone who left: gone, said as the agent's and channel's pages say it.
    const toAgent = "agentId" in target;
    return (
      <main className="shell__main">
        <div className="page page--mid">
          {isGone(dm.error) ? (
            <EmptyState icon={toAgent ? "agent" : "person"}>
              {toAgent ? t("agent.notFound") : t("errors.said.notInWorkspace")}
            </EmptyState>
          ) : (
            <ErrorState error={dm.error} onRetry={() => void dm.refetch()} />
          )}
        </div>
      </main>
    );
  }
  if (!dm.data || dir.loading) return <ChannelSkeleton dm={kind} />;

  const owner = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const role = agent ? agent.role || `@${agent.handle}` : "";
  // The right hand (ADR 0137) says what it is and whose permissions it acts with, never an owner, nor a model: each
  // person's DM with it thinks with their own AI, shown with its maker's logo in the side panel's Como pensa.
  const header = ({ onSearch, side }: { onSearch: () => void; side: DmSideControl | null }) => (
    <header className="channel__header">
      <NavToggle />
      {/* Who it is with and the header's glyphs: the glyphs go under a name that can't keep its line beside them. */}
      <div className="ac-actline channel__line">
        <DmWho agentId={agent?.id} userId={person?.userId} label={t("profile.of", { name })}>
          <div className="dm-who__text">
            {agent ? (
              <AgentAvatar agentId={agent.id} name={agent.name} />
            ) : (
              <Avatar name={name} imageUrl={person?.image} />
            )}
            <h1 className={agent || person ? "channel__title ac-captop" : "channel__title"}>
              <span className="channel__name">{name}</span>
              {agent && <AudienceChip agent={agent} />}
            </h1>
            {agent && po && (
              <span className="channel__topic">
                <PoTopic spaceId={po.spaceId} />
              </span>
            )}
            {agent && !po && (
              <span className="channel__topic" data-right-hand={rightHand || undefined}>
                {rightHand
                  ? `${t("rightHand.label")} · ${t("rightHand.actsAsYou")}`
                  : owner
                    ? t("dm.subtitle", { role, owner: owner.name })
                    : t("dm.subtitleNoOwner", { role })}
                {thinks?.text && !rightHand && (
                  <>
                    {" · "}
                    <span className="channel__brain ac-iconline">
                      {thinks.mark ? (
                        <ProviderLogo id={thinks.mark} size="xs" />
                      ) : (
                        <BrainIcon kind={thinks.kind} size={14} />
                      )}
                      {thinks.text}
                    </span>
                  </>
                )}
              </span>
            )}
            {person && <span className="channel__topic">{person.email}</span>}
          </div>
        </DmWho>
        <div className="channel__acts">
          {/* Its tasks (ADR 0128), while it has any: they open in the side panel. */}
          {agent && <AgentTasksPill />}
          {/* The sidebar has the computer: only a line of turns waiting for it still shows here. A viewer of its public
              card gets the sidebar's head alone, so the way in stays for one who may still watch the computer. */}
          {agent && !rightHand && <ComputerButton agent={agent} queueOnly={side?.docked && seesDetails(agent)} />}
          {/* The PO chat's company (ADR 0185): another company opens that company's own chat. */}
          {po && <PoCompanySwitch spaceId={po.spaceId} />}
          {/* The same field as a channel's, held to this DM. */}
          <HeaderSearch channelId={dm.data.channelId} onOpen={onSearch} dm />
          {side && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="sidebar"
              className="channel__icon dm-side-toggle"
              aria-label={t("agentSide.label")}
              aria-pressed={side.open}
              title={t(side.open ? "agentSide.hide" : "agentSide.show")}
              onClick={side.toggle}
            />
          )}
        </div>
      </div>
    </header>
  );
  return (
    <ChannelPage
      channelId={dm.data.channelId}
      focusMessageId={focusMessageId}
      fallback={{
        id: dm.data.channelId,
        name,
        topic: "",
        visibility: "private",
        isMember: true,
        createdAt: "",
      }}
      chrome={{
        header,
        composerTarget: name,
        ...(rightHand && agent
          ? {
              composerLabel: `${t("channel.composerDm", { name })} · ${t("rightHand.composerHint")}`,
              intro: <RightHandIntro agent={agent} channelId={dm.data.channelId} />,
            }
          : setup && agent
            ? { intro: <AgentSetupIntro agent={agent} /> }
            : {}),
        dmAgentId: agent?.id,
        dmPersonId: person?.userId,
        locked:
          agent && !canTalk(agent)
            ? audienceNotice(t, agent, (uid) => dir.memberById.get(uid)?.name, dir.roleName)
            : undefined,
        lockedAction: agent ? <LetMeTalkButton agent={agent} /> : undefined,
        emptyText: agent ? t("dm.emptyAgent", agentGrammar(agent.name)) : undefined,
        emptyTitle: agent ? t("chat.sayHiAgent", agentGrammar(agent.name)) : t("chat.sayHiPerson", { name }),
        suggestions: agent ? greetingSuggestions(t, agent.role) : [],
      }}
    />
  );
}

/** The line under the PO's name: which company this chat is about, whole, wrapping where it must. */
function PoTopic({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const company = usePoOverview(org.id).data?.companies.find((c) => c.id === spaceId);
  return <>{t("dm.poTopic", { company: company?.name ?? "" })}</>;
}

/** The live companies, the chat's own among them: picking one goes to that company's chat with the PO. */
function PoCompanySwitch({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const companies = usePoOverview(org.id).data?.companies ?? [];
  return (
    <Select
      size="sm"
      className="po-switch"
      aria-label={t("dm.poCompany")}
      value={spaceId}
      onValueChange={(next) => {
        if (next !== spaceId)
          void navigate({ to: "/org/$orgId/po/$spaceId", params: { orgId: org.id, spaceId: next } });
      }}
      options={companies.map((c) => ({ value: c.id, label: c.name, leading: <SpaceMark space={c} /> }))}
    />
  );
}

/**
 * Who the DM is with, as one button: an agent's page in the panel beside the conversation, a person's profile card
 * (as their name in a message opens). The button lies over the face and lines so the name stays the page's heading.
 */
function DmWho({
  agentId,
  userId,
  label,
  children,
}: {
  agentId?: string;
  userId?: string;
  label: string;
  children: ReactNode;
}) {
  const openPanel = useOpenAgentPanel();
  const shown = useAgentPanelShown();
  return (
    <div className="dm-who">
      {children}
      {agentId ? (
        <button
          type="button"
          className="profile-trigger dm-who__hit"
          aria-label={label}
          aria-expanded={shown === agentId}
          onClick={() => openPanel?.(agentId)}
        />
      ) : userId ? (
        <ProfileTrigger actor={{ type: "person", id: userId }} label={label} className="dm-who__hit">
          {null}
        </ProfileTrigger>
      ) : null}
    </div>
  );
}
