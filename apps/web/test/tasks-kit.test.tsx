import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { builtCss, declarations } from "./built-css";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const read = (path: string) => Bun.file(join(import.meta.dir, "../src", path)).text();

async function setup() {
  const api = createFakeApi(seedState());
  const clinic = await api.issues.createSpace(ORG_ID, { name: "Clínica Teo", color: "teal" });
  const empty = await api.issues.createSpace(ORG_ID, { name: "Padaria Lia", color: "amber" });
  const site = await api.issues.createProject(ORG_ID, { name: "Site novo", color: "amber", spaceId: clinic.id });
  return { api, clinic, empty, site };
}
const visit = async (api: Awaited<ReturnType<typeof setup>>["api"], path: string) => {
  await renderApp(`/org/${ORG_ID}${path}`, { api });
  await settle(8);
};

describe("the Tarefas screens hold to the kit", () => {
  test("pages start at page-top and page-x", async () => {
    const { api, clinic, site } = await setup();
    // Each screen is a page whose root takes `--page-top` and `--page-x` from the kit's `.page` (Settings: its own
    // split, asserted with the page rhythm), and draws its first line right in it.
    const css = await builtCss("src/styles.css", "src/pages/issues.css");
    for (const [path, root] of [
      ["/issues", ".page.issues"],
      [`/issues?space=${clinic.id}`, ".page.issues"],
      [`/issues?project=${site.id}`, ".page.issues"],
      ["/settings/tasks", ".settings"],
    ] as const) {
      await visit(api, path);
      const found = document.querySelector(root);
      expect([path, found !== null]).toEqual([path, true]);
      // The root's own class says which rule gives it its room: the kit's `.page` or Settings' `.settings`, and that
      // rule's padding is `--page-top` above and `--page-x` at the sides.
      const holder = [...(found?.classList ?? [])].find((c) => c === "page" || c === "settings") ?? "";
      const padding = declarations(css, `.${holder}`).find(([prop]) => prop === "padding")?.[1] ?? "";
      expect([path, holder !== "", /^var\(--page-top\) var\(--page-x\)/.test(padding)]).toEqual([path, true, true]);
      // Nothing of the screens overrides that room on the root itself.
      for (const cls of found?.classList ?? [])
        for (const [prop, value] of declarations(css, `.${cls}`))
          if (/^(padding|margin)-(top|left|right|inline|block-start)/.test(prop))
            expect([path, cls, prop, value]).toEqual([path, cls, prop, "0"]);
      cleanup();
    }
    await visit(api, `/issues?space=${clinic.id}`);
    // The company's page opens with its path, then the title: nothing is wrapped in a room of its own.
    const main = document.querySelector(".issues__main") as HTMLElement;
    expect(main.firstElementChild?.classList.contains("ac-breadcrumb")).toBe(true);
    expect(main.children[1]?.classList.contains("ac-pagehead")).toBe(true);
    expect(main.querySelector(".space-boards")?.parentElement).toBe(main);

    // No rule of the screens adds a top or side room of its own past the page's.
    const own = await read("pages/issues.css");
    const kit = await read("../../../packages/ui/src/styles/components.css");
    const roomy = /^(padding|margin)(-top|-left|-right|-inline|-block-start)?$/;
    for (const [sheet, selectors] of [
      [own, [".issues", ".issues__main", ".space-boards", ".space-boards__grid", ".space-boards__empty"]],
      [kit, [".ac-breadcrumb", ".ac-breadcrumb__list"]],
    ] as const)
      for (const selector of selectors)
        for (const [property, value] of declarations(sheet, selector))
          if (roomy.test(property) && property !== "padding")
            expect([selector, property, value]).toEqual([selector, property, "0"]);
    // `padding: 0 0 32` is the page's bottom only.
    expect(declarations(own, ".space-boards").find(([p]) => p === "padding")?.[1]).toBe("0 0 var(--space-8)");
  });

  test("company with no boards shows its empty state", async () => {
    const { api, empty } = await setup();
    await visit(api, `/issues?space=${empty.id}`);
    const state = document.querySelector(".space-boards__empty") as HTMLElement;
    expect(state.textContent).toContain("Esta empresa ainda não tem boards.");
    const action = within(state).getByRole("button", { name: "Novo board" });
    await click(action);
    await settle(3);
    // The action works, and from here the company is known.
    const dialog = screen().getByRole("dialog", { name: "Novo board" });
    expect(within(dialog).queryByText("Empresa")).toBeNull();
  });

  test("set with no columns shows its empty state", async () => {
    const { api } = await setup();
    await api.issues.createColumnTemplate(ORG_ID, { name: "Vazio", columns: [{ name: "X", stage: "todo" }] });
    await api.issues.updateColumnTemplate(ORG_ID, (await api.issues.columnTemplates(ORG_ID)).at(-1)?.id ?? "", {
      columns: [],
    });
    await visit(api, "/settings/tasks");
    const set = screen().getByRole("region", { name: "Vazio" });
    expect(within(set).getByText("Este conjunto não tem colunas.")).toBeTruthy();
    expect(within(set).getAllByRole("button", { name: "Adicionar coluna" }).length).toBeGreaterThan(0);
  });

  test("long names and many boards stay inside their cards", async () => {
    const { api, clinic } = await setup();
    const long = "Uma empresa com um nome muito comprido que precisa quebrar em linhas sem estourar o cartão";
    await api.issues.createSpace(ORG_ID, { name: long, color: "graphite" });
    for (let i = 0; i < 20; i++)
      await api.issues.createProject(ORG_ID, {
        name: `Board ${i} ${"x".repeat(40)}`,
        color: "teal",
        spaceId: clinic.id,
      });
    await visit(api, `/issues?space=${clinic.id}`);
    expect(document.querySelectorAll(".space-board-wrap").length).toBe(21);
    cleanup();
    await visit(api, "/issues");
    expect(screen().getByRole("button", { name: new RegExp(long.slice(0, 20)) })).toBeTruthy();
  });

  test("a board card's options button sits inside the card's corner", async () => {
    const { api, clinic } = await setup();
    await api.issues.createProject(ORG_ID, { name: "Site", color: "teal", spaceId: clinic.id });
    await visit(api, `/issues?space=${clinic.id}`);
    const wrap = document.querySelector<HTMLElement>(".space-board-wrap");
    const options = wrap?.querySelector<HTMLElement>(":scope > button[aria-label^='Opções']");
    expect(options).toBeTruthy();
    // The corner rule names the class the kit's Button really draws, or it never applies and the button falls under
    // the card.
    const css = await builtCss("src/styles.css", "src/pages/issues.css");
    const corner =
      css.match(/\.space-board-wrap>\.ac-btn\{[^}]*\}/)?.[0] ??
      css.match(/\.space-board-wrap\s*>\s*\.ac-btn\s*\{[^}]*\}/)?.[0];
    expect(options?.classList.contains("ac-btn")).toBe(true);
    expect(corner).toContain("position:absolute");
    expect(css).not.toContain(".space-board-wrap>.ac-button");
    expect(css).not.toContain(".space-board-wrap > .ac-button");
  });

  test("a company's image sits alone in its box, centred beside the name", async () => {
    const css = await builtCss("src/styles.css", "src/pages/issues.css");
    // The kit's dot is the box's ::before: left on an image mark it is a second grid item that pushes the picture off
    // the middle of the name beside it, on a card and in the path.
    expect(css).toMatch(/\.space-mark::?before\s*\{\s*content:\s*none/);
    // The picture is the size of its box, whatever place sets it.
    expect(css).toMatch(/\.space-mark>img\{[^}]*width:var\(--dot-box\)/);
  });
});
