import { z } from "zod";

import { GSheetsClient } from "./client.js";
import {
  EmptyParamsSchema,
  GSheetsConfigSchema,
  InspectSpreadsheetParamsSchema,
  ListSpreadsheetsParamsSchema,
  ReadRangeParamsSchema,
  ReadSheetParamsSchema,
} from "./models.js";

interface ConnectorTool {
  name: string;
  description: string;
  parameters: z.ZodObject<z.ZodRawShape>;
  execute(params: unknown): Promise<unknown>;
}

interface ResolvedConnectorConfig {
  global: Record<string, unknown>;
  agent: Record<string, unknown>;
  merged: Record<string, unknown>;
}

interface ConnectorDefinition {
  id: string;
  displayName: string;
  description: string;
  systemPrompt?: string;
  configSchema: z.ZodTypeAny;
  agentConfigSchema?: z.ZodTypeAny;
  requiredSecrets: string[];
  createTools(config: ResolvedConnectorConfig): ConnectorTool[];
}

const connector: ConnectorDefinition = {
  id: "gsheets",
  displayName: "Google Sheets",
  description: "Read-only Google Sheets connector for spreadsheet discovery, metadata, tab reads, and range reads.",
  systemPrompt: `Use this connector for read-only Google Sheets access.

Authentication is handled by AIHub connector config. Do not ask for or inspect Google service account environment variables.

Tools:
- gsheets_list_spreadsheets: list accessible spreadsheets, optionally filtered by name
- gsheets_inspect_spreadsheet: inspect worksheet tabs, dimensions, and detected headers
- gsheets_read_sheet: read one worksheet as headers plus row objects
- gsheets_read_range: read an arbitrary A1 range as raw values
- gsheets_validate: check connector authentication and access`,
  configSchema: GSheetsConfigSchema,
  requiredSecrets: ["serviceAccountJson"],
  createTools(config) {
    const parsedConfig = GSheetsConfigSchema.parse(config.merged);
    const client = new GSheetsClient(parsedConfig);

    return [
      {
        name: "list_spreadsheets",
        description: "List Google Sheets accessible to the configured service account. Optional query filters by spreadsheet name.",
        parameters: ListSpreadsheetsParamsSchema,
        execute(params) {
          return client.listSpreadsheets(ListSpreadsheetsParamsSchema.parse(params));
        },
      },
      {
        name: "inspect_spreadsheet",
        description: "Inspect a spreadsheet's tabs, dimensions, and detected headers.",
        parameters: InspectSpreadsheetParamsSchema,
        execute(params) {
          return client.inspectSpreadsheet(InspectSpreadsheetParamsSchema.parse(params));
        },
      },
      {
        name: "read_sheet",
        description: "Read one worksheet as detected headers plus row objects.",
        parameters: ReadSheetParamsSchema,
        execute(params) {
          return client.readSheet(ReadSheetParamsSchema.parse(params));
        },
      },
      {
        name: "read_range",
        description: "Read an arbitrary A1 range from a spreadsheet as raw values.",
        parameters: ReadRangeParamsSchema,
        execute(params) {
          return client.readRange(ReadRangeParamsSchema.parse(params));
        },
      },
      {
        name: "validate",
        description: "Validate Google Sheets connector authentication and API access.",
        parameters: EmptyParamsSchema,
        execute(params) {
          EmptyParamsSchema.parse(params);
          return client.validate();
        },
      },
    ];
  },
};

export default connector;
