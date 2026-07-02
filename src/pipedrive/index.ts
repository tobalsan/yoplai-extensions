import { PipedriveClient } from "./client.js";
import {
  ListDealsParamsSchema,
  PipedriveConfigSchema,
} from "./models.js";
import { defineToolExtension } from "../tool-extension.js";

export default defineToolExtension({
  id: "pipedrive",
  displayName: "Pipedrive",
  description:
    "Read-only Pipedrive data access for the sales pipeline: token-bounded deal retrieval with server-side filters and an expected-close-date range narrowing.",
  systemPrompt: `Use this extension to read the Pipedrive sales pipeline (read-only). pipedrive_list_deals returns a lean, token-bounded projection — narrow the pipeline with server-side filters (status, pipeline_id, stage_id, person_id, org_id, user_id) and the expected_close_from / expected_close_to date range (YYYY-MM-DD) rather than pulling every deal. status defaults to "open". To page through a large filtered result, pass the returned next_cursor back as cursor until next_cursor is null; every deal is returned exactly once with no gaps or duplicates.`,
  configSchema: PipedriveConfigSchema,
  requiredSecrets: ["apiToken", "domain"],
  createTools(config) {
    const resolved = PipedriveConfigSchema.parse(config.merged);
    const client = new PipedriveClient(resolved);

    return [
      {
        name: "list_deals",
        description:
          "List deals from the Pipedrive pipeline with a lean per-deal projection. Supports server-side filters (status [default open], pipeline_id, stage_id, person_id, org_id, user_id) and an expected-close-date range (expected_close_from / expected_close_to, YYYY-MM-DD). Returns { deals, next_cursor, count }; pass next_cursor back as cursor to page through the full filtered result.",
        parameters: ListDealsParamsSchema,
        execute: async (params) => {
          const parsed = ListDealsParamsSchema.parse(params);
          return await client.listDeals(parsed);
        },
      },
    ];
  },
});
