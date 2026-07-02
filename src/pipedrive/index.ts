import { PipedriveClient } from "./client.js";
import {
  DownloadFileParamsSchema,
  ListDealFilesParamsSchema,
  ListDealsParamsSchema,
  PipedriveConfigSchema,
} from "./models.js";
import { defineToolExtension } from "../tool-extension.js";

export default defineToolExtension({
  id: "pipedrive",
  displayName: "Pipedrive",
  description:
    "Read-only Pipedrive data access for the sales pipeline: token-bounded deal retrieval with server-side filters and an expected-close-date range narrowing.",
  systemPrompt: `Use this extension to read the Pipedrive sales pipeline (read-only). pipedrive_list_deals returns a lean, token-bounded projection — narrow the pipeline with server-side filters (status, pipeline_id, stage_id, person_id, org_id, user_id) and the expected_close_from / expected_close_to date range (YYYY-MM-DD) rather than pulling every deal. status defaults to "open". To page through a large filtered result, pass the returned next_cursor back as cursor until next_cursor is null; every deal is returned exactly once with no gaps or duplicates.

To work with a deal's attachments (e.g. the sales-uploaded Excel/doc that holds the sale info): call pipedrive_list_deal_files with a deal_id to see each file's name, type, and size, pick the right file, then call pipedrive_download_file with its file_id. download_file returns the RAW bytes base64-encoded (content_base64) — the extension never parses or transforms the file. Decode and parse it downstream in your workflow.`,
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
      {
        name: "list_deal_files",
        description:
          "List the files/attachments on a deal with a lean metadata projection so you can pick the right one. Returns { files, count } where each file has { id, name, type, size (bytes), deal_id, add_time, url }. Returns up to 500 files (deals rarely have more). Read-only; nothing is downloaded or parsed. Pass a file's id to download_file to fetch its bytes.",
        parameters: ListDealFilesParamsSchema,
        execute: async (params) => {
          const parsed = ListDealFilesParamsSchema.parse(params);
          return await client.listDealFiles(parsed);
        },
      },
      {
        name: "download_file",
        description:
          "Download a deal file's RAW bytes by file_id — content is NOT parsed or transformed. Return shape (decided for this extension): the bytes are base64-encoded in content_base64 rather than saved to a workspace path, so the result is self-contained and binary formats (e.g. .xlsx) round-trip through JSON with byte integrity intact. Returns { file_id, name, mime_type, size (exact byte length), encoding: 'base64', content_base64 }. Decode and parse downstream in your workflow.",
        parameters: DownloadFileParamsSchema,
        execute: async (params) => {
          const parsed = DownloadFileParamsSchema.parse(params);
          return await client.downloadFile(parsed);
        },
      },
    ];
  },
});
