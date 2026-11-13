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

/** A company with a board, and a board that belongs to no company. */
async function setup() {
  const api = createFakeApi(seedState());
  const clinic = await api.issues.createSpace(ORG_ID, { name: "Clínica Teo", color: "teal" });
  const site = await api.issues.createProject(ORG_ID, { name: "Site novo", color: "amber", spaceId: clinic.id });
  const loose = await api.issues.createProject(ORG_ID, { name: "Ideias soltas", color: "graphite" });
  return { api, clinic, site, loose };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const visit = async (api: Setup["api"], search: string) => {
  await renderApp(`/org/${ORG_ID}/issues${search}`, { api });
  await settle(8);
};
const path = () => screen().getByRole("navigation", { name: "Caminho" });
const segments = () =>
  [...path().querySelectorAll("li")].map((li) => li.querySelector(".ac-breadcrumb__label")?.textContent);
const heading = () => document.querySelector("h1")?.textContent ?? "";

describe("the path above a company's page and a board", () => {
  test("company page path shows Tarefas then the company", async () => {
    const { api, clinic } = await setup();
    await visit(api, `?space=${clinic.id}`);
    expect(segments()).toEqual(["Tarefas", "Clínica Teo"]);
    expect(within(path()).getByRole("link", { name: "Tarefas" })).toBeTruthy();
    expect(within(path()).queryByRole("link", { name: "Clínica Teo" })).toBeNull();
  });

  test("board in a company path shows three segments", async () => {
    const { api, site } = await setup();
    await visit(api, `?project=${site.id}`);
    expect(segments()).toEqual(["Tarefas", "Clínica Teo", "Site novo"]);
    expect(within(path()).getByRole("link", { name: "Tarefas" })).toBeTruthy();
    expect(within(path()).getByRole("link", { name: "Clínica Teo" })).toBeTruthy();
    expect(within(path()).queryByRole("link", { name: "Site novo" })).toBeNull();
  });

  test("board without a company path shows two segments", async () => {
    const { api, loose } = await setup();
    await visit(api, `?project=${loose.id}`);
    expect(segments()).toEqual(["Tarefas", "Ideias soltas"]);
    expect(within(path()).getByRole("link", { name: "Tarefas" })).toBeTruthy();
  });

  test("Tarefas link opens the companies root", async () => {
    const { api, site } = await setup();
    await visit(api, `?project=${site.id}`);
    expect(document.querySelector(".space-board")).toBeNull();
    await click(within(path()).getByRole("link", { name: "Tarefas" }));
    await settle(8);
    // The root draws the companies' cards and no path.
    expect(heading()).toBe("Tarefas");
    expect(document.querySelectorAll(".space-board").length).toBeGreaterThan(0);
    expect(screen().getByRole("button", { name: /Clínica Teo/ })).toBeTruthy();
    expect(screen().queryByRole("navigation", { name: "Caminho" })).toBeNull();
  });

  test("company link opens the company's boards", async () => {
    const { api, site } = await setup();
    await visit(api, `?project=${site.id}`);
    await click(within(path()).getByRole("link", { name: "Clínica Teo" }));
    await settle(8);
    expect(segments()).toEqual(["Tarefas", "Clínica Teo"]);
    // The company's page lists its boards, and the other company-less board stays out.
    const boards = [...document.querySelectorAll(".space-board__name")].map((n) => n.textContent);
    expect(boards).toContain("Site novo");
    expect(boards).not.toContain("Ideias soltas");
  });

  test("last segment is plain text", async () => {
    const { api, site } = await setup();
    await visit(api, `?project=${site.id}`);
    const last = [...path().querySelectorAll("li")].at(-1) as HTMLElement;
    expect(last.textContent).toContain("Site novo");
    expect(last.querySelector("a, button")).toBeNull();
    expect(last.querySelector("[aria-current='page']")).toBeTruthy();
  });

  test("a company's image shows on the card, the path and the picker", async () => {
    const { api, clinic, site } = await setup();
    const withImage = await api.issues.setSpaceImage(ORG_ID, clinic.id, { imageBase64: PNG, contentType: "image/png" });
    const src = withImage.image as string;
    expect(src).toContain(`/organizations/${ORG_ID}/issue-space-images/`);

    // The card on the root.
    await visit(api, "");
    const card = [...document.querySelectorAll<HTMLElement>(".space-board")].find((c) =>
      c.textContent?.includes("Clínica Teo"),
    ) as HTMLElement;
    expect(card.querySelector(`.space-mark > img[src="${src}"]`)).toBeTruthy();
    cleanup();

    // The path on the company's page and inside its board.
    await visit(api, `?space=${clinic.id}`);
    expect(path().querySelector(`.space-mark > img[src="${src}"]`)).toBeTruthy();
    cleanup();
    await visit(api, `?project=${site.id}`);
    expect(segments()).toEqual(["Tarefas", "Clínica Teo", "Site novo"]);
    expect(path().querySelector(`.space-mark > img[src="${src}"]`)).toBeTruthy();
    cleanup();
    await visit(api, `?all=1`);
    // The picker of a new board lists the company with it.
    const boardChip = [...document.querySelectorAll<HTMLElement>(".ac-toolbar .ac-filter__trigger")].find((c) =>
      c.textContent?.startsWith("Board"),
    ) as HTMLElement;
    await click(boardChip);
    await settle(3);
    await click(within(document.body).getByRole("button", { name: "Novo board" }));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "Novo board" });
    await click(within(dialog).getByRole("combobox", { name: "Empresa" }));
    await settle(3);
    const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((o) =>
      o.textContent?.includes("Clínica Teo"),
    ) as HTMLElement;
    expect(option.querySelector(`img[src="${src}"]`)).toBeTruthy();
  });
});
