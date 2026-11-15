import type { BlobStore, PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { readImage } from "./avatars";
import { ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { assertStorageRoom } from "./limits";
import { can, getMembership, requireActiveMembership } from "./organizations";
import { ROLE_COLORS } from "./permissions";
import { taskSeenSql } from "./task-access";

const { issueProjects, issueSpaces, issues } = schema;

/** A project's name holds at most this (the dialogs mirror it: packages/client/src/lib/issue-projects.ts). */
export const PROJECT_NAME_MAX = 80;
/** More than a workspace runs at once: the menu and the pickers stay a list someone can read. */
export const PROJECTS_MAX = 200;
/** A space's name holds at most this. */
export const SPACE_NAME_MAX = 80;
/** How many companies one workspace groups its boards into. */
export const SPACES_MAX = 100;

/** A company's image holds at most this (1 MiB): a mark, smaller than a photo (ADR 0180). */
export const SPACE_IMAGE_LIMITS = { maxBytes: 1024 * 1024 };

/** A space (a company, a client) as the boards menu shows it. */
export interface IssueSpaceRef {
  id: string;
  name: string;
  color: string;
  /** The image's address (served to the workspace's members); null: the color shows. */
  image: string | null;
  archived: boolean;
}

/** A space in the boards menu. `open`: the open tasks in its boards that the reader sees. */
export interface IssueSpaceView extends IssueSpaceRef {
  open: number;
}

/** A task's project as its card shows it. */
export interface IssueProjectRef {
  id: string;
  name: string;
  color: string;
  archived: boolean;
  /** The space it belongs to; null: a board outside any space. */
  spaceId: string | null;
}

/** A project in the projects menu. `open`: the open tasks in it that the reader sees. */
export interface IssueProjectView extends IssueProjectRef {
  open: number;
}

type ProjectRow = typeof issueProjects.$inferSelect;
type SpaceRow = typeof issueSpaces.$inferSelect;

export const projectRef = (p: ProjectRow): IssueProjectRef => ({
  id: p.id,
  name: p.name,
  color: p.color,
  archived: p.archivedAt !== null,
  spaceId: p.spaceId,
});

/** Where a company's image is served: `GET /api/app/organizations/{orgId}/issue-space-images/{file}`. */
export const spaceImageUrl = (orgId: string, file: string) =>
  `/api/app/organizations/${encodeURIComponent(orgId)}/issue-space-images/${file}`;

export const spaceRef = (s: SpaceRow): IssueSpaceRef => ({
  id: s.id,
  name: s.name,
  color: s.color,
  image: s.image ? spaceImageUrl(s.orgId, s.image) : null,
  archived: s.archivedAt !== null,
});

export interface ProjectDeps {
  db: Database;
  pubsub?: PubSub;
}

function cleanName(name: string) {
  const n = name.trim().replace(/\s+/g, " ").slice(0, PROJECT_NAME_MAX).trim();
  if (!n) throw new ValidationError("name is required");
  return n;
}

function checkColor(color: string | undefined) {
  if (color === undefined) return undefined;
  if (!(ROLE_COLORS as readonly string[]).includes(color)) throw new ValidationError("invalid color");
  return color;
}

const nameTaken = (name: string, space?: string | null) =>
  new ValidationError(
    space
      ? `This company already has a board named "${name}"`
      : `A board named "${name}" already exists outside every company`,
    "issue_project.name_taken",
    { name },
  );

/** Boards of one company (or of none) with this name, whatever its capitals: two companies may each have "Entregas". */
const byName = (orgId: string, name: string, spaceId: string | null = null) =>
  and(
    eq(issueProjects.orgId, orgId),
    spaceId ? eq(issueProjects.spaceId, spaceId) : isNull(issueProjects.spaceId),
    sql`lower(${issueProjects.name}) = lower(${name})`,
  );

/** Every board with this name in the workspace, whatever its company: what an agent's bare name may mean. */
const byNameAnywhere = (orgId: string, name: string) =>
  and(eq(issueProjects.orgId, orgId), sql`lower(${issueProjects.name}) = lower(${name})`);

/** The org's projects by name, archived ones last. */
async function projectRows(db: Database, orgId: string) {
  return db
    .select()
    .from(issueProjects)
    .where(eq(issueProjects.orgId, orgId))
    .orderBy(sql`${issueProjects.archivedAt} is not null`, asc(sql`lower(${issueProjects.name})`));
}

/** The org's spaces by name, archived ones last. */
async function spaceRows(db: Database, orgId: string) {
  return db
    .select()
    .from(issueSpaces)
    .where(eq(issueSpaces.orgId, orgId))
    .orderBy(sql`${issueSpaces.archivedAt} is not null`, asc(sql`lower(${issueSpaces.name})`));
}

/** The projects of these tasks, by project id. */
export async function projectsById(db: Database, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const rows = wanted.length ? await db.select().from(issueProjects).where(inArray(issueProjects.id, wanted)) : [];
  return new Map(rows.map((p) => [p.id, projectRef(p)]));
}

/**
 * The boards and the spaces that group them, with how many open tasks the reader sees in each, and how many open tasks
 * have no board (`unfiled`). The counts follow who sees each task, so a board never tells of work the reader can't
 * open, and a space's count is its boards' added up.
 */
export async function listIssueProjects(
  db: Database,
  userId: string,
  orgId: string,
): Promise<{ spaces: IssueSpaceView[]; projects: IssueProjectView[]; unfiled: number }> {
  await requireActiveMembership(db, userId, orgId);
  const [rows, spaceList, counts] = await Promise.all([
    projectRows(db, orgId),
    spaceRows(db, orgId),
    db
      .select({ projectId: issues.projectId, open: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.orgId, orgId),
          sql`${issues.status} not in ('done', 'canceled')`,
          taskSeenSql("issues", sql`${userId}::text`),
        ),
      )
      .groupBy(issues.projectId),
  ]);
  const open = new Map(counts.map((c) => [c.projectId, c.open]));
  const projects = rows.map((p) => ({ ...projectRef(p), open: open.get(p.id) ?? 0 }));
  const inSpace = new Map<string, number>();
  for (const p of projects) {
    if (p.spaceId) inSpace.set(p.spaceId, (inSpace.get(p.spaceId) ?? 0) + p.open);
  }
  return {
    spaces: spaceList.map((s) => ({ ...spaceRef(s), open: inSpace.get(s.id) ?? 0 })),
    projects,
    unfiled: open.get(null) ?? 0,
  };
}

async function announce(deps: ProjectDeps, orgId: string) {
  await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event: { type: "issue.projects" } });
}

