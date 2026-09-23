import { GSheetsClient } from "./client.js";
import {
  AppendRowsParamsSchema,
  EmptyParamsSchema,
  GSheetsConfigSchema,
  InspectSpreadsheetParamsSchema,
  ListSpreadsheetsParamsSchema,
  ReadRangeParamsSchema,
  ReadSheetParamsSchema,
  UpdateRangeParamsSchema,
} from "./models.js";
import { defineToolExtension } from "../tool-extension.js";

const extension = defineToolExtension({
  id: "gsheets",
  displayName: "Google Sheets",
  description: "Google Sheets extension for spreadsheet discovery, metadata, tab reads, range reads, row appends, and range updates.",
  systemPrompt: `Use this extension for Google Sheets access.

Authentication is handled by Yoplai extension config. Do not ask for or inspect Google service account environment variables.

Tools:
- gsheets_list_spreadsheets: list accessible spreadsheets, optionally filtered by name
- gsheets_inspect_spreadsheet: inspect worksheet tabs, dimensions, and detected headers
- gsheets_read_sheet: read one worksheet as headers plus row objects. Use rowOffset, maxRows, and columns to limit large tabs when a full read is not needed
- gsheets_read_range: read an arbitrary A1 range as raw values
- gsheets_append_rows: append rows after existing table data in a range
- gsheets_update_range: overwrite cells in an exact range
- gsheets_validate: check extension authentication and access

Before writing, read the target tab or range to confirm the correct location; ask the user when the target or values are ambiguous. After writing, report the updated range and cell count.`,
  configSchema: GSheetsConfigSchema,
  requiredSecrets: ["serviceAccountJson"],
  advancedConfigFields: ["timeoutMs"],
  createTools(config) {
    const parsedConfig = GSheetsConfigSchema.parse(config.merged);
    const client = new GSheetsClient(parsedConfig);

    return [
      {
        name: "list_spreadsheets",
        description: "List one page of Google Sheets accessible to the configured service account. Optional query filters by spreadsheet name; pass pageToken from the previous result to continue.",
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
        description: "Read one worksheet as detected headers plus row objects. Supports rowOffset, maxRows, and columns for large tabs.",
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
        name: "append_rows",
        description: "Append rows after existing table data in an A1 range (e.g. 'Sheet1!A:D').",
        parameters: AppendRowsParamsSchema,
        execute(params) {
          return client.appendRows(AppendRowsParamsSchema.parse(params));
        },
      },
      {
        name: "update_range",
        description: "Overwrite cells in an exact A1 range with the given values.",
        parameters: UpdateRangeParamsSchema,
        execute(params) {
          return client.updateRange(UpdateRangeParamsSchema.parse(params));
        },
      },
      {
        name: "validate",
        description: "Validate Google Sheets extension authentication and API access.",
        parameters: EmptyParamsSchema,
        execute(params) {
          EmptyParamsSchema.parse(params);
          return client.validate();
        },
      },
    ];
  },
});

export default extension;
