import { listPoCompanies, openPoChat } from "@agenteschat/engine";
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

  return app;
}
