import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import type { Agent } from "./agents";
import { audienceError, canTalkTo, speakerOf } from "./audience";
import { caches } from "./cache";
import { sha256 } from "./crypto";
import { keyOf, reopenDm } from "./dms";
import { NotFoundError, ValidationError } from "./errors";
import { publishUserEvent } from "./events";
import { type IssueSpaceRef, listIssueProjects, spaceRef } from "./issue-projects";
import { can, requirePermission } from "./organizations";
import { closedRefusal } from "./standing";

const { agents, channelMembers, channels, issueSpaces, organizationSettings } = schema;

/**
 * A PO chat is the DM between a person and the workspace's PO about one company (ADR 0185): a DM whose key carries a
 * third part, `s:<company>`, so each company has its own history and no table or column is added. Keys sort, so the
 * form is always `a:<po>|s:<company>|u:<person>`.
 */
export const poChatKey = (poAgentId: string, spaceId: string, userId: string) =>
  keyOf([`a:${poAgentId}`, `s:${spaceId}`, `u:${userId}`]);

/** What a PO chat's key names; null for any other key (a plain DM, an agents' DM, a routine room). */
export function parsePoChatKey(
  dmKey: string | null | undefined,
): { agentId: string; spaceId: string; userId: string } | null {
  const parts = (dmKey ?? "").split("|");
  if (parts.length !== 3) return null;
  const [a, s, u] = parts;
  if (!a?.startsWith("a:") || !s?.startsWith("s:") || !u?.startsWith("u:")) return null;
  const agentId = a.slice(2);
  const spaceId = s.slice(2);
  const userId = u.slice(2);
  if (!agentId || !spaceId || !userId) return null;
  return { agentId, spaceId, userId };
}

export const isPoChatKey = (dmKey: string | null | undefined) => parsePoChatKey(dmKey) !== null;

/** True for the channels that are PO chats (every other DM key has no `s:` part): what `listDms` leaves out. */
export const poChatKeyLike = sql`coalesce(${channels.dmKey}, '') like '%|s:%'`;

/**
 * The workspace's PO: the agent in `organization_settings.po_agent_id`; null when none is set or it was archived or
 * deleted (a PO that goes reads as none).
 */
export async function poAgentOf(db: Database, orgId: string): Promise<Agent | null> {
  const [row] = await db
    .select({ agent: agents })
    .from(organizationSettings)
    .innerJoin(agents, eq(agents.id, organizationSettings.poAgentId))
    .where(
      and(
        eq(organizationSettings.orgId, orgId),
        eq(agents.orgId, orgId),
        isNull(agents.archivedAt),
        isNull(agents.deletedAt),
      ),
    );
  return row?.agent ?? null;
}

export type PoCompany = IssueSpaceRef & { open: number; channelId: string | null };

/**
 * The PO and the companies a PO chat can be opened for: the live ones (every active member sees every company), with
 * how many open cards the person sees and their existing chat for it, which search needs to place a hit. No PO: no
 * agent and no companies.
 */
export async function listPoCompanies(
  db: Database,
  userId: string,
  orgId: string,
): Promise<{ agentId: string | null; companies: PoCompany[] }> {
  const [po, listing] = await Promise.all([poAgentOf(db, orgId), listIssueProjects(db, userId, orgId)]);
  if (!po) return { agentId: null, companies: [] };
  const live = listing.spaces.filter((s) => !s.archived);
  const keys = live.map((s) => poChatKey(po.id, s.id, userId));
  const chats = keys.length
    ? await db
        .select({ id: channels.id, dmKey: channels.dmKey })
        .from(channels)
        .where(and(eq(channels.orgId, orgId), inArray(channels.dmKey, keys)))
    : [];
  const byKey = new Map(chats.map((c) => [c.dmKey, c.id]));
  return {
    agentId: po.id,
    companies: live.map((s, i) => ({ ...s, channelId: byKey.get(keys[i] as string) ?? null })),
  };
}

