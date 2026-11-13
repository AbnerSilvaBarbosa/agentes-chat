import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryBlobStore } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  AVATAR_LIMITS,
  clearSpaceImage,
  createIssueSpace,
  createOrganization,
  ForbiddenError,
  listIssueProjects,
  listRoles,
  NotFoundError,
  SPACE_IMAGE_LIMITS,
  setAvatar,
  setOrgLimits,
  setSpaceImage,
  spaceImageFile,
  updateRole,
  ValidationError,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "latin1")] : p)));
const seg = (marker: number, payload: string) => {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 0xff, ...Buffer.from(payload, "latin1")];
};
const JPEG = bytes(
  [0xff, 0xd8],
  seg(0xe1, "Exif\0\0GPS:-23.55,-46.63"),
  seg(0xdb, "quant-table"),
  [0xff, 0xda, 0x00, 0x04, 0x01, 0x02],
  "pixels",
  [0xff, 0xd9],
);
const chunk = (type: string, data: string) => {
  const len = data.length;
  return [
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...Buffer.from(type + data, "latin1"),
    0,
    0,
    0,
    0,
  ];
};
const PNG = bytes(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  chunk("IHDR", "\0\0\x02\0\0\0\x02\0\x08\x02\0\0\0"),
  chunk("tEXt", "Author\0Ana Souza"),
  chunk("IDAT", "pixels"),
  chunk("IEND", ""),
);
const WEBP = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8 ", [2, 0, 0, 0], "px");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const has = (b: Uint8Array, text: string) => Buffer.from(b).includes(Buffer.from(text, "latin1"));
/** An image of this many bytes that still reads as a JPEG. */
const padded = (size: number) => {
  const out = new Uint8Array(size);
  out.set(JPEG);
  return out;
};

async function company(name = "Clínica Teo") {
  const blobs = createMemoryBlobStore();
  const deps = { db: f.db, pubsub: f.pubsub, blobs };
  const space = await createIssueSpace(deps, f.owner.id, f.org.id, { name });
  return { deps, blobs, space };
}
const listed = async (spaceId: string) =>
  (await listIssueProjects(f.db, f.owner.id, f.org.id)).spaces.find((s) => s.id === spaceId);
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as ValidationError,
  );