/** A space of the org a board may join: an archived one takes no board, and neither does another org's. */
async function checkSpace(db: Database, orgId: string, spaceId: string | null | undefined) {
  if (spaceId === undefined || spaceId === null) return spaceId ?? null;
  const [space] = await db
    .select()
    .from(issueSpaces)
    .where(and(eq(issueSpaces.id, spaceId), eq(issueSpaces.orgId, orgId)));
  if (!space) throw new ValidationError("That space does not exist", "issue_space.not_found");
  if (space.archivedAt) throw new ValidationError("That space is archived", "issue_space.archived");
  return space.id;
}

async function insertProject(
  db: Database,
  orgId: string,
  input: { name: string; color?: string; spaceId?: string | null },
) {
  const name = cleanName(input.name);
  const color = checkColor(input.color) ?? "graphite";
  const spaceId = await checkSpace(db, orgId, input.spaceId);
  const [sameName, existing] = await Promise.all([
    db
      .select({ id: issueProjects.id })
      .from(issueProjects)
      .where(byName(orgId, name, spaceId ?? null)),
    db.select({ id: issueProjects.id }).from(issueProjects).where(eq(issueProjects.orgId, orgId)),
  ]);
  if (sameName.length > 0) throw nameTaken(name, spaceId ?? null);
  if (existing.length >= PROJECTS_MAX) {
    throw new ValidationError(`A workspace holds at most ${PROJECTS_MAX} projects`, "issue_project.too_many", {
      max: PROJECTS_MAX,
    });
  }
  // Two at once with one name: the unique index refuses the second.
  const [row] = await db
    .insert(issueProjects)
    .values({ orgId, name, color, spaceId })
    .onConflictDoNothing()
    .returning();
  if (!row) throw nameTaken(name);
  return row;
}

async function requirePoster(db: Database, userId: string, orgId: string) {
  const membership = await requireActiveMembership(db, userId, orgId);
  if (!can(membership, "post")) throw new ForbiddenError();
}

/** Whoever may create tasks may create, change and delete projects, as with the board's columns. */
export async function createIssueProject(
  deps: ProjectDeps,
  userId: string,
  orgId: string,
  input: { name: string; color?: string; spaceId?: string | null },
): Promise<IssueProjectView> {
  await requirePoster(deps.db, userId, orgId);
  const row = await insertProject(deps.db, orgId, input);
  await announce(deps, orgId);
  return { ...projectRef(row), open: 0 };
}

