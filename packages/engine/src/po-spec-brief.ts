import { cleanFolder } from "./wiki";

/**
 * The wiki folder a company's specs live in (ADR 0185): `Specs/<company>`. A `/` in the name would make a folder level
 * of its own, so it becomes `-`. The wiki tools of a PO chat keep to this folder among the `Specs/` pages.
 */
export const specFolder = (company: string) => cleanFolder(`Specs/${company.replace(/\//g, "-")}`);
