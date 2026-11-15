import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { FactoryCompany, FactoryHome, WaitingTask } from "@agenteschat/client";
import { cleanup } from "@testing-library/react";
import { FactoryWaiting } from "@/components/factory/FactoryWaiting";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderPage, screen } from "./render";

afterEach(() => cleanup());

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const company = (over: Partial<FactoryCompany> = {}): FactoryCompany => ({
  id: "sp-1",
  name: "Clínica Teo",
  color: "teal",
  image: null,
  stages: { todo: 0, in_progress: 0, in_review: 0, done: 0 },
  late: 0,
  waiting: 0,
  ...over,
});

const task = (over: Partial<WaitingTask> = {}): WaitingTask => ({
  id: "t-1",
  number: 12,
  title: "Revisar a tela de login",
  stage: "in_review",
  spaceId: "sp-1",
  spaceName: "Clínica Teo",
  projectId: "pr-1",
  projectName: "Entregas",
  columnName: "Teste humano",
  since: hoursAgo(3),
  ...over,
});

const showWaiting = (waiting: FactoryHome["waiting"], companies: FactoryCompany[] = [company()]) =>
  renderPage(<FactoryWaiting waiting={waiting} companies={companies} />, {
    api: createFakeApi(seedState()),
    org: true,
  });

describe("Esperando seu teste", () => {
  test("shows the rows in the order the server sent, each with number, title, company, board and how long", async () => {
    await showWaiting({
      total: 2,
      items: [
        task(),
        task({
          id: "t-2",
          number: 7,
          title: "Conferir o envio",
          spaceName: "Beta",
          projectName: "Site",
          since: hoursAgo(50),
        }),
      ],
    });
    expect(screen().getByRole("heading", { name: /Esperando seu teste/ })).toBeTruthy();
    const rows = screen().getAllByRole("link");
    expect(rows.map((r) => r.textContent)).toEqual([
      "#12 Revisar a tela de loginhá 3hClínica Teo · Entregas",
      "#7 Conferir o enviohá 2d 2hBeta · Site",
    ]);
  });

  test("each row is a link to its task", async () => {
    await showWaiting({ total: 1, items: [task({ number: 12 })] });
    const link = screen().getByRole("link", { name: /#12 Revisar a tela de login/ });
    expect(link.getAttribute("href")).toBe(`/org/${ORG_ID}/issues/12`);
  });

  test("with more waiting than the rows shown, Ver tudo opens all tasks filtered to flagged columns", async () => {
    await showWaiting({ total: 9, items: [task()] });
    const more = screen().getByRole("link", { name: "Ver tudo" });
    const url = new URL(more.getAttribute("href") ?? "", "http://x");
    expect(url.pathname).toBe(`/org/${ORG_ID}/issues`);
    // The router writes a string that reads as a number between quotes (`all="1"`).
    const param = (name: string) => url.searchParams.get(name)?.replace(/^"|"$/g, "");
    expect(param("all")).toBe("1");
    expect(param("waiting")).toBe("person");
  });

  test("with every waiting task shown there is no Ver tudo", async () => {
    await showWaiting({ total: 1, items: [task()] });
    expect(screen().queryByRole("link", { name: "Ver tudo" })).toBeNull();
  });

  test("with no item it draws nothing", async () => {
    await showWaiting({ total: 0, items: [] });
    expect(screen().queryByRole("heading", { name: /Esperando seu teste/ })).toBeNull();
    expect(screen().queryAllByRole("link")).toHaveLength(0);
  });
});
