import { AGENT_COLORS } from "@agenteschat/tokens/look";
import { ApiError } from "../api/http";
import type { IssueProject, IssueProjectRef, IssueSpace, IssueSpaceRef } from "../api/types";
import { isUuid } from "./format";

/** A project's name holds at most this (mirror of `PROJECT_NAME_MAX`, packages/engine/src/issue-projects.ts). */
export const PROJECT_NAME_MAX = 80;

/** A space's name holds at most this (mirror of `SPACE_NAME_MAX`, packages/engine/src/issue-projects.ts). */
export const SPACE_NAME_MAX = 80;

/** A company's image holds at most this (mirror of `SPACE_IMAGE_LIMITS`, packages/engine/src/issue-projects.ts). */
export const SPACE_IMAGE_MAX_BYTES = 1024 * 1024;

/** The types a company's image takes (the server reads its bytes: this only spares a round trip). */
export const SPACE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * What the server would refuse in an image about to be sent (base64, as the crop made it), as the same error it
 * answers with, so the dialog says it in the same words: another type, or over 1 MiB. Null: fine to send.
 */
export function spaceImageRefusal(image: { imageBase64: string; contentType: string }): ApiError | null {
  const params = { maxMb: SPACE_IMAGE_MAX_BYTES / (1024 * 1024) };
  if (!SPACE_IMAGE_TYPES.includes(image.contentType))
    return new ApiError(400, "space_image.type", "Use a JPEG, PNG or WebP image", params);
  const padding = /=*$/.exec(image.imageBase64)?.[0].length ?? 0;
  if ((image.imageBase64.length * 3) / 4 - padding > SPACE_IMAGE_MAX_BYTES)
    return new ApiError(400, "space_image.too_large", "The image is over 1 MB", params);
  return null;
}

/** The colors a project can take: the roles' (mirror of `ROLE_COLORS`, packages/engine/src/permissions.ts). */
export const PROJECT_COLORS = AGENT_COLORS.filter((c) => c !== "sky");

/** In a project filter and its URL: the tasks with no project. */
export const NO_PROJECT = "none";

/** A project filter from a URL or a stored value: a project's id, `none`, or nothing. */
export const projectFilterOf = (value: unknown): string | undefined =>
  typeof value === "string" && (value === NO_PROJECT || isUuid(value)) ? value : undefined;

/**
 * The projects a task can take: the ones in use, plus the one it already has when that one is archived (so the
 * picker still names it).
 */
export function pickableProjects<P extends IssueProjectRef>(projects: P[], current?: IssueProjectRef | null) {
  const live = projects.filter((p) => !p.archived);
  if (!current?.archived || live.some((p) => p.id === current.id)) return live;
  return [...live, ...projects.filter((p) => p.id === current.id)];
}

/** A project filter's rows in order: the projects in use, the tasks with none (`null`), then the archived ones. */
export const projectFilterRows = <P extends IssueProjectRef>(projects: P[]): (P | null)[] => [
  ...projects.filter((p) => !p.archived),
  null,
  ...projects.filter((p) => p.archived),
];

/** A picked filter while it still means something: `none`, or a project that exists. Else every task (""). */
export const liveProjectFilter = (projects: IssueProjectRef[], picked: string) =>
  picked === NO_PROJECT || projects.some((p) => p.id === picked) ? picked : "";

/** The project a filter names, when it is one that still exists. */
export const projectOfFilter = (projects: IssueProject[] | undefined, filter: string | undefined) =>
  filter && filter !== NO_PROJECT ? (projects?.find((p) => p.id === filter) ?? null) : null;

/** A space filter from a URL or a stored value: a space's id, or nothing. */
export const spaceFilterOf = (value: unknown): string | undefined =>
  typeof value === "string" && isUuid(value) ? value : undefined;

/** The space a filter names, when it is one that still exists. */
export const spaceOfFilter = (spaces: IssueSpace[] | undefined, filter: string | undefined) =>
  filter ? (spaces?.find((s) => s.id === filter) ?? null) : null;

/**
 * A board filter's rows in order: each space's boards under the space's name, the boards in no space, the tasks with
 * none (`null`), then the archived ones. The reader sees a company as a heading, as they do in any tracker.
 */
export function boardFilterRows<P extends IssueProjectRef>(
  projects: P[],
  spaces: IssueSpaceRef[] | undefined,
): { rows: P[]; group: string | null }[] {
  const live = projects.filter((p) => !p.archived);
  const out: { rows: P[]; group: string | null }[] = [];
  const push = (group: string | null, rows: P[]) => {
    if (rows.length > 0) out.push({ rows, group });
  };
  const known = new Set((spaces ?? []).map((s) => s.id));
  for (const space of spaces ?? []) {
    if (space.archived) continue;
    push(
      space.name,
      live.filter((p) => p.spaceId === space.id),
    );
  }
  // A board whose space was deleted, and one that never had one, sit together under no heading.
  push(
    null,
    live.filter((p) => !p.spaceId || !known.has(p.spaceId)),
  );
  push(
    null,
    projects.filter((p) => p.archived),
  );
  return out;
}

/**
 * How a board is written where the company isn't already the heading: its own name, and its company's before it when
 * two boards of the workspace share that name (ADR 0222: two companies may each have an "Entregas").
 */
export function boardLabels(
  projects: IssueProjectRef[],
  spaces: IssueSpaceRef[] | undefined,
): (project: IssueProjectRef) => string {
  const seen = new Map<string, number>();
  for (const p of projects) seen.set(p.name.toLowerCase(), (seen.get(p.name.toLowerCase()) ?? 0) + 1);
  return (project) => {
    if ((seen.get(project.name.toLowerCase()) ?? 0) < 2) return project.name;
    const space = spaces?.find((s) => s.id === project.spaceId);
    return space ? `${space.name} › ${project.name}` : project.name;
  };
}
