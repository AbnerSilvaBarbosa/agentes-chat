import { confirmCardProposal, dismissCardProposal, listPoCompanies, openPoChat, poProgress } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["PO"];

const Company = z
  .object({
    id: z.uuid(),
    name: z.string(),
    color: z.string(),
    image: z.string().nullable(),
    archived: z.boolean(),
    open: z.number().int().openapi({ description: "Open cards of the company that the reader sees." }),
    unread: z.number().int().openapi({ description: "Messages of that chat the reader has not read." }),
    channelId: z.uuid().nullable().openapi({
      description: "The reader's PO chat for this company, once it exists; null before the first message.",
    }),
  })
  .openapi("PoCompany");

const PoOverview = z
  .object({
    agentId: z.uuid().nullable().openapi({ description: "The workspace's PO; null: none, and no PO chat opens." }),
    companies: z.array(Company),
  })
  .openapi("PoOverview");

const OpenedChat = z
  .object({
    channelId: z.uuid(),
    agentId: z.uuid(),
    space: z.object({
      id: z.uuid(),
      name: z.string(),
      color: z.string(),
      image: z.string().nullable(),
      archived: z.boolean(),
    }),
  })
  .openapi("PoChat");

const CardProposal = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    requesterUserId: z.string(),
    spaceId: z.uuid(),
    title: z.string(),
    summary: z.string(),
    criteria: z.array(z.string()),
    project: z.object({ id: z.uuid(), name: z.string() }),
    status: z.enum(["pending", "confirmed", "dismissed"]),
    duplicateOf: z.object({ number: z.number().int(), title: z.string() }).nullable(),
    issue: z.object({ id: z.uuid(), number: z.number().int() }).nullable(),
    spec: z
      .object({
        state: z.enum(["queued", "running", "done", "failed", "stopped"]),
        page: z.object({ slug: z.string(), title: z.string() }).nullable(),
        error: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi("CardProposal");

const ProposalParams = OrgParams.extend({ proposalId: z.uuid() });

const ProgressCard = z.object({
  id: z.uuid(),
  number: z.number().int(),
  title: z.string(),
  boardId: z.uuid(),
  boardName: z.string(),
  since: z.string().openapi({ description: "ISO time the card entered its column." }),
  spec: z
    .object({
      state: z.enum(["queued", "running", "done", "failed", "stopped"]),
      page: z.object({ slug: z.string(), title: z.string() }).nullable(),
      error: z.string().nullable(),
      queuedAt: z.string().nullable().openapi({ description: "ISO time the spec was queued." }),
    })
    .nullable(),
  releaseTo: z.object({ id: z.uuid(), name: z.string() }).optional().openapi({
    description:
      "The board's Ready for dev column, only on a finished spec's card waiting in Especificado (Priorizado on older boards) and only for a reader who may move cards.",
  }),
});

const PoProgress = z
  .object({
    space: z.object({ id: z.uuid(), name: z.string() }),
    groups: z
      .array(
        z.object({
          key: z.string(),
          kind: z.enum(["column", "tail"]),
          stage: z.enum(["todo", "in_progress", "in_review", "done", "canceled"]),
          name: z.string().nullable().openapi({ description: "Null: the stage's own name, or the tail's label." }),
          columns: z
            .array(z.string())
            .openapi({ description: "The keys the task list is asked for to see the group." }),
          count: z.number().int(),
          items: z.array(ProgressCard).openapi({ description: "At most 8, longest in the column first." }),
        }),
      )
      .openapi({ description: "The company's boards' columns in board order, then the tail." }),
    done: z.number().int().openapi({ description: "Done cards the reader sees: one number, never rows." }),
  })
  .openapi("PoProgress");

const CompanyParams = OrgParams.extend({ spaceId: z.uuid() });

/** The PO chat per company (ADR 0185): the PO and its companies, and opening the person's chat for one. */
export function poRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/po",
      tags,
      security,
      summary: "The workspace's PO and the companies a PO chat opens for",
      request: { params: OrgParams },
      responses: { 200: json(PoOverview), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await listPoCompanies(db, c.get("user").id, orgId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/po/companies/{spaceId}/progress",
      tags,
      security,
      summary: "A company's open cards by stage, for the progress panel of its PO chat",
      description:
        "Grouped by the columns of the company's boards, only the cards the reader sees (ADR 0151); canceled cards and the cards of archived boards are in no number.",
      request: { params: CompanyParams },
      responses: { 200: json(PoProgress), ...errors },
    }),
    async (c) => {
      const { orgId, spaceId } = c.req.valid("param");
      return c.json(await poProgress(db, c.get("user").id, orgId, spaceId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/po/chats",
      tags,
      security,
      summary: "Open my PO chat for a company (made the first time)",
      request: { params: OrgParams, body: body(z.object({ spaceId: z.uuid() })) },
      responses: { 200: json(OpenedChat), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { spaceId } = c.req.valid("json");
      return c.json(await openPoChat(db, c.get("user").id, orgId, spaceId, { pubsub: adapters.pubsub }), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/card-proposals/{proposalId}/confirm",
      tags,
      security,
      summary: "Confirm a PO's card proposal: creates the card as you, in the board's Especificar column",
      description:
        "Only the person who asked decides. The fields may be edited first; the answer shows what was created. A proposal already decided is refused with `card_proposal.decided`. A refusal of the card itself (no right to post, an archived board) leaves the proposal pending.",
      request: {
        params: ProposalParams,
        body: {
          ...body(
            z.object({
              title: z.string().max(300).optional(),
              summary: z.string().max(20_000).optional(),
              criteria: z.array(z.string().max(500)).max(30).optional(),
              projectId: z.uuid().optional(),
            }),
          ),
          required: false,
        },
      },
      responses: { 200: json(CardProposal), ...errors },
    }),
    async (c) => {
      const { orgId, proposalId } = c.req.valid("param");
      const edits = c.req.valid("json") ?? {};
      return c.json(
        await confirmCardProposal({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, proposalId, edits),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/card-proposals/{proposalId}/dismiss",
      tags,
      security,
      summary: "Discard a PO's card proposal: nothing is created",
      request: { params: ProposalParams },
      responses: { 200: json(CardProposal), ...errors },
    }),
    async (c) => {
      const { orgId, proposalId } = c.req.valid("param");
      return c.json(
        await dismissCardProposal({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, proposalId),
        200,
      );
    },
  );

  return app;
}
