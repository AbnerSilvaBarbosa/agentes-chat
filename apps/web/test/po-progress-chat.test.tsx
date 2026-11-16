import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import {
  type CardProposalView,
  type Message,
  type PoCompany,
  type PoProgress,
  type PoProgressCard,
  type PoProgressGroup,
  UNREAD_REFRESH_MS,
} from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { DM_SIDE_NARROW_QUERY, DM_SIDE_WIDE_QUERY } from "@/hooks/useMembersColumn";
import { ADA_ID, createFakeApi, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

let media: { mockRestore: () => void } | null = null;
const widthIs = (query: string) => {
  media = spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === query,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
};

afterEach(() => {
  cleanup();
  media?.mockRestore();
  media = null;
  localStorage.clear();
});

const company = (id: string, name: string): PoCompany => ({
  id,
  name,
  color: "#3366ff",
  image: null,
  archived: false,
  open: 1,
  channelId: null,
});

const card = (over: Partial<PoProgressCard> = {}): PoProgressCard => ({
  id: "c1",
  number: 12,
  title: "Tela de login",
  boardId: "b1",
  boardName: "Entregas",
  since: new Date(Date.now() - 3_600_000).toISOString(),
  spec: null,
  ...over,
});

const column = (key: string, name: string, items: PoProgressCard[], stage: PoProgressGroup["stage"] = "todo") => ({
  key,
  kind: "column" as const,
  stage,
  name,
  columns: [key],
  count: items.length,
  items,
});

/** Especificar, Especificado, Ready for dev and the tail, with the given cards in each. */
const layout = (cards: Partial<Record<"specify" | "specified" | "ready" | "tail", PoProgressCard[]>> = {}) => {
  const tail = cards.tail ?? [];
  return [
    column("especificar", "Especificar", cards.specify ?? []),
    column("especificado", "Especificado", cards.specified ?? []),
    column("ready for dev", "Ready for dev", cards.ready ?? [], "in_progress"),
    { ...column("tail", "", tail, "in_progress"), kind: "tail" as const, name: null },
  ];
};

const progress = (spaceId: string, name: string, groups: PoProgressGroup[], done = 0): PoProgress => ({
  space: { id: spaceId, name },
  groups,
  done,
});

const proposal = (over: Partial<CardProposalView> = {}): CardProposalView => ({
  id: "p1",
  agentId: ADA_ID,
  requesterUserId: "",
  spaceId: "s-acme",
  title: "Tela de login",
  summary: "",
  criteria: [],
  project: { id: "b1", name: "Entregas" },
  status: "pending",
  duplicateOf: null,
  issue: null,
  spec: null,
  ...over,
});

const say = (channelId: string, id: string, body: string, meta: Message["meta"] = {}): Message => ({
  id,
  channelId,
  threadId: null,
  author: { type: "agent", id: ADA_ID },
  body,
  mentionedAgentIds: [],
  agentRunId: null,
  meta,
  createdAt: new Date().toISOString(),
});

async function scene(options: { po?: boolean; groups?: PoProgressGroup[] } = {}) {
  const { po = true } = options;
  const state: FakeState = seedState({
    poAgentId: po ? ADA_ID : null,
    poCompanies: po ? [company("s-acme", "Acme"), company("s-beta", "Beta")] : [],
  });
  state.poProgress = {
    "s-acme": progress("s-acme", "Acme", options.groups ?? layout({ specify: [card()] }), 2),
    "s-beta": progress(
      "s-beta",
      "Beta",
      layout({ specify: [card({ id: "b1", number: 77, title: "Do site da Beta" })] }),
    ),
  };
  state.messages.push(say("po-chat-s-acme", "m-acme", "Resumo da Acme"));
  const api = createFakeApi(state);
  const app = await renderApp(`/org/${ORG_ID}/po/s-acme`, { api });
  await settle(10);
  return { state, api, app };
}

const side = () => screen().queryByRole("complementary", { name: "Andamento dos cards" });
const toggle = () => screen().queryByRole("button", { name: "Andamento dos cards" });
const groups = () =>
  [...(side()?.querySelectorAll(".po-group") ?? [])].map((s) => ({
    name: s.querySelector("h3")?.firstChild?.textContent,
    rows: [...s.querySelectorAll(".po-row__title")].map((r) => r.textContent),
  }));
const progressCalls = (state: { calls: { method: string }[] }) =>
  state.calls.filter((c) => c.method === "po.progress").length;

describe("where the panel sits", () => {
  test("a PO chat shows the panel to the right of the conversation on a wide screen", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    await scene();
    const panel = side() as HTMLElement;
    expect(panel).toBeTruthy();
    const body = document.querySelector(".channel__body") as HTMLElement;
    const kids = [...body.children];
    expect(kids.indexOf(panel)).toBeGreaterThan(kids.indexOf(body.querySelector(".channel__col") as HTMLElement));
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
    expect(groups()[0]).toEqual({ name: "Especificar", rows: ["#12 Tela de login"] });
    // The agent's own sidebar is not drawn beside it.
    expect(screen().queryByRole("complementary", { name: "Detalhes" })).toBeNull();
  });

  test("on a narrow screen the panel is hidden and the header button opens it over the chat", async () => {
    widthIs(DM_SIDE_NARROW_QUERY);
    await scene();
    expect(side()).toBeNull();
    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(toggle() as HTMLElement));
    await settle(6);
    const sheet = side() as HTMLElement;
    expect(sheet.classList.contains("po-side--float")).toBe(true);
    expect(within(sheet).getByText("Tela de login", { exact: false })).toBeTruthy();
    // It floats over a scrim, closed by its own button, and nothing is saved.
    expect(sheet.parentElement?.querySelector(":scope > .thread-panel__scrim")).toBeTruthy();
    expect(localStorage.getItem(`agentes.po.sidebar.${seedState().me?.user.id}.${ORG_ID}`)).toBeNull();
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Fechar" })));
    await settle(6);
    expect(side()).toBeNull();
  });

  test("closing the panel on a wide screen is remembered and the button brings it back", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    await scene();
    await act(async () => fireEvent.click(toggle() as HTMLElement));
    expect(side()).toBeNull();
    expect(localStorage.getItem(`agentes.po.sidebar.${seedState().me?.user.id}.${ORG_ID}`)).toBe("0");
    await act(async () => fireEvent.click(toggle() as HTMLElement));
    expect(side()).toBeTruthy();
  });

  test("a plain DM with an agent keeps its sidebar and shows no progress panel", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    const api = createFakeApi(seedState());
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api });
    await settle(10);
    expect(screen().getByRole("complementary", { name: "Detalhes" })).toBeTruthy();
    expect(side()).toBeNull();
    expect(toggle()).toBeNull();
  });

  test("a workspace without a PO shows no panel", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    await scene({ po: false });
    expect(side()).toBeNull();
    expect(screen().getByText("Nenhum PO para conversar sobre essa empresa.")).toBeTruthy();
  });

  test("switching company shows that company's panel", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    const { app } = await scene();
    expect(side()?.textContent).toContain("Tela de login");
    await app.router.navigate({ to: "/org/$orgId/po/$spaceId", params: { orgId: ORG_ID, spaceId: "s-beta" } });
    await settle(10);
    expect(side()?.textContent).toContain("Do site da Beta");
    expect(side()?.textContent).not.toContain("Tela de login");
    expect(within(side() as HTMLElement).getByText("Beta")).toBeTruthy();
  });
});

