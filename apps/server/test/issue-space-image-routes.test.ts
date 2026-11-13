import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

/** Smallest JPEG-shaped bytes (SOI, EXIF, scan, EOI). */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0x01, 0xff, 0xd9,
]);
const image = { imageBase64: Buffer.from(JPEG).toString("base64"), contentType: "image/jpeg" };

type Space = { id: string; name: string; color: string; image: string | null };

async function company(owner: ReturnType<typeof browser>, orgId: string, name = "Clínica Teo") {
  const made = await owner(`/api/app/organizations/${orgId}/issue-spaces`, { json: { name, color: "teal" } });
  expect(made.status).toBe(201);
  return (await made.json()) as Space;
}

test("the image routes set and remove a company's image and the list carries its address", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const space = await company(owner, orgId);
  expect(space.image).toBeNull();
  const api = `/api/app/organizations/${orgId}/issue-spaces/${space.id}/image`;

  const put = await owner(api, { method: "PUT", json: image });
  expect(put.status).toBe(200);
  const set = (await put.json()) as Space;
  expect(set.image).toStartWith(`/api/app/organizations/${orgId}/issue-space-images/`);
  expect(set.color).toBe("teal");

  const list = (await (await owner(`/api/app/organizations/${orgId}/issue-projects`)).json()) as { spaces: Space[] };
  expect(list.spaces.find((s) => s.id === space.id)?.image).toBe(set.image);

  const served = await owner(String(set.image));
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/jpeg");
  expect(served.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(new Uint8Array(await served.arrayBuffer())).includes(Buffer.from("Exif"))).toBe(false);

  const cleared = await owner(api, { method: "DELETE" });
  expect(cleared.status).toBe(200);
  expect(((await cleared.json()) as Space).image).toBeNull();
  expect((await owner(String(set.image))).status).toBe(404);
});

test("the image routes refuse another type or a file over 1 MiB with the limit, and keep the old image", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const space = await company(owner, orgId);
  const api = `/api/app/organizations/${orgId}/issue-spaces/${space.id}/image`;
  const first = (await (await owner(api, { method: "PUT", json: image })).json()) as Space;

  const svg = await owner(api, {
    method: "PUT",
    json: { imageBase64: Buffer.from("<svg/>").toString("base64"), contentType: "image/png" },
  });
  expect(svg.status).toBe(400);
  expect(await svg.json()).toMatchObject({ error: { code: "space_image.type", params: { maxMb: 1 } } });

  const big = new Uint8Array(1024 * 1024 + 1);
  big.set(JPEG);
  const over = await owner(api, {
    method: "PUT",
    json: { imageBase64: Buffer.from(big).toString("base64"), contentType: "image/jpeg" },
  });
  expect(over.status).toBe(400);
  expect(await over.json()).toMatchObject({ error: { code: "space_image.too_large", params: { maxMb: 1 } } });

  const list = (await (await owner(`/api/app/organizations/${orgId}/issue-projects`)).json()) as { spaces: Space[] };
  expect(list.spaces.find((s) => s.id === space.id)?.image).toBe(first.image);
});

test("serves the image only to members of its workspace", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const space = await company(owner, orgId);
  const put = await owner(`/api/app/organizations/${orgId}/issue-spaces/${space.id}/image`, {
    method: "PUT",
    json: image,
  });
  const url = String(((await put.json()) as Space).image);

  // A member of the workspace sees it.
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  expect((await ana(url)).status).toBe(200);

  // Signed out: no session.
  expect((await t.app.request(url)).status).toBe(401);
  // Invited, never accepted: signed up but not in the workspace.
  const invited = await owner(`/api/app/organizations/${orgId}/invitations`, {
    json: { email: "stranger@example.com", role: "member" },
  });
  expect(invited.status).toBe(201);
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  expect((await stranger(url)).status).toBe(404);
  expect((await stranger(`/api/app/organizations/${orgId}/issue-space-images/0123456789abcdef.jpg`)).status).toBe(404);

  // A stranger changes nothing.
  const api = `/api/app/organizations/${orgId}/issue-spaces/${space.id}/image`;
  expect((await stranger(api, { method: "PUT", json: image })).status).toBe(403);
  expect((await stranger(api, { method: "DELETE" })).status).toBe(403);
});