/** Renames, recolours, archives or brings back a project. */
export async function updateIssueProject(
  deps: ProjectDeps,
  userId: string,
  orgId: string,
  projectId: string,
  patch: { name?: string; color?: string; archived?: boolean; spaceId?: string | null },
): Promise<IssueProjectRef> {
  await requirePoster(deps.db, userId, orgId);
  const [current] = await deps.db
    .select()
    .from(issueProjects)
    .where(and(eq(issueProjects.id, projectId), eq(issueProjects.orgId, orgId)));
  if (!current) throw new NotFoundError("Project not found");
  const set: Partial<typeof issueProjects.$inferInsert> = {};
  // Moving a board between companies, or out of every company (`null`), is checked before a rename lands.
  if (patch.spaceId !== undefined) set.spaceId = await checkSpace(deps.db, orgId, patch.spaceId);
  const target = set.spaceId !== undefined ? (set.spaceId ?? null) : current.spaceId;
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (name !== current.name || target !== current.spaceId) {
      const [other] = await deps.db
        .select({ id: issueProjects.id })
        .from(issueProjects)
        .where(byName(orgId, name, target));
      if (other && other.id !== current.id) throw nameTaken(name, target);
      set.name = name;
    }
  }
  const color = checkColor(patch.color);
  if (color !== undefined) set.color = color;
  if (patch.archived !== undefined) set.archivedAt = patch.archived ? (current.archivedAt ?? new Date()) : null;
  if (Object.keys(set).length === 0) return projectRef(current);
  const [row] = await deps.db
    .update(issueProjects)
    .set(set)
    .where(eq(issueProjects.id, current.id))
    .returning()
    // Two renames to one name at once: the unique index refuses the second.
    .catch((error: unknown) => {
      throw isUniqueViolation(error) ? nameTaken(set.name ?? current.name, target) : error;
    });
  await announce(deps, orgId);
  return projectRef(row ?? current);
}

/** Deletes a project. Its tasks stay, with no project (the column's foreign key clears it). */
export async function deleteIssueProject(deps: ProjectDeps, userId: string, orgId: string, projectId: string) {
  await requirePoster(deps.db, userId, orgId);
  const gone = await deps.db
    .delete(issueProjects)
    .where(and(eq(issueProjects.id, projectId), eq(issueProjects.orgId, orgId)))
    .returning({ id: issueProjects.id });
  if (gone.length === 0) throw new NotFoundError("Project not found");
  await announce(deps, orgId);
}

const spaceNameTaken = (name: string) =>
  new ValidationError(`A space named "${name}" already exists`, "issue_space.name_taken", { name });

function cleanSpaceName(name: string) {
  const n = name.trim().replace(/\s+/g, " ").slice(0, SPACE_NAME_MAX).trim();
  if (!n) throw new ValidationError("name is required");
  return n;
}

const spaceByName = (orgId: string, name: string) =>
  and(eq(issueSpaces.orgId, orgId), sql`lower(${issueSpaces.name}) = lower(${name})`);

/**
 * A space (ADR 0174): the company, client or product line a workspace groups boards under. Whoever may create tasks
 * creates, renames, recolours, archives and deletes one, as with a board.
 */