describe("the panel follows the work", () => {
  const push = (app: { sockets: { last: () => { push: (f: unknown) => void } } }, event: unknown, channelId?: string) =>
    act(async () =>
      app.sockets.last().push(channelId ? { type: "event", channelId, event } : { type: "event", scope: "org", event }),
    );

  test("a confirmed card appears in Especificar with its spec in progress", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    const { state, app } = await scene({ groups: layout() });
    expect(groups()[0]?.rows).toEqual([]);
    const before = progressCalls(state);
    // The server confirms the card: it is in Especificar and its spec is queued, then running.
    state.poProgress = {
      ...state.poProgress,
      "s-acme": progress(
        "s-acme",
        "Acme",
        layout({ specify: [card({ spec: { state: "running", page: null, error: null } })] }),
      ),
    };
    await push(
      app,
      {
        type: "card.proposal.updated",
        channelId: "po-chat-s-acme",
        threadId: null,
        messageId: "m-card",
        proposal: proposal({ status: "confirmed", spec: { state: "running", page: null, error: null } }),
      },
      "po-chat-s-acme",
    );
    await settle(8);
    expect(progressCalls(state)).toBeGreaterThan(before);
    expect(groups()[0]?.rows).toEqual(["#12 Tela de login"]);
    expect(side()?.querySelector(".po-row__spec")?.textContent).toBe("Spec em andamento");
  });

  test("a finished spec moves the card to Especificado with Spec pronta and its link", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    const running = card({ spec: { state: "running", page: null, error: null } });
    const { state, app } = await scene({ groups: layout({ specify: [running] }) });
    expect(groups()[0]?.rows).toEqual(["#12 Tela de login"]);
    const page = { slug: "specs/acme/12", title: "Spec 12" };
    state.poProgress = {
      ...state.poProgress,
      "s-acme": progress(
        "s-acme",
        "Acme",
        layout({ specified: [card({ spec: { state: "done", page, error: null } })] }),
      ),
    };
    await push(
      app,
      {
        type: "card.proposal.updated",
        channelId: "po-chat-s-acme",
        threadId: null,
        messageId: "m-card",
        proposal: proposal({ status: "confirmed", spec: { state: "done", page, error: null } }),
      },
      "po-chat-s-acme",
    );
    await settle(8);
    const now = groups();
    expect(now[0]?.rows).toEqual([]);
    expect(now[1]).toEqual({ name: "Especificado", rows: ["#12 Tela de login"] });
    const panel = side() as HTMLElement;
    expect(within(panel).getByText("Spec pronta")).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "Ver spec" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/wiki/specs%2Facme%2F12`,
    );
  });

  test("a task event moves the card to its new group", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    const { state, app } = await scene({ groups: layout({ specified: [card()] }) });
    const socket = app.sockets.last();
    await act(async () => socket.open());
    await settle(3);
    expect(groups()[1]?.rows).toEqual(["#12 Tela de login"]);
    // Anyone moves the card to Ready for dev: a task event, heard once per burst.
    state.poProgress = {
      ...state.poProgress,
      "s-acme": progress("s-acme", "Acme", layout({ ready: [card()] })),
    };
    await push(app, { type: "issue.updated" });
    await act(() => new Promise((done) => setTimeout(done, UNREAD_REFRESH_MS + 100)));
    await settle(8);
    const now = groups();
    expect(now[1]?.rows).toEqual([]);
    expect(now[2]).toEqual({ name: "Ready for dev", rows: ["#12 Tela de login"] });
  });
});
describe("worst case", () => {
  test("the worst case stays inside the panel", async () => {
    widthIs(DM_SIDE_WIDE_QUERY);
    // The limits' worst: 300-character titles, long board names, nine or more cards in each group, a failure's
    // reason at its longest (a known code's sentence; free text is never drawn). What the geometry check lays out at 1280 and 390 (`capture.ts` saves the screen).
    const title = `${"Reestruturação completa do atendimento ao cliente da clínica com triagem ".repeat(5)}`
      .trim()
      .slice(0, 300);
    const many = (n: number, over: Partial<PoProgressCard> = {}) =>
      Array.from({ length: 8 }, (_, i) =>
        card({
          id: `${n}-${i}`,
          number: n * 100 + i,
          title,
          boardName: `Board com um nome muito comprido número ${i} da operação`,
          ...over,
        }),
      );
    const failing = many(1, { spec: { state: "failed", page: null, error: "no_spec_page" } });
    const groups_ = layout({ specify: failing, specified: many(2), ready: many(3), tail: many(4) }).map((g) => ({
      ...g,
      count: 14,
    }));
    await scene({ groups: groups_ });
    const panel = side() as HTMLElement;
    expect(panel.querySelectorAll(".po-row")).toHaveLength(32);
    expect(panel.querySelector(".po-row__title")?.textContent).toContain(title);
    expect(panel.textContent).toContain("Spec falhou: a execução terminou sem salvar a spec na wiki");
    expect(within(panel).getAllByRole("link", { name: "Ver todos" })).toHaveLength(4);
    expect(panel.querySelector(".po-side__scroll")).toBeTruthy();
    expect(panel.closest(".channel__body")).toBeTruthy();
  });
});
