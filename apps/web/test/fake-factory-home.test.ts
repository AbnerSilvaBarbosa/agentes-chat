import { describe, expect, test } from "bun:test";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";

/** The fake api makes the factory home from its own tasks and columns, by the engine's rules. */
async function scene() {
  const api = createFakeApi(seedState());
  const space = await api.issues.createSpace(ORG_ID, { name: "Clínica Teo" });
  const other = await api.issues.createSpace(ORG_ID, { name: "Beta" });
  const board = await api.issues.createProject(ORG_ID, { name: "Entregas", spaceId: space.id });
  const otherBoard = await api.issues.createProject(ORG_ID, { name: "Site", spaceId: other.id });
  const added = await api.issues.addColumn(ORG_ID, { name: "Teste humano", stage: "in_review" });
  const column = added.find((c) => c.name === "Teste humano");
  if (!column) throw new Error("no column");
  await api.issues.updateColumn(ORG_ID, column.id, { waitsForPerson: true });
  const task = async (title: string, projectId: string, columnId?: string) => {
    const made = await api.issues.create(ORG_ID, { title, projectId });
    return columnId ? api.issues.update(ORG_ID, made.id, { columnId }) : made;
  };
  return { api, space, other, board, otherBoard, column, task };
}

describe("the fake api's factoryHome", () => {
  test("makes a panel per company with a live task and lists what waits, longest first", async () => {
    const { api, space, board, otherBoard, column, task } = await scene();
    const waiting = await task("Revisar a tela", board.id, column.id);
    await task("A fazer", board.id);
    await task("Do outro", otherBoard.id);
    const home = await api.issues.factoryHome(ORG_ID);
    expect(home.companiesTotal).toBe(2);
    // Most waiting first.
    expect(home.companies.map((c) => c.name)).toEqual(["Clínica Teo", "Beta"]);
    expect(home.companies[0]).toMatchObject({ id: space.id, waiting: 1, stages: { todo: 1, in_review: 1 } });
    expect(home.companies[1]).toMatchObject({ waiting: 0, stages: { todo: 1 } });
    expect(home.waiting.total).toBe(1);
    expect(home.waiting.items[0]).toMatchObject({
      id: waiting.id,
      number: waiting.number,
      spaceName: "Clínica Teo",
      projectName: "Entregas",
      columnName: "Teste humano",
    });
  });

  test("leaves out canceled tasks and archived boards and companies, and makes no panel for an empty company", async () => {
    const { api, space, board, otherBoard, column, task } = await scene();
    await task("Viva", board.id, column.id);
    const canceled = await task("Cancelada", board.id, column.id);
    await api.issues.update(ORG_ID, canceled.id, { status: "canceled" });
    await task("Arquivada", otherBoard.id, column.id);
    await api.issues.updateProject(ORG_ID, otherBoard.id, { archived: true });
    await api.issues.createSpace(ORG_ID, { name: "Vazia" });
    const home = await api.issues.factoryHome(ORG_ID);
    expect(home.companies.map((c) => c.id)).toEqual([space.id]);
    expect(home.waiting.total).toBe(1);
  });

  test("the list answers waiting=person with the same tasks", async () => {
    const { api, board, column, task } = await scene();
    const waiting = await task("Revisar a tela", board.id, column.id);
    await task("A fazer", board.id);
    const listed = await api.issues.list(ORG_ID, { waiting: "person" });
    expect(listed.map((i) => i.id)).toEqual([waiting.id]);
    expect((await api.issues.list(ORG_ID, {})).length).toBeGreaterThan(1);
  });
});
