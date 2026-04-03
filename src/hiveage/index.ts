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
} from "./models.js";

export interface ConnectorTool {
  name: string;
  description: string;
  parameters: z.ZodObject<any>;
  execute(params: unknown): Promise<unknown>;
}

export interface ResolvedConnectorConfig {
  global: Record<string, unknown>;
  agent: Record<string, unknown>;
  merged: Record<string, unknown>;
}

export interface ConnectorDefinition {
  id: string;
  displayName: string;
  description: string;
  configSchema: z.ZodTypeAny;
  agentConfigSchema?: z.ZodTypeAny;
  requiredSecrets: string[];
  createTools(config: ResolvedConnectorConfig): ConnectorTool[];
}

export const HiveageConfigSchema = z.object({
  apiKey: z.string(),
  subdomain: z.string(),
  timeoutMs: z.number().optional().default(30_000),
});

export default {
  id: "hiveage",
  displayName: "Hiveage",
  description: "Billing connector for invoices, estimates, payments, items, clients, and trash.",
  configSchema: HiveageConfigSchema,
  requiredSecrets: ["apiKey"],
  createTools(config: ResolvedConnectorConfig): ConnectorTool[] {
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
    ];
  },
} satisfies ConnectorDefinition;
