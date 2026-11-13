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
  test("the image shows on the card, the chip and the picker", async () => {
    const { api, clinic } = await withCompanies();
    await go(api);
    const src = clinic.image as string;
    expect(src).toContain(`/organizations/${ORG_ID}/issue-space-images/`);

    // The card wears it in place of its color dot.
    expect(card("Clínica Teo").querySelector(`.space-mark > img[src="${src}"]`)).toBeTruthy();
    expect(card("Clínica Teo").querySelector(".ac-colordot:not(.space-mark)")).toBeNull();

    // The chip's menu rows wear it, and once picked so does the chip.
    const menu = await openMenu(chip());
    expect(row(menu, "Clínica Teo").querySelector(`img[src="${src}"]`)).toBeTruthy();
    await click(row(menu, "Clínica Teo"));
    await settle(4);
    const worn = [...document.querySelectorAll<HTMLElement>(".ac-toolbar .ac-filter__trigger")].find((c) =>
      c.textContent?.includes("Clínica Teo"),
    );
    expect(worn?.querySelector(`img[src="${src}"]`)).toBeTruthy();

    // The picker of "Novo board" lists the companies with it.
    await click(within(document.body).getAllByRole("button", { name: "Novo board" }).at(-1) as HTMLElement);
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "Novo board" });
    await click(within(dialog).getByRole("combobox", { name: "Empresa" }));
    await settle(3);
    const options = [...document.querySelectorAll<HTMLElement>("[role=option]")];
    const clinicOption = options.find((o) => o.textContent?.includes("Clínica Teo")) as HTMLElement;
    expect(clinicOption.querySelector(`img[src="${src}"]`)).toBeTruthy();
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

    const menu = await openMenu(chip());
    const dot = row(menu, "Padaria Lia").querySelector<HTMLElement>(".ac-colordot");
    expect(dot?.style.getPropertyValue("--dot")).not.toBe("");
    expect(row(menu, "Padaria Lia").querySelector("img")).toBeNull();
  });
});
