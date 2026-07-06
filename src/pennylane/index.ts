import { z } from "zod";
import { PennylaneClient } from "./client.js";
import {
  CreateInvoiceDraftParamsSchema,
  CreateQuoteParamsSchema,
  GetCustomerParamsSchema,
  GetInvoiceParamsSchema,
  GetProductParamsSchema,
  GetQuoteParamsSchema,
  ListInvoicesParamsSchema,
  ListParamsSchema,
  ListVatRatesParamsSchema,
  SearchCustomersParamsSchema,
  SearchInvoicesParamsSchema,
  SearchProductsParamsSchema,
  SearchQuotesParamsSchema,
  UpdateInvoiceDraftParamsSchema,
  UpdateQuoteParamsSchema,
} from "./models.js";
import { defineToolExtension } from "../tool-extension.js";

export const PennylaneConfigSchema = z.object({
  apiToken: z
    .string()
    .describe("Pennylane API token. Generate one under Settings > API in your Pennylane account."),
  timeoutMs: z
    .number()
    .optional()
    .default(30_000)
    .describe("Request timeout in milliseconds for Pennylane API calls. Defaults to 30000."),
});

const ValidateParamsSchema = z.object({}).strict();

export default defineToolExtension({
  id: "pennylane",
  displayName: "Pennylane",
  description: "Read, search, and draft-write Pennylane customer invoices and quotes, plus read customers and products (draft-safe: never finalizes, accepts, or sends).",
  systemPrompt: `Use this extension for Pennylane (Company API v2) accounting operations.

Available tools:
- pennylane_list_invoices: list customer invoices with cursor pagination handled for you
- pennylane_search_invoices: filter customer invoices by customer, external_reference, status, and date range
- pennylane_get_invoice: fetch a single customer invoice by id
- pennylane_list_quotes / pennylane_search_quotes / pennylane_get_quote: read quotes (devis)
- pennylane_list_customers / pennylane_search_customers / pennylane_get_customer: read customers
- pennylane_list_products / pennylane_search_products / pennylane_get_product: read products
- pennylane_list_vat_rates: discover valid vat_rate codes (e.g. FR_200 = 20%)
- pennylane_validate: verify auth and API reachability
- pennylane_create_invoice_draft: create a customer invoice as an editable DRAFT (draft: true); pass external_reference (Pipedrive deal id) for dedup
- pennylane_update_invoice_draft: edit an existing invoice draft; refuses if the target is already finalized (DraftGuard)
- pennylane_create_quote: create a quote (devis); it is always created 'pending' (quotes have no draft state); pass external_reference (Pipedrive deal id) for dedup
- pennylane_update_quote: edit an existing quote; refuses via DraftGuard unless the target is still 'pending'; invoice_lines uses a { create, update, delete } diff

Key concepts:
- money values are decimal strings (e.g. "230.32"), never floats or cents
- dates are YYYY-MM-DD; ids are int64 returned as strings
- cursor pagination is walked transparently: omit "cursor" to get everything, or pass a "cursor" to fetch a single page
- prefer search_invoices when you know the customer, external_reference (Pipedrive deal id), status, or date range; filters are AND-combined server-side
- external_reference is the Pipedrive deal/org id hook (invoices support only eq on it)
- writes are draft-only and safety-gated: create_invoice_draft always sets draft: true, and update_invoice_draft routes the target through DraftGuard, refusing to touch a finalized invoice. There is deliberately NO finalize or send tool
- quotes have no draft state: create_quote always yields a 'pending' quote (the draft-equivalent), and update_quote routes the target through DraftGuard, refusing to touch any non-'pending' quote (accepted/denied/invoiced/expired/sent). There is deliberately NO quote accept/status/send tool
- Pennylane has no idempotency keys: before creating, look up by external_reference (search_invoices / search_quotes) to avoid duplicate drafts
- quotes are NOT server-side filterable on external_reference: search_quotes filters by customer_id (and status) server-side, then matches external_reference client-side
- update_quote's invoice_lines is a diff object { create, update, delete } (not a flat array like invoice drafts); each updated/deleted line is addressed by its id
- customers can be fetched by internal id OR external_reference via get_customer
- vat_rate is a fixed enum (no list endpoint); use list_vat_rates to discover valid codes like FR_200 (20%), FR_100 (10%), FR_55 (5.5%), exempt (0%)
- the client self-throttles to Pennylane's rate limit (25 requests / 5 s per token) and retries on 429`,
  configSchema: PennylaneConfigSchema,
  requiredSecrets: ["apiToken"],
  createTools(config) {
    const resolved = PennylaneConfigSchema.parse(config.merged);
    const client = new PennylaneClient(resolved);

    return [
      {
        name: "validate",
        description: "Validate Pennylane auth and API reachability via GET /me.",
        parameters: ValidateParamsSchema,
        execute: (params) => {
          ValidateParamsSchema.parse(params);
          return client.validate();
        },
      },
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
      {
        name: "get_invoice",
        description: "Get a single customer invoice by its id.",
        parameters: GetInvoiceParamsSchema,
        execute: (params) => client.getInvoice(params),
      },
      {
        name: "list_quotes",
        description: "List quotes (devis) with pagination (cursor walked transparently).",
        parameters: ListParamsSchema,
        execute: (params) => client.listQuotes(params),
      },
      {
        name: "search_quotes",
        description:
          "Search quotes by customer_id and status (server-side). external_reference is matched client-side on the returned quotes, since quotes are not server-side filterable on it.",
        parameters: SearchQuotesParamsSchema,
        execute: (params) => client.searchQuotes(params),
      },
      {
        name: "get_quote",
        description: "Get a single quote by its id.",
        parameters: GetQuoteParamsSchema,
        execute: (params) => client.getQuote(params),
      },
      {
        name: "list_customers",
        description: "List customers with pagination (cursor walked transparently).",
        parameters: ListParamsSchema,
        execute: (params) => client.listCustomers(params),
      },
      {
        name: "search_customers",
        description:
          "Search customers by external_reference, name, and customer_type. Filters are AND-combined server-side.",
        parameters: SearchCustomersParamsSchema,
        execute: (params) => client.searchCustomers(params),
      },
      {
        name: "get_customer",
        description:
          "Get a single customer by its internal id or by external_reference (the Pipedrive org/person id). Provide exactly one.",
        parameters: GetCustomerParamsSchema,
        execute: (params) => client.getCustomer(params),
      },
      {
        name: "list_products",
        description: "List products with pagination (cursor walked transparently).",
        parameters: ListParamsSchema,
        execute: (params) => client.listProducts(params),
      },
      {
        name: "search_products",
        description:
          "Search products by external_reference, label, and reference. Filters are AND-combined server-side.",
        parameters: SearchProductsParamsSchema,
        execute: (params) => client.searchProducts(params),
      },
      {
        name: "get_product",
        description: "Get a single product by its id.",
        parameters: GetProductParamsSchema,
        execute: (params) => client.getProduct(params),
      },
      {
        name: "list_vat_rates",
        description:
          "List the discoverable Pennylane vat_rate codes (e.g. FR_200 = 20%). Static reference; no network call.",
        parameters: ListVatRatesParamsSchema,
        execute: (params) => client.listVatRates(params),
      },
      {
        name: "create_invoice_draft",
        description:
          "Create a customer invoice as an editable DRAFT (always draft: true — never finalizes). Accepts external_reference (Pipedrive deal id) for correlation/dedup. Requires customer_id, date, deadline, and at least one invoice line.",
        parameters: CreateInvoiceDraftParamsSchema,
        execute: (params) => client.createInvoiceDraft(params),
      },
      {
        name: "update_invoice_draft",
        description:
          "Edit an existing invoice draft (full replace, stays draft: true). Routes the target through DraftGuard first and refuses to touch a finalized invoice. Cannot finalize or send.",
        parameters: UpdateInvoiceDraftParamsSchema,
        execute: (params) => client.updateInvoiceDraft(params),
      },
      {
        name: "create_quote",
        description:
          "Create a quote (devis). Pennylane quotes have no draft state — the created quote is always 'pending' (the draft-equivalent). Accepts external_reference (Pipedrive deal id) for correlation/dedup. Requires customer_id, date, deadline, and at least one line. Does NOT accept or send the quote.",
        parameters: CreateQuoteParamsSchema,
        execute: (params) => client.createQuote(params),
      },
      {
        name: "update_quote",
        description:
          "Edit an existing quote. Routes the target through DraftGuard first and refuses to touch any non-'pending' quote (accepted/denied/invoiced/expired/sent). invoice_lines uses a { create, update, delete } diff object. Cannot change status, accept, or send.",
        parameters: UpdateQuoteParamsSchema,
        execute: (params) => client.updateQuote(params),
      },
    ];
  },
});
