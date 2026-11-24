import { STORAGE_KEYS, storage } from "./storage";

/** Where the person's PO view opened last, per person and workspace (a convenience of this browser, ADR 0229). */
const keyOf = (userId: string, orgId: string) => `${STORAGE_KEYS.poCompany}.${userId}.${orgId}`;

/** The company the person's PO view opened last in this workspace, or null (nothing kept, or storage blocked). */
export const rememberedPoCompany = (userId: string, orgId: string) => storage.get(keyOf(userId, orgId));

/** Keeps `spaceId` as the company the next opening of the PO view shows. */
export const rememberPoCompany = (userId: string, orgId: string, spaceId: string) =>
  storage.set(keyOf(userId, orgId), spaceId);

/** The company the PO view opens on: the one kept while it is still live, else the first, else null with none. */
export function poLanding(companies: readonly { id: string }[], kept: string | null): string | null {
  return companies.find((c) => c.id === kept)?.id ?? companies[0]?.id ?? null;
}
