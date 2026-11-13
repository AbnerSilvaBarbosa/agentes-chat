import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));

/** A pixel of PNG: the fake keeps it as the company's image. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";

/** Two companies: Clínica Teo with an image, Padaria Lia with none (its color shows). */
async function withCompanies() {
  const api = createFakeApi(seedState());
  const clinic = await api.issues.createSpace(ORG_ID, { name: "Clínica Teo", color: "teal" });
  const bakery = await api.issues.createSpace(ORG_ID, { name: "Padaria Lia", color: "amber" });
  const withImage = await api.issues.setSpaceImage(ORG_ID, clinic.id, { imageBase64: PNG, contentType: "image/png" });
  return { api, clinic: withImage, bakery };
}

const go = async (api: ReturnType<typeof createFakeApi>) => {
  const r = await renderApp(`/org/${ORG_ID}/issues`, { api });
  await settle(8);
  return r;
};
// The Empresa chip lives on "Todas as tarefas" only: the root and a company's page are already scoped (TFL-01).
const goAll = async (api: ReturnType<typeof createFakeApi>) => {
  const r = await renderApp(`/org/${ORG_ID}/issues?all=1`, { api });
  await settle(8);
  return r;
};
const card = (name: string) =>
  [...document.querySelectorAll<HTMLElement>(".space-board")].find((c) => c.textContent?.includes(name)) as HTMLElement;
const chip = () =>
  [...document.querySelectorAll<HTMLElement>(".ac-toolbar .ac-filter__trigger")].find((c) =>
    c.textContent?.startsWith("Empresa"),
  ) as HTMLElement;
const openMenu = async (trigger: HTMLElement) => {
  await click(trigger);
  await settle(3);
  return document.querySelector<HTMLElement>(".ac-filter__menu") as HTMLElement;
};
const row = (menu: HTMLElement, name: string) =>
  [...menu.querySelectorAll<HTMLElement>("[role=option]")].find(
    (r) => r.querySelector(".ac-filter__label")?.textContent === name,
  ) as HTMLElement;

describe("a company's image in Tarefas", () => {
  test("the image shows on the card", async () => {
    const { api, clinic } = await withCompanies();
    await go(api);
    const src = clinic.image as string;
    expect(src).toContain(`/organizations/${ORG_ID}/issue-space-images/`);

    // The card wears it in place of its color dot.
    expect(card("Clínica Teo").querySelector(`.space-mark > img[src="${src}"]`)).toBeTruthy();
    expect(card("Clínica Teo").querySelector(".ac-colordot:not(.space-mark)")).toBeNull();
  });

  test("the image shows on the chip and the picker", async () => {
    const { api, clinic } = await withCompanies();
    await goAll(api);
    const src = clinic.image as string;

    // The chip's menu rows wear it (picking one scopes the page, and the chip leaves).
    const menu = await openMenu(chip());
    expect(row(menu, "Clínica Teo").querySelector(`img[src="${src}"]`)).toBeTruthy();
  });

  test("a company with no image shows the color", async () => {
    const { api, bakery } = await withCompanies();
    await go(api);
    expect(bakery.image).toBeNull();

    const mark = card("Padaria Lia").querySelector<HTMLElement>(".ac-colordot");
    expect(mark).toBeTruthy();
    expect(mark?.classList.contains("space-mark")).toBe(false);
    expect(mark?.querySelector("img")).toBeNull();
    expect(mark?.style.getPropertyValue("--dot")).not.toBe("");
  });

  test("the chip row of a company without an image wears its color", async () => {
    const { api } = await withCompanies();
    await goAll(api);
    const menu = await openMenu(chip());
    const dot = row(menu, "Padaria Lia").querySelector<HTMLElement>(".ac-colordot");
    expect(dot?.style.getPropertyValue("--dot")).not.toBe("");
    expect(row(menu, "Padaria Lia").querySelector("img")).toBeNull();
  });

  test("the new board's company picker lists the companies with their image", async () => {
    const { api, clinic } = await withCompanies();
    await goAll(api);
    const src = clinic.image as string;
    const boardChip = [...document.querySelectorAll<HTMLElement>(".ac-toolbar .ac-filter__trigger")].find((c) =>
      c.textContent?.startsWith("Board"),
    ) as HTMLElement;
    const boards = await openMenu(boardChip);
    await click(within(boards).getByRole("button", { name: "Novo board" }));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "Novo board" });
    await click(within(dialog).getByRole("combobox", { name: "Empresa" }));
    await settle(3);
    const options = [...document.querySelectorAll<HTMLElement>("[role=option]")];
    const clinicOption = options.find((o) => o.textContent?.includes("Clínica Teo")) as HTMLElement;
    expect(clinicOption.querySelector(`img[src="${src}"]`)).toBeTruthy();
  });
});

