import { z } from "zod";
import { PennylaneClient } from "./client.js";
import { ListInvoicesParamsSchema, SearchInvoicesParamsSchema } from "./models.js";
import { defineToolExtension } from "../tool-extension.js";

export const PennylaneConfigSchema = z.object({
  apiToken: z.string(),
  timeoutMs: z.number().optional().default(30_000),
});

export default defineToolExtension({
  id: "pennylane",
  displayName: "Pennylane",
  description: "Read and search Pennylane customer invoices, quotes, customers, and products (draft-safe).",
  systemPrompt: `Use this extension for Pennylane (Company API v2) accounting operations.

Available tools:
- pennylane_list_invoices: list customer invoices with cursor pagination handled for you
- pennylane_search_invoices: filter customer invoices by customer, external_reference, status, and date range

Key concepts:
- money values are decimal strings (e.g. "230.32"), never floats or cents
- dates are YYYY-MM-DD; ids are int64 returned as strings
- cursor pagination is walked transparently: omit "cursor" to get all invoices, or pass a "cursor" to fetch a single page
- prefer search_invoices when you know the customer, external_reference (Pipedrive deal id), status, or date range; filters are AND-combined server-side
- external_reference is the Pipedrive deal/org id hook (invoices support only eq on it)
- the client self-throttles to Pennylane's rate limit (25 requests / 5 s per token) and retries on 429`,
  configSchema: PennylaneConfigSchema,
  requiredSecrets: ["apiToken"],
  createTools(config) {
    const resolved = PennylaneConfigSchema.parse(config.merged);
    const client = new PennylaneClient(resolved);

    return [
      {
        name: "list_invoices",
        description: "List customer invoices with pagination (cursor walked transparently).",
        parameters: ListInvoicesParamsSchema,
        execute: (params) => client.listInvoices(params),
      },
      {
        name: "search_invoices",
        description:
          "Search customer invoices by customer, external_reference, status, and date range. Filters are AND-combined server-side via the Pennylane filter DSL.",
        parameters: SearchInvoicesParamsSchema,
        execute: (params) => client.searchInvoices(params),
      },
    ];
  },
});
