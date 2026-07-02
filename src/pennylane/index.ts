import { z } from "zod";
import { PennylaneClient } from "./client.js";
import {
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
} from "./models.js";
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
- pennylane_get_invoice: fetch a single customer invoice by id
- pennylane_list_quotes / pennylane_search_quotes / pennylane_get_quote: read quotes (devis)
- pennylane_list_customers / pennylane_search_customers / pennylane_get_customer: read customers
- pennylane_list_products / pennylane_search_products / pennylane_get_product: read products
- pennylane_list_vat_rates: discover valid vat_rate codes (e.g. FR_200 = 20%)

Key concepts:
- money values are decimal strings (e.g. "230.32"), never floats or cents
- dates are YYYY-MM-DD; ids are int64 returned as strings
- cursor pagination is walked transparently: omit "cursor" to get everything, or pass a "cursor" to fetch a single page
- prefer search_invoices when you know the customer, external_reference (Pipedrive deal id), status, or date range; filters are AND-combined server-side
- external_reference is the Pipedrive deal/org id hook (invoices support only eq on it)
- quotes are NOT server-side filterable on external_reference: search_quotes filters by customer_id (and status) server-side, then matches external_reference client-side
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
    ];
  },
});