const calls = (state: ReturnType<typeof seedState>, method: string) => state.calls.filter((c) => c.method === method);
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const pickFile = (dialog: HTMLElement, file: File) =>
  act(async () => fireEvent.change(within(dialog).getByLabelText("Escolher imagem"), { target: { files: [file] } }));
/** Radix opens a menu on a key, not on a click. */
const pressEnter = async (el: HTMLElement) => {
  el.focus();
  await act(async () => {
    fireEvent.keyDown(el, { key: "Enter" });
    fireEvent.keyUp(el, { key: "Enter" });
  });
  await settle(2);
};

const newCompany = async () => {
  await click(
    [...document.querySelectorAll<HTMLElement>("button.space-board--new")].find((b) =>
      b.textContent?.includes("Nova empresa"),
    ) as HTMLElement,
  );
  await settle(3);
  return screen().getByRole("dialog", { name: "Nova empresa" });
};
/** "Editar empresa" from the company's own page. */
const editCompany = async (api: ReturnType<typeof createFakeApi>, spaceId: string) => {
  await renderApp(`/org/${ORG_ID}/issues?space=${spaceId}`, { api });
  await settle(8);
  await pressEnter(screen().getByRole("button", { name: "Mais opções" }));
  await click(screen().getByRole("menuitem", { name: "Editar empresa" }));
  await settle(3);
  return screen().getByRole("dialog", { name: "Editar empresa" });
};
const imageField = (dialog: HTMLElement) => within(dialog).getByText("Imagem").closest(".ac-field") as HTMLElement;
/** Picks a file in the crop dialog and presses its Salvar. */
const crop = async (dialog: HTMLElement, file: File) => {
  await click(within(imageField(dialog)).getByRole("button", { name: /^(Escolher|Trocar) imagem$/ }));
  await settle(3);
  const cropper = screen().getByRole("dialog", { name: "Imagem da empresa" });
  await pickFile(cropper, file);
  await settle(3);
  return cropper;
};

