import { and, type Database, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import type { Agent } from "./agents";
import { keyOf } from "./dms";
import { type IssueSpaceRef, listIssueProjects } from "./issue-projects";

const { agents, channels, organizationSettings } = schema;

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