export async function createIssueSpace(
  deps: ProjectDeps,
  userId: string,
  orgId: string,
  input: { name: string; color?: string },
): Promise<IssueSpaceView> {
  await requirePoster(deps.db, userId, orgId);
  const name = cleanSpaceName(input.name);
  const color = checkColor(input.color) ?? "graphite";
  const existing = await spaceRows(deps.db, orgId);
  if (existing.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw spaceNameTaken(name);
  if (existing.length >= SPACES_MAX) {
    throw new ValidationError(`A workspace holds at most ${SPACES_MAX} spaces`, "issue_space.too_many", {
      max: SPACES_MAX,
    });
  }
  // Two at once with one name: the unique index refuses the second.
  const [row] = await deps.db.insert(issueSpaces).values({ orgId, name, color }).onConflictDoNothing().returning();
  if (!row) throw spaceNameTaken(name);
  await announce(deps, orgId);
  return { ...spaceRef(row), open: 0 };
}

/** Renames, recolours, archives or brings back a space. Its boards and their tasks stay as they are. */
export async function updateIssueSpace(
  deps: ProjectDeps,
  userId: string,
  orgId: string,
  spaceId: string,
  patch: { name?: string; color?: string; archived?: boolean },
): Promise<IssueSpaceRef> {
  await requirePoster(deps.db, userId, orgId);
  const [current] = await deps.db
    .select()
    .from(issueSpaces)
    .where(and(eq(issueSpaces.id, spaceId), eq(issueSpaces.orgId, orgId)));
  if (!current) throw new NotFoundError("Space not found");
  const set: Partial<typeof issueSpaces.$inferInsert> = {};
  if (patch.name !== undefined) {
    const name = cleanSpaceName(patch.name);
    if (name !== current.name) {
      const [other] = await deps.db.select({ id: issueSpaces.id }).from(issueSpaces).where(spaceByName(orgId, name));
      if (other && other.id !== current.id) throw spaceNameTaken(name);
      set.name = name;
    }
  }
  const color = checkColor(patch.color);
  if (color !== undefined) set.color = color;
  if (patch.archived !== undefined) set.archivedAt = patch.archived ? (current.archivedAt ?? new Date()) : null;
  if (Object.keys(set).length === 0) return spaceRef(current);
  const [row] = await deps.db
    .update(issueSpaces)
    .set(set)
    .where(eq(issueSpaces.id, current.id))
    .returning()
    // Two renames to one name at once: the unique index refuses the second.
    .catch((error: unknown) => {
      throw isUniqueViolation(error) ? spaceNameTaken(set.name ?? current.name) : error;
    });
  await announce(deps, orgId);
  return spaceRef(row ?? current);
}

/** Deletes a space. Its boards stay, in no space, with their tasks (the boards' foreign key clears it). */
export async function deleteIssueSpace(deps: ProjectDeps, userId: string, orgId: string, spaceId: string) {
  await requirePoster(deps.db, userId, orgId);
  const gone = await deps.db
    .delete(issueSpaces)
    .where(and(eq(issueSpaces.id, spaceId), eq(issueSpaces.orgId, orgId)))
    .returning({ id: issueSpaces.id });
  if (gone.length === 0) throw new NotFoundError("Space not found");
  await announce(deps, orgId);
}

/**
 * Sets a company's image (`PUT …/issue-spaces/{spaceId}/image`): JPEG, PNG or WebP up to 1 MiB, checked by its bytes
 * and stripped of metadata as a photo is, so an unreadable file is refused before anything is stored and the old image
 * stays. It goes to the platform bucket under the workspace's storage limits (ADR 0079), served to the workspace's
 * members by `spaceImageFile`. The app crops it square (512×512) before sending.
 */
export async function setSpaceImage(
  deps: ProjectDeps & { blobs: BlobStore },
  userId: string,
  orgId: string,
  spaceId: string,
  input: { imageBase64: string; contentType: string },
): Promise<IssueSpaceRef> {
  await requirePoster(deps.db, userId, orgId);
  const [current] = await deps.db
    .select()
    .from(issueSpaces)
    .where(and(eq(issueSpaces.id, spaceId), eq(issueSpaces.orgId, orgId)));
  if (!current) throw new NotFoundError("Space not found");
  const { body, type, file } = readImage(input, "space_image", SPACE_IMAGE_LIMITS.maxBytes);
  if (file !== current.image) {
    await assertStorageRoom(deps.db, orgId, body.byteLength);
    await deps.blobs.put(spaceImageKey(orgId, file), body, { contentType: type });
  }
  const [row] = await deps.db
    .update(issueSpaces)
    .set({ image: file })
    .where(eq(issueSpaces.id, current.id))
    .returning();
  await removeStoredSpaceImage(deps, orgId, current.image, file);
  await announce(deps, orgId);
  return spaceRef(row ?? current);
}

/** Removes a company's image (`DELETE …/issue-spaces/{spaceId}/image`): the color shows again. */
export async function clearSpaceImage(
  deps: ProjectDeps & { blobs: BlobStore },
  userId: string,
  orgId: string,
  spaceId: string,
): Promise<IssueSpaceRef> {
  await requirePoster(deps.db, userId, orgId);
  const [current] = await deps.db
    .select()
    .from(issueSpaces)
    .where(and(eq(issueSpaces.id, spaceId), eq(issueSpaces.orgId, orgId)));
  if (!current) throw new NotFoundError("Space not found");
  if (current.image === null) return spaceRef(current);
  const [row] = await deps.db
    .update(issueSpaces)
    .set({ image: null })
    .where(eq(issueSpaces.id, current.id))
    .returning();
  await removeStoredSpaceImage(deps, orgId, current.image, null);
  await announce(deps, orgId);
  return spaceRef(row ?? current);
}

/**
 * A company's stored image for `GET …/issue-space-images/{file}`: only for the workspace's members (a person of
 * another workspace, or none, is told it isn't there).
 */
export async function spaceImageFile(
  deps: { db: Database; blobs: BlobStore },
  viewerId: string,
  orgId: string,
  file: string,
) {
  if (!/^[0-9a-f]{16}\.(jpg|png|webp)$/.test(file)) throw new NotFoundError("Not found");
  if (!(await getMembership(deps.db, viewerId, orgId))) throw new NotFoundError("Not found");
  const [using] = await deps.db
    .select({ id: issueSpaces.id })
    .from(issueSpaces)
    .where(and(eq(issueSpaces.orgId, orgId), eq(issueSpaces.image, file)))
    .limit(1);
  if (!using) throw new NotFoundError("Not found");
  const object = await deps.blobs.get(spaceImageKey(orgId, file));
  if (!object) throw new NotFoundError("Not found");
  return object;
}

const spaceImageKey = (orgId: string, file: string) => `issue-space-images/${orgId}/${file}`;

/** The replaced image's file goes, unless another company of the workspace holds the same picture. */
async function removeStoredSpaceImage(
  deps: { db: Database; blobs: BlobStore },
  orgId: string,
  old: string | null,
  keep: string | null,
) {
  if (!old || old === keep) return;
  const [shared] = await deps.db
    .select({ id: issueSpaces.id })
    .from(issueSpaces)
    .where(and(eq(issueSpaces.orgId, orgId), eq(issueSpaces.image, old)))
    .limit(1);
  if (shared) return;
  await deps.blobs.delete(spaceImageKey(orgId, old)).catch(() => undefined);
}

/** A project of the org a task may take: an archived one takes no new tasks. */
export async function projectForTask(db: Database, orgId: string, projectId: string) {
  const [project] = await db
    .select()
    .from(issueProjects)
    .where(and(eq(issueProjects.id, projectId), eq(issueProjects.orgId, orgId)));
  if (!project) throw new ValidationError("That project does not exist", "issue_project.not_found");
  if (project.archivedAt) throw new ValidationError("That project is archived", "issue_project.archived");
  return project;
}

/**
 * The project an agent named, in any capitals. An unknown name is refused with the names that exist, so a typo never
 * starts a second project. `new`: the person asked for a new one, so an unknown name is made on the spot. `list`: only
 * read, so an archived one will do. Otherwise an archived project is refused: it takes no new task.
 */
export async function projectByName(
  deps: ProjectDeps,
  orgId: string,
  name: string,
  mode: "task" | "new" | "list" = "task",
  spaceId: string | null = null,
) {
  const wanted = cleanName(name);
  // Two companies may each have an "Entregas" (ADR 0178): with a company, that one; without, the only one or none.
  const candidates = await deps.db
    .select()
    .from(issueProjects)
    .where(spaceId ? byName(orgId, wanted, spaceId) : byNameAnywhere(orgId, wanted));
  if (candidates.length > 1) {
    const spaces = await spaceRows(deps.db, orgId);
    const where = (p: ProjectRow) => {
      const space = spaces.find((s) => s.id === p.spaceId);
      return space ? `${space.name} › ${p.name}` : p.name;
    };
    throw new ValidationError(
      `More than one board is named "${wanted}": ${candidates.map(where).join(", ")}. Say which company it is (company), or use the board's id.`,
      "issue_project.ambiguous",
      { name: wanted },
    );
  }
  const [found] = candidates;
  if (found?.archivedAt && mode !== "list") {
    throw new ValidationError(
      `The project "${found.name}" is archived and takes no new task. A person brings it back from its board.`,
      "issue_project.archived",
    );
  }
  if (found) return found;
  if (mode === "new") {
    const row = await insertProject(deps.db, orgId, { name: wanted, spaceId: spaceId ?? null });
    await announce(deps, orgId);
    return row;
  }
  const spaces = await spaceRows(deps.db, orgId);
  const names = (await projectRows(deps.db, orgId))
    .filter((p) => !p.archivedAt)
    .map((p) => {
      const space = spaces.find((s) => s.id === p.spaceId);
      return space ? `"${p.name}" (${space.name})` : `"${p.name}"`;
    });
  const message = names.length
    ? `There is no project named "${wanted}". The projects are: ${names.join(", ")}. Use one of them, or set new_project only when the person asked for a new project.`
    : `There is no project named "${wanted}", and no projects yet. Set new_project only when the person asked for a new project.`;
  throw new ValidationError(message, "issue_project.unknown");
}