/**
 * Opens the person's PO chat for one company (ADR 0185): their DM with the PO, made the first time and the same one
 * after, its key ending in the company. It follows `openDm`: the person's right to post, the PO's audience, a
 * workspace being deleted opens only what it has, an archived chat comes back.
 */
export async function openPoChat(
  db: Database,
  actorId: string,
  orgId: string,
  spaceId: string,
  options: { pubsub?: PubSub } = {},
): Promise<{ channelId: string; agentId: string; space: IssueSpaceRef }> {
  const membership = await requirePermission(db, actorId, orgId, "post");
  const po = await poAgentOf(db, orgId);
  if (!po) throw new ValidationError("This workspace has no PO agent", "po.none");
  const [space] = await db
    .select()
    .from(issueSpaces)
    .where(and(eq(issueSpaces.id, spaceId), eq(issueSpaces.orgId, orgId)));
  if (!space) throw new NotFoundError("Company not found");
  if (space.archivedAt) throw new ValidationError("That company is archived", "issue_space.archived");

  const dmKey = poChatKey(po.id, space.id, actorId);
  const existing = async () =>
    (
      await db
        .select()
        .from(channels)
        .where(and(eq(channels.orgId, orgId), eq(channels.dmKey, dmKey)))
    )[0];
  const found = await existing();
  const answer = (channelId: string) => ({ channelId, agentId: po.id, space: spaceRef(space) });
  const closed = closedRefusal(membership.standing);
  if (closed) {
    if (!found) throw closed;
    return answer(found.id);
  }
  // A new chat with a PO this person can't talk to isn't started (unless they manage agents); an old one stays readable.
  if (!found && !canTalkTo(po, actorId, speakerOf(membership)) && !can(membership, "manage_agents"))
    throw await audienceError(db, po);
  if (found) await reopenDm(db, orgId, found);
  const created = found
    ? null
    : await db.transaction(async (tx) => {
        const [channel] = await tx
          .insert(channels)
          .values({
            orgId,
            name: `dm-${sha256(`${orgId}|${dmKey}`).slice(0, 20)}`,
            visibility: "private",
            kind: "dm",
            dmKey,
            createdByUserId: actorId,
          })
          .onConflictDoNothing()
          .returning();
        if (!channel) return null;
        await tx.insert(channelMembers).values({ orgId, channelId: channel.id, userId: actorId });
        await tx.insert(channelMembers).values({ orgId, channelId: channel.id, agentId: po.id });
        return channel;
      });
  if (created) caches.scopes.deletePrefix(`${orgId}:${po.id}:visible`);
  const channel = found ?? created ?? (await existing()); // a concurrent open won the race
  if (!channel) throw new Error("could not open the conversation");
  if (created || found?.archivedAt)
    await publishUserEvent(options.pubsub, orgId, actorId, { type: "channels.changed" });
  return answer(channel.id);
}

/**
 * The company a conversation is a PO chat of (ADR 0185), read from the channel's key through the per-process channel
 * cache: the one thing the PO's tools and context ask. Null in any other conversation, so no other chat changes.
 */
export async function poScopeOf(
  db: Database,
  orgId: string,
  channelId: string,
): Promise<{ spaceId: string; name: string } | null> {
  // The channel cache `getChannelCached` fills (same key and loader): `context.ts` can't be imported from here without
  // a cycle through the wiki's search registration.
  const channel = (await caches.channels.getOrLoad(`${orgId}:${channelId}`, async () => {
    const [row] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
    return row ?? null;
  })) as typeof channels.$inferSelect | null;
  const key = channel?.kind === "dm" ? parsePoChatKey(channel.dmKey) : null;
  if (!key) return null;
  const [space] = await db
    .select({ id: issueSpaces.id, name: issueSpaces.name })
    .from(issueSpaces)
    .where(and(eq(issueSpaces.id, key.spaceId), eq(issueSpaces.orgId, orgId)));
  return space ? { spaceId: space.id, name: space.name } : null;
}