describe("a company's image", () => {
  test("stores a PNG JPEG or WebP up to 1 MiB", async () => {
    f = await setup();
    const { deps, blobs, space } = await company();
    expect(space.image).toBeNull();

    for (const [data, type, ext] of [
      [JPEG, "image/jpeg", "jpg"],
      [PNG, "image/png", "png"],
      [WEBP, "image/webp", "webp"],
    ] as const) {
      const done = await setSpaceImage(deps, f.owner.id, f.org.id, space.id, {
        imageBase64: b64(data),
        contentType: type,
      });
      expect(done.image).toMatch(
        new RegExp(`^/api/app/organizations/${f.org.id}/issue-space-images/[0-9a-f]{16}\\.${ext}$`),
      );
      expect((await listed(space.id))?.image).toBe(done.image);
      const file = (done.image as string).split("/").at(-1) as string;
      expect((await spaceImageFile(deps, f.owner.id, f.org.id, file)).contentType).toBe(type);
      // Only the current picture stays in the bucket.
      expect([...blobs.objects.keys()]).toEqual([`issue-space-images/${f.org.id}/${file}`]);
    }

    // The limit is one MiB exactly, and the metadata never reaches the bucket.
    const edge = await setSpaceImage(deps, f.owner.id, f.org.id, space.id, {
      imageBase64: b64(padded(SPACE_IMAGE_LIMITS.maxBytes)),
      contentType: "image/jpeg",
    });
    expect(edge.image).toBeString();
    await setSpaceImage(deps, f.owner.id, f.org.id, space.id, { imageBase64: b64(JPEG), contentType: "image/jpeg" });
    const [stored] = [...blobs.objects.values()];
    expect(has((stored as { body: Uint8Array }).body, "GPS")).toBe(false);
  });

  test("refuses another type or over 1 MiB", async () => {
    f = await setup();
    const { deps, blobs, space } = await company();
    const set = (imageBase64: string, contentType: string) =>
      setSpaceImage(deps, f.owner.id, f.org.id, space.id, { imageBase64, contentType });

    const svg = await rejection(set(b64(bytes("<svg onload=alert(1)>")), "image/png"));
    expect(svg).toMatchObject({ code: "space_image.type", params: { maxMb: 1 } });
    const mislabelled = await rejection(set(b64(JPEG), "image/png"));
    expect(mislabelled).toMatchObject({ code: "space_image.type" });
    const gif = await rejection(set(b64(bytes("GIF89a....")), "image/gif"));
    expect(gif).toMatchObject({ code: "space_image.type" });
    const big = await rejection(set(b64(padded(SPACE_IMAGE_LIMITS.maxBytes + 1)), "image/jpeg"));
    expect(big).toMatchObject({ code: "space_image.too_large", params: { maxMb: 1 } });
    expect(blobs.objects.size).toBe(0);
    expect((await listed(space.id))?.image).toBeNull();
  });

  test("an unreadable image keeps the previous one", async () => {
    f = await setup();
    const { deps, blobs, space } = await company();
    const first = await setSpaceImage(deps, f.owner.id, f.org.id, space.id, {
      imageBase64: b64(PNG),
      contentType: "image/png",
    });
    const before = [...blobs.objects.keys()];

    for (const [imageBase64, contentType] of [
      ["not base64!", "image/png"],
      ["", "image/png"],
      [b64(bytes("<html>not a picture</html>")), "image/png"],
      [b64(padded(SPACE_IMAGE_LIMITS.maxBytes + 1)), "image/jpeg"],
    ] as const) {
      expect(
        await rejection(setSpaceImage(deps, f.owner.id, f.org.id, space.id, { imageBase64, contentType })),
      ).toBeInstanceOf(ValidationError);
    }
    expect((await listed(space.id))?.image).toBe(first.image);
    expect([...blobs.objects.keys()]).toEqual(before);
    expect(
      (await spaceImageFile(deps, f.owner.id, f.org.id, (first.image as string).split("/").at(-1) as string)).body,
    ).toBeTruthy();
  });

  test("removing the image brings the color back", async () => {
    f = await setup();
    const { deps, blobs, space } = await company();
    await f.db.update(schema.issueSpaces).set({ color: "teal" }).where(eq(schema.issueSpaces.id, space.id));
    await setSpaceImage(deps, f.owner.id, f.org.id, space.id, { imageBase64: b64(PNG), contentType: "image/png" });
    expect((await listed(space.id))?.image).toBeString();

    const cleared = await clearSpaceImage(deps, f.owner.id, f.org.id, space.id);
    expect(cleared).toMatchObject({ image: null, color: "teal" });
    expect(await listed(space.id)).toMatchObject({ image: null, color: "teal" });
    expect(blobs.objects.size).toBe(0);
    // Nothing to remove is not an error.
    expect((await clearSpaceImage(deps, f.owner.id, f.org.id, space.id)).image).toBeNull();
  });

  test("a member who may not create tasks, or a stranger, is refused", async () => {
    f = await setup();
    const { deps, space } = await company();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const base = (await listRoles(f.db, f.owner.id, f.org.id)).roles.find((r) => r.kind === "everyone");
    if (!base) throw new Error("no base role");
    await updateRole(f.db, f.owner.id, f.org.id, base.id, {
      permissions: base.permissions.filter((k) => k !== "post"),
    });
    const input = { imageBase64: b64(PNG), contentType: "image/png" };

    await expect(setSpaceImage(deps, bia.id, f.org.id, space.id, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(clearSpaceImage(deps, bia.id, f.org.id, space.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setSpaceImage(deps, "someone-else", f.org.id, space.id, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setSpaceImage(deps, f.owner.id, f.org.id, crypto.randomUUID(), input)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await listed(space.id))?.image).toBeNull();
  });

  test("is served only to members of its workspace", async () => {
    f = await setup();
    const { deps, space } = await company();
    const done = await setSpaceImage(deps, f.owner.id, f.org.id, space.id, {
      imageBase64: b64(PNG),
      contentType: "image/png",
    });
    const file = (done.image as string).split("/").at(-1) as string;
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const zed = await addUser(f.db, "zed");
    const other = await createOrganization(f.db, zed.id, { name: "Other" });

    expect((await spaceImageFile(deps, bia.id, f.org.id, file)).contentType).toBe("image/png");
    await expect(spaceImageFile(deps, zed.id, f.org.id, file)).rejects.toBeInstanceOf(NotFoundError);
    // The same file name asked under another workspace is not there either.
    await expect(spaceImageFile({ ...deps }, zed.id, other.organization.id, file)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(spaceImageFile(deps, f.owner.id, f.org.id, "../x.png")).rejects.toBeInstanceOf(NotFoundError);
  });

  test("goes through the workspace's storage limit", async () => {
    f = await setup();
    const { deps, blobs, space } = await company();
    await setOrgLimits(f.db, f.org.id, {
      members: null,
      membersMax: null,
      payerUserId: null,
      storageBytes: 10,
      uploadBytesPerDay: null,
      platformUsdPerMonth: null,
    });
    await expect(
      setSpaceImage(deps, f.owner.id, f.org.id, space.id, { imageBase64: b64(PNG), contentType: "image/png" }),
    ).rejects.toMatchObject({ code: "storage.full" });
    expect(blobs.objects.size).toBe(0);
  });

  test("two companies holding one picture keep it when one lets go", async () => {
    f = await setup();
    const { deps, blobs, space } = await company("Padaria Lia");
    const other = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "Loja" });
    const input = { imageBase64: b64(PNG), contentType: "image/png" };
    const a = await setSpaceImage(deps, f.owner.id, f.org.id, space.id, input);
    await setSpaceImage(deps, f.owner.id, f.org.id, other.id, input);
    await clearSpaceImage(deps, f.owner.id, f.org.id, space.id);
    const file = (a.image as string).split("/").at(-1) as string;
    expect((await spaceImageFile(deps, f.owner.id, f.org.id, file)).contentType).toBe("image/png");
    expect(blobs.objects.size).toBe(1);
  });
});

describe("the photo limit stays", () => {
  test("a profile photo still takes up to 2 MB", async () => {
    f = await setup();
    const blobs = createMemoryBlobStore();
    expect(AVATAR_LIMITS.maxBytes).toBe(2 * 1024 * 1024);
    const done = await setAvatar({ db: f.db, blobs }, f.owner.id, {
      imageBase64: b64(padded(SPACE_IMAGE_LIMITS.maxBytes + 1)),
      contentType: "image/jpeg",
    });
    expect(done.avatarUrl).toEndWith(".jpg");
    const big = await rejection(
      setAvatar({ db: f.db, blobs }, f.owner.id, {
        imageBase64: b64(padded(AVATAR_LIMITS.maxBytes + 1)),
        contentType: "image/jpeg",
      }),
    );
    expect(big).toMatchObject({ code: "avatar.too_large", params: { maxMb: 2 } });
  });
});