describe("a company's image dialog", () => {
  test("the dialog shows an image upload beside the colors", async () => {
    await go(createFakeApi(seedState()));
    const dialog = await newCompany();
    const colors = within(dialog).getByRole("radiogroup", { name: "Cor" });
    const field = imageField(dialog);
    expect(within(field).getByRole("button", { name: "Escolher imagem" })).toBeTruthy();
    // One body: the upload comes right after the colors.
    expect(colors.parentElement).toBe(field.parentElement);
    expect(colors.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No image yet: nothing to remove.
    expect(within(field).queryByRole("button", { name: "Remover imagem" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Cancelar" }));
    cleanup();

    // Editing a company shows it too, with the image it already has.
    const { api, clinic } = await withCompanies();
    const edit = await editCompany(api, clinic.id);
    const editField = imageField(edit);
    expect(within(editField).getByRole("button", { name: "Trocar imagem" })).toBeTruthy();
    expect(within(editField).getByRole("button", { name: "Remover imagem" })).toBeTruthy();
    expect(editField.querySelector(`img[src="${clinic.image}"]`)).toBeTruthy();
  });

  test("crops the image square before sending", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await go(api);
    // A canvas that records what the crop draws; the jsdom-less DOM has none of its own.
    const drawn: number[][] = [];
    const sizes: number[][] = [];
    const proto = HTMLCanvasElement.prototype;
    const was = { getContext: proto.getContext, toDataURL: proto.toDataURL };
    // Only the crop's own canvas (never attached to the page): the pages' canvases keep theirs.
    proto.getContext = function (this: HTMLCanvasElement, ...args: Parameters<typeof was.getContext>) {
      if (this.isConnected) return (was.getContext as (...a: unknown[]) => unknown).apply(this, args);
      return {
        drawImage: (_img: unknown, ...rest: number[]) => {
          drawn.push(rest);
          sizes.push([this.width, this.height]);
        },
      };
    } as typeof proto.getContext;
    proto.toDataURL = function (this: HTMLCanvasElement, ...args: unknown[]) {
      return this.isConnected
        ? (was.toDataURL as (...a: unknown[]) => string).apply(this, args)
        : `data:image/png;base64,${PNG}`;
    } as typeof proto.toDataURL;
    try {
      const dialog = await newCompany();
      await type(within(dialog).getByLabelText("Nome"), "Clínica Teo");
      const cropper = await crop(dialog, new File(["wide-picture"], "logo.png", { type: "image/png" }));
      // A wide picture (1000×500): the frame shows a square of it.
      const preview = within(cropper)
        .getByRole("img", { name: "Prévia da foto" })
        .querySelector("img") as HTMLImageElement;
      Object.defineProperty(preview, "naturalWidth", { value: 1000 });
      Object.defineProperty(preview, "naturalHeight", { value: 500 });
      await act(async () => fireEvent.load(preview));
      await click(within(cropper).getByRole("button", { name: "Salvar" }));
      await settle(3);
      // The dialog shows the cropped image as the company's mark before anything is sent.
      expect(calls(state, "issues.setSpaceImage")).toHaveLength(0);
      expect(imageField(dialog).querySelector(`img[src="data:image/png;base64,${PNG}"]`)).toBeTruthy();
      await click(within(dialog).getByRole("button", { name: "Criar empresa" }));
      await settle(6);
    } finally {
      proto.getContext = was.getContext;
      proto.toDataURL = was.toDataURL;
    }
    // Drawn from a square of the source (500×500 of the 1000×500) into 512×512, and that is what was sent.
    expect(sizes).toEqual([[512, 512]]);
    const [sx, sy, sw, sh, dx, dy, dw, dh] = drawn[0] as number[];
    expect([sx, sy, sw, sh]).toEqual([250, 0, 500, 500]);
    expect([dx, dy, dw, dh]).toEqual([0, 0, 512, 512]);
    const sent = calls(state, "issues.setSpaceImage");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args[1]).toEqual({ imageBase64: PNG, contentType: "image/png" });
    const made = (await api.issues.projects(ORG_ID)).spaces.find((sp) => sp.name === "Clínica Teo");
    expect(made?.image).toContain("/issue-space-images/");
    expect(screen().queryByRole("dialog", { name: "Nova empresa" })).toBeNull();
  });

  test("refuses another type or over 1 MiB and says the limits", async () => {
    const state = seedState();
    await go(createFakeApi(state));
    const dialog = await newCompany();
    await type(within(dialog).getByLabelText("Nome"), "Clínica Teo");

    // No canvas here, so the file would go as it is: a GIF is not a type the company takes.
    const cropper = await crop(dialog, new File(["GIF89a"], "animada.gif", { type: "image/gif" }));
    await click(within(cropper).getByRole("button", { name: "Salvar" }));
    await settle(3);
    expect(within(cropper).getByRole("alert").textContent).toBe("Use uma imagem PNG, JPEG ou WebP de até 1 MB.");

    // Over one MiB: says so and names the types again.
    await pickFile(cropper, new File([new Uint8Array(1024 * 1024 + 1)], "grande.png", { type: "image/png" }));
    await settle(3);
    await click(within(cropper).getByRole("button", { name: "Salvar" }));
    await settle(3);
    expect(within(cropper).getByRole("alert").textContent).toBe(
      "A imagem passa de 1 MB. Use uma imagem PNG, JPEG ou WebP de até 1 MB.",
    );
    // Nothing was sent and the company dialog still has no image.
    expect(calls(state, "issues.setSpaceImage")).toHaveLength(0);
    expect(imageField(dialog).querySelector("img")).toBeNull();
  });

  test("removing the image shows the color", async () => {
    const { api, clinic } = await withCompanies();
    const dialog = await editCompany(api, clinic.id);
    await click(within(imageField(dialog)).getByRole("button", { name: "Remover imagem" }));
    // The dialog's mark falls back to the color at once; saving sends the removal.
    expect(imageField(dialog).querySelector("img")).toBeNull();
    expect(within(imageField(dialog)).queryByRole("button", { name: "Remover imagem" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    const after = (await api.issues.projects(ORG_ID)).spaces.find((s) => s.id === clinic.id);
    expect(after?.image).toBeNull();
    expect(after?.color).toBe("teal");
    expect(screen().queryByRole("dialog", { name: "Editar empresa" })).toBeNull();
  });
});
