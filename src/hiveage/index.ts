import { z } from "zod";
import { HiveageClient } from "./client.js";
import {
  CreateEstimateParamsSchema,
  CreateInvoiceParamsSchema,
  CreatePaymentParamsSchema,
  CreateRecurringInvoiceParamsSchema,
  GetConnectionParamsSchema,
  GetEstimateParamsSchema,
  GetInvoiceParamsSchema,
  GetItemParamsSchema,
  GetPaymentParamsSchema,
  GetRecurringInvoiceParamsSchema,
  ListConnectionsParamsSchema,
  ListEstimatesParamsSchema,
  ListInvoicesParamsSchema,
  ListItemsParamsSchema,
  ListPaymentsParamsSchema,
  ListRecurringInvoicesParamsSchema,
  ListTrashParamsSchema,
  SearchConnectionsParamsSchema,
  SearchEstimatesParamsSchema,
  SearchInvoicesParamsSchema,
  SearchItemsParamsSchema,
  SearchRecurringInvoicesParamsSchema,
  ValidateEstimateParamsSchema,
  validateEstimateData,
} from "./models.js";
import { defineToolExtension } from "../tool-extension.js";

export const HiveageConfigSchema = z.object({
  apiKey: z
    .string()
    .describe("Hiveage API key used as the Basic auth username. Find it under Settings > API in your Hiveage account."),
  subdomain: z
    .string()
    .regex(
      /^(?=.{1,63}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/,
      "Hiveage subdomain must be a single valid DNS label",
    )
    .describe("Your Hiveage account subdomain, e.g. \"acme\" for https://acme.hiveage.com."),
  timeoutMs: z
    .number()
    .optional()
    .default(30_000)
    .describe("Request timeout in milliseconds for Hiveage API calls. Defaults to 30000."),
});

export default defineToolExtension({
  id: "hiveage",
  displayName: "Hiveage",
  description: "Billing extension for invoices, estimates, payments, items, clients, and trash.",
  systemPrompt: `Use this extension for Hiveage billing and invoicing operations.

Available tools:
- hiveage_list_invoices, hiveage_get_invoice, hiveage_create_invoice, hiveage_search_invoices: invoice management
- hiveage_list_recurring_invoices, hiveage_get_recurring_invoice, hiveage_create_recurring_invoice, hiveage_search_recurring_invoices: recurring invoice management
- hiveage_list_estimates, hiveage_get_estimate, hiveage_create_estimate, hiveage_search_estimates: estimate and quote management
- hiveage_list_payments, hiveage_get_payment, hiveage_create_payment: payment tracking
- hiveage_list_items, hiveage_get_item, hiveage_search_items: catalog item management
- hiveage_list_connections, hiveage_get_connection, hiveage_search_connections: client and connection management
- hiveage_list_trash: view deleted items
- hiveage_validate_estimate: validate estimate payload before creation (checks required fields, dates, line items, discounts)

Key concepts:
- connections are clients or customers in Hiveage
- invoices, estimates, and recurring invoices use hash keys as identifiers
- line items define billable rows on invoices and estimates

Common workflows:
- To create an invoice, first find the connection (client) using hiveage_search_connections or hiveage_list_connections, then hiveage_create_invoice with the connection hash key and line items.
- To find a specific invoice, use hiveage_search_invoices with a query string, or hiveage_list_invoices with pagination.`,
  configSchema: HiveageConfigSchema,
  requiredSecrets: ["apiKey"],
  advancedConfigFields: ["timeoutMs"],
  createTools(config) {
    const resolved = HiveageConfigSchema.parse(config.merged);
    const client = new HiveageClient(resolved);

    return [
      {
        name: "list_invoices",
        description: "List invoices with pagination.",
        parameters: ListInvoicesParamsSchema,
        execute: (params) => client.listInvoices(params),
      },
      {
        name: "get_invoice",
        description: "Get a single invoice by hash key.",
        parameters: GetInvoiceParamsSchema,
        execute: (params) => client.getInvoice(params),
      },
      {
        name: "create_invoice",
        description: "Create an invoice.",
        parameters: CreateInvoiceParamsSchema,
        execute: (params) => client.createInvoice(params),
      },
      {
        name: "search_invoices",
        description: "Search invoices.",
        parameters: SearchInvoicesParamsSchema,
        execute: (params) => client.searchInvoices(params),
      },
      {
        name: "list_recurring_invoices",
        description: "List recurring invoices with pagination.",
        parameters: ListRecurringInvoicesParamsSchema,
        execute: (params) => client.listRecurringInvoices(params),
      },
      {
        name: "get_recurring_invoice",
        description: "Get a recurring invoice by hash key.",
        parameters: GetRecurringInvoiceParamsSchema,
        execute: (params) => client.getRecurringInvoice(params),
      },
      {
        name: "create_recurring_invoice",
        description: "Create a recurring invoice.",
        parameters: CreateRecurringInvoiceParamsSchema,
        execute: (params) => client.createRecurringInvoice(params),
      },
      {
        name: "search_recurring_invoices",
        description: "Search recurring invoices.",
        parameters: SearchRecurringInvoicesParamsSchema,
        execute: (params) => client.searchRecurringInvoices(params),
      },
      {
        name: "list_estimates",
        description: "List estimates with pagination.",
        parameters: ListEstimatesParamsSchema,
        execute: (params) => client.listEstimates(params),
      },
      {
        name: "get_estimate",
        description: "Get an estimate by hash key.",
        parameters: GetEstimateParamsSchema,
        execute: (params) => client.getEstimate(params),
      },
      {
        name: "create_estimate",
        description: "Create an estimate.",
        parameters: CreateEstimateParamsSchema,
        execute: (params) => client.createEstimate(params),
      },
      {
        name: "search_estimates",
        description: "Search estimates.",
        parameters: SearchEstimatesParamsSchema,
        execute: (params) => client.searchEstimates(params),
      },
      {
        name: "list_payments",
        description: "List payments for an invoice.",
        parameters: ListPaymentsParamsSchema,
        execute: (params) => client.listPayments(params),
      },
      {
        name: "get_payment",
        description: "Get a payment for an invoice.",
        parameters: GetPaymentParamsSchema,
        execute: (params) => client.getPayment(params),
      },
      {
        name: "create_payment",
        description: "Create a payment for an invoice.",
        parameters: CreatePaymentParamsSchema,
        execute: (params) => client.createPayment(params),
      },
      {
        name: "list_items",
        description: "List catalog items.",
        parameters: ListItemsParamsSchema,
        execute: (params) => client.listItems(params),
      },
      {
        name: "get_item",
        description: "Get a catalog item by id.",
        parameters: GetItemParamsSchema,
        execute: (params) => client.getItem(params),
      },
      {
        name: "search_items",
        description: "Search catalog items.",
        parameters: SearchItemsParamsSchema,
        execute: (params) => client.searchItems(params),
      },
      {
        name: "list_connections",
        description: "List connections.",
        parameters: ListConnectionsParamsSchema,
        execute: (params) => client.listConnections(params),
      },
      {
        name: "get_connection",
        description: "Get a connection by hash key.",
        parameters: GetConnectionParamsSchema,
        execute: (params) => client.getConnection(params),
      },
      {
        name: "search_connections",
        description: "Search connections.",
        parameters: SearchConnectionsParamsSchema,
        execute: (params) => client.searchConnections(params),
      },
      {
        name: "list_trash",
        description: "List trash items.",
        parameters: ListTrashParamsSchema,
        execute: (params) => client.listTrash(params),
      },
      {
        name: "validate_estimate",
        description:
          "Validate a renewal estimate payload before creating it. Checks required fields (connectionId, date, expireDate, statementNo), date formats, line item completeness, and discount structure. Returns {valid, issues}.",
        parameters: ValidateEstimateParamsSchema,
        execute: async (params) => validateEstimateData(params),
      },
    ];
  },
});
