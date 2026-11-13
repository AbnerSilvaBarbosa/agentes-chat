import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type ApiClient, ApiError, type Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, GENERAL_ID, NOW, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/** Card 128 of the seeded workspace, as its fake holds it. */
const CARD = { number: 128, title: "Login devolve 401 depois do deploy das 9h", status: "Em revisão" };

const message = (id: string, body: string, over: Partial<Message> = {}): Message => ({
  id,
  channelId: GENERAL_ID,
  threadId: null,
  author: { type: "person", id: "u-joao" },
  body,
  mentionedAgentIds: [],
  agentRunId: null,
  createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
  ...over,
});

/** The seed plus a message in #general. */
const withMessage = (body: string, over: Partial<Message> = {}) => {
  const state = seedState();
  state.messages.push(message("m-card", body, over));
  return state;
};

const go = async (path: string, api: ApiClient) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api });
  await settle(8);
  return r;
};
const chips = () => [...document.querySelectorAll<HTMLAnchorElement>(".ac-msg__text a.id-ref")];
const text = () => document.querySelector(`[data-message-id="m-card"] .ac-msg__text`)?.textContent ?? "";

describe("#128 in a message", () => {
  test("draws a visible card as a chip: its number, title and status", async () => {
    await go(`c/${GENERAL_ID}`, createFakeApi(withMessage("veja #128, por favor")));
    const chip = screen().getByRole("link", { name: `Tarefa #128: ${CARD.title} (${CARD.status})` });
    expect(chip.textContent).toContain("#128");
    expect(chip.textContent).toContain(CARD.title);
    expect(chip.textContent).toContain(CARD.status);
    expect(chip.getAttribute("href")).toBe(`/org/${ORG_ID}/issues/128`);
    // The words around it stay words.
    expect(text()).toContain("veja ");
    expect(text()).toContain(", por favor");
  });

  test("clicking the chip opens the card", async () => {
    const r = await go(`c/${GENERAL_ID}`, createFakeApi(withMessage("veja #128")));
    await act(async () => fireEvent.click(screen().getByRole("link", { name: /^Tarefa #128/ }), { button: 0 }));
    await settle(8);
    // In a conversation the card opens over it, else on its own page.
    const opened =
      r.router.state.location.pathname === `/org/${ORG_ID}/issues/128` ||
      Boolean(document.body.textContent?.includes(CARD.title) && screen().queryByRole("dialog"));
    expect(opened).toBe(true);
  });

  test("the chip follows a change of title and status", async () => {
    const api = createFakeApi(withMessage("veja #128"));
    const r = await go(`c/${GENERAL_ID}`, api);
    expect(chips()[0]?.textContent).toContain("Em revisão");
    const issue = await api.issues.get(ORG_ID, 128);
    await api.issues.update(ORG_ID, issue.id, { title: "Login corrigido", status: "done" });
    // What a task event does: the issue queries are asked again.
    await act(
      async () => void (await r.services.queryClient.invalidateQueries({ queryKey: ["org", ORG_ID, "issues"] })),
    );
    await settle(6);
    const chip = chips()[0] as HTMLElement;
    expect(chip.textContent).toContain("Login corrigido");
    expect(chip.textContent).toContain("Feito");
    expect(chip.textContent).not.toContain(CARD.title);
  });

  test("an unseen card stays the text as written", async () => {
    const api = createFakeApi(withMessage("o #129 e o #9999 e o #128"));
    const get = api.issues.get.bind(api.issues);
    // The server answers 404 for a card its reader may not see, as for one that does not exist.
    api.issues.get = async (orgId, number) => {
      if (number === 129) throw new ApiError(404, "not_found", "Not found");
      return get(orgId, number);
    };
    await go(`c/${GENERAL_ID}`, api);
    expect(chips()).toHaveLength(1);
    expect(chips()[0]?.textContent).toContain("#128");
    expect(text()).toContain("o #129 e o #9999 e o ");
    expect(screen().queryByRole("link", { name: /Tarefa #129/ })).toBeNull();
    expect(document.body.textContent).not.toContain("Timeout no agendamento");
  });

  test("PR #128 and a code span stay text", async () => {
    await go(
      `c/${GENERAL_ID}`,
      createFakeApi(withMessage("PR #128, pull request #128, issue #128 e `#128`\n\n```\n#128\n```")),
    );
    expect(chips()).toHaveLength(0);
    expect(text()).toContain("PR #128, pull request #128, issue #128 e ");
    expect(document.querySelector(`[data-message-id="m-card"] code`)?.textContent).toBe("#128");
  });

  test("draws it in an agent's message and in a thread", async () => {
    const state = seedState();
    state.messages.push(
      message("m-card", "Estou na #128", { channelId: ENG_ID, author: { type: "agent", id: ADA_ID } }),
      message("t-card", "e depois a #129", {
        channelId: ENG_ID,
        threadId: "m-1",
        author: { type: "agent", id: ADA_ID },
      }),
    );
    const dm = seedDm(state, { type: "agent", id: ADA_ID }, { body: "Pegando a #130" });
    const api = createFakeApi(state);
    // A channel, from an agent.
    await go(`c/${ENG_ID}`, api);
    expect(chips().map((c) => c.getAttribute("href"))).toContain(`/org/${ORG_ID}/issues/128`);
    cleanup();
    // The thread panel.
    await go(`c/${ENG_ID}?thread=m-1`, api);
    const panel = screen().getByRole("complementary", { name: "Thread" });
    expect(
      within(panel)
        .getByRole("link", { name: /^Tarefa #129/ })
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/issues/129`);
    cleanup();
    // A direct message.
    await go(`c/${dm}`, api);
    expect(screen().getByRole("link", { name: /^Tarefa #130/ })).toBeTruthy();
  });

  test("the same number twice gives two chips", async () => {
    await go(`c/${GENERAL_ID}`, createFakeApi(withMessage("#128 de novo: #128")));
    expect(chips()).toHaveLength(2);
    expect(chips().every((c) => c.textContent?.includes(CARD.title))).toBe(true);
  });

  test("a deleted card stays text", async () => {
    const api = createFakeApi(withMessage("veja #128"));
    const r = await go(`c/${GENERAL_ID}`, api);
    expect(chips()).toHaveLength(1);
    const issue = await api.issues.get(ORG_ID, 128);
    await api.issues.delete(ORG_ID, issue.id);
    await act(
      async () => void (await r.services.queryClient.invalidateQueries({ queryKey: ["org", ORG_ID, "issues"] })),
    );
    await settle(6);
    expect(chips()).toHaveLength(0);
    expect(text()).toBe("veja #128");
  });

  test("cuts a long title inside the chip", async () => {
    const api = createFakeApi(withMessage("veja #128"));
    const title = `${"Titulo enorme ".repeat(30)}fim`;
    const issue = await api.issues.get(ORG_ID, 128);
    await api.issues.update(ORG_ID, issue.id, { title });
    await go(`c/${GENERAL_ID}`, api);
    // One chip holds the whole title and breaks inside itself (the task pill's rule), never as a row of its own.
    expect(chips()).toHaveLength(1);
    expect(chips()[0]?.className).toContain("id-ref");
    expect(chips()[0]?.closest("p")?.querySelectorAll("a")).toHaveLength(1);
    expect(chips()[0]?.textContent).toContain("fim");
  });

  test("a card of an archived board still gets its chip", async () => {
    const api = createFakeApi(withMessage("veja #128"));
    const board = await api.issues.createProject(ORG_ID, { name: "Antigo" });
    const issue = await api.issues.get(ORG_ID, 128);
    await api.issues.update(ORG_ID, issue.id, { projectId: board.id });
    await api.issues.updateProject(ORG_ID, board.id, { archived: true });
    await go(`c/${GENERAL_ID}`, api);
    expect(chips()).toHaveLength(1);
    expect(chips()[0]?.textContent).toContain(CARD.title);
  });
});

describe("the # list in the composer", () => {
  const typeIn = (el: HTMLTextAreaElement, value: string) =>
    act(async () => {
      fireEvent.change(el, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
    });
  const composer = () => screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;
  const options = () =>
    within(screen().getByRole("listbox", { name: "Canais e tarefas" })).getAllByRole("option") as HTMLElement[];

  test("typing # lists channels and cards", async () => {
    await go(`c/${GENERAL_ID}`, createFakeApi(seedState()));
    await typeIn(composer(), "veja #");
    const rows = options();
    // Channels first, then cards, eight rows at most.
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(rows[0]?.textContent).toContain("#eng");
    expect(rows[1]?.textContent).toContain("#general");
    const card = rows.find((r) => r.textContent?.includes("#128"));
    expect(card?.textContent).toContain(CARD.title);
    expect(rows.indexOf(card as HTMLElement)).toBeGreaterThan(1);
  });

  test("picking a card inserts its number", async () => {
    await go(`c/${GENERAL_ID}`, createFakeApi(seedState()));
    const box = composer();
    await typeIn(box, "veja #12");
    // 126 to 129 start with 12: the digits pick the cards whose number starts with them.
    expect(options().map((r) => r.textContent?.match(/#(\d+)/)?.[1])).toEqual(["126", "127", "128", "129"]);
    await act(async () => fireEvent.mouseDown(options()[2] as HTMLElement));
    await act(async () => fireEvent.click(options()[2] as HTMLElement));
    expect(box.value).toBe("veja #128 ");
    expect(box.getAttribute("aria-expanded")).toBe("false");
  });

  test("the list holds only the cards the member may see", async () => {
    const api = createFakeApi(seedState());
    const list = api.issues.list.bind(api.issues);
    // The server leaves out of the list the cards its reader may not see.
    api.issues.list = async (orgId, filters) => (await list(orgId, filters)).filter((i) => i.number !== 128);
    await go(`c/${GENERAL_ID}`, api);
    await typeIn(composer(), "#12");
    expect(options().map((r) => r.textContent?.match(/#(\d+)/)?.[1])).toEqual(["126", "127", "129"]);
    await typeIn(composer(), "#login");
    expect(screen().queryByRole("listbox", { name: "Canais e tarefas" })).toBeNull();
  });
});
