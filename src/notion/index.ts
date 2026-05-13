import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { NotionClient } from "./client.js";
import {
  AppendBlocksParamsSchema,
  DeleteBlockParamsSchema,
  DownloadAndExtractFileParamsSchema,
  GetBlocksParamsSchema,
  GetDataSourceParamsSchema,
  GetPageParamsSchema,
  ListDataSourcesParamsSchema,
  ListPagesParamsSchema,
  NotionConfigSchema,
  QueryDataSourceParamsSchema,
  SearchPagesParamsSchema,
  ReplaceChildBlocksParamsSchema,
  UpdateDataSourceParamsSchema,
  UpdatePagePropertiesParamsSchema,
  ValidateParamsSchema,
} from "./models.js";
import { defineToolExtension } from "../tool-extension.js";

const MAX_INLINE_RESPONSE_BYTES = 200_000;

async function safeResponse(toolName: string, result: unknown): Promise<unknown> {
  const json = JSON.stringify(result, null, 2);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= MAX_INLINE_RESPONSE_BYTES) {
    return result;
  }

  const directory = path.join(os.tmpdir(), "aihub-extension-results", "notion");
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${toolName}-${Date.now()}.json`);
  await writeFile(filePath, json, "utf8");

  return {
    object: "large_response_saved",
    tool: `notion_${toolName}`,
    filePath,
    bytes,
    message: "Response was too large to return inline. Read filePath for the full JSON result.",
  };
}

export default defineToolExtension({
  id: "notion",
  displayName: "Notion",
  description: "Generic Notion extension for data sources, pages, blocks, and file extraction.",
  systemPrompt: `Use this extension for generic Notion operations.

Tools:
- notion_list_data_sources: discover shared data sources by title
- notion_list_pages: list shared pages, optionally filtered by title query
- notion_search_pages: search shared pages by title
- notion_get_data_source: inspect a data source schema and metadata
- notion_update_data_source: patch a data source schema or metadata
- notion_query_data_source: query rows from a data source
- notion_get_page: fetch a page and its property values
- notion_update_page_properties: patch page property values
- notion_get_blocks: fetch block children with pagination
- notion_append_blocks: append block children
- notion_delete_block: delete/archive a block
- notion_replace_child_blocks: replace direct child sections identified by heading text
- notion_download_and_extract_file: download a Notion file URL and extract text from PDF or DOCX
- notion_validate: verify auth and API reachability

Large read responses are saved to a local JSON file instead of returned inline; read the returned filePath for full results.
Return and consume JSON-serializable data only.`,
  configSchema: NotionConfigSchema,
  requiredSecrets: ["apiKey"],
  createTools(config) {
    const resolved = NotionConfigSchema.parse(config.merged);
    const client = new NotionClient(resolved);

    return [
      {
        name: "list_data_sources",
        description: "List or search shared data sources by title.",
        parameters: ListDataSourcesParamsSchema,
        execute: async (params) => {
          const parsed = ListDataSourcesParamsSchema.parse(params);
          return await safeResponse(
            "list_data_sources",
            await client.listDataSources(parsed.query, parsed.pageSize, parsed.startCursor),
          );
        },
      },
      {
        name: "list_pages",
        description: "List shared pages, optionally filtered by title query.",
        parameters: ListPagesParamsSchema,
        execute: async (params) => {
          const parsed = ListPagesParamsSchema.parse(params);
          return await safeResponse("list_pages", await client.listPages(parsed.query, parsed.pageSize, parsed.startCursor));
        },
      },
      {
        name: "search_pages",
        description: "Search shared pages by title.",
        parameters: SearchPagesParamsSchema,
        execute: async (params) => {
          const parsed = SearchPagesParamsSchema.parse(params);
          return await safeResponse("search_pages", await client.searchPages(parsed.query, parsed.pageSize, parsed.startCursor));
        },
      },
      {
        name: "get_data_source",
        description: "Fetch a data source schema and metadata.",
        parameters: GetDataSourceParamsSchema,
        execute: async (params) => {
          const parsed = GetDataSourceParamsSchema.parse(params);
          return await safeResponse("get_data_source", await client.getDataSource(parsed.dataSourceId));
        },
      },
      {
        name: "update_data_source",
        description: "Patch a data source schema or metadata.",
        parameters: UpdateDataSourceParamsSchema,
        execute: async (params) => {
          const parsed = UpdateDataSourceParamsSchema.parse(params);
          return await client.updateDataSource(parsed);
        },
      },
      {
        name: "query_data_source",
        description: "Query rows from a data source.",
        parameters: QueryDataSourceParamsSchema,
        execute: async (params) => {
          const parsed = QueryDataSourceParamsSchema.parse(params);
          return await safeResponse("query_data_source", await client.queryDataSource(parsed));
        },
      },
      {
        name: "get_page",
        description: "Fetch a page and its property values.",
        parameters: GetPageParamsSchema,
        execute: async (params) => {
          const parsed = GetPageParamsSchema.parse(params);
          return await safeResponse("get_page", await client.getPage(parsed.pageId));
        },
      },
      {
        name: "update_page_properties",
        description: "Patch page property values by property name or ID.",
        parameters: UpdatePagePropertiesParamsSchema,
        execute: async (params) => {
          const parsed = UpdatePagePropertiesParamsSchema.parse(params);
          return await client.updatePageProperties(parsed);
        },
      },
      {
        name: "get_blocks",
        description: "Fetch block children with optional pagination.",
        parameters: GetBlocksParamsSchema,
        execute: async (params) => {
          const parsed = GetBlocksParamsSchema.parse(params);
          return await safeResponse("get_blocks", await client.getBlocks(parsed));
        },
      },
      {
        name: "append_blocks",
        description: "Append block children to a page or block.",
        parameters: AppendBlocksParamsSchema,
        execute: async (params) => {
          const parsed = AppendBlocksParamsSchema.parse(params);
          return await client.appendBlocks(parsed);
        },
      },
      {
        name: "delete_block",
        description: "Delete or archive a block.",
        parameters: DeleteBlockParamsSchema,
        execute: async (params) => {
          const parsed = DeleteBlockParamsSchema.parse(params);
          return await client.deleteBlock(parsed.blockId);
        },
      },
      {
        name: "replace_child_blocks",
        description:
          "Replace direct child sections identified by heading text; appends new blocks before deleting old matches.",
        parameters: ReplaceChildBlocksParamsSchema,
        execute: async (params) => {
          const parsed = ReplaceChildBlocksParamsSchema.parse(params);
          return await client.replaceChildBlocks(parsed);
        },
      },
      {
        name: "download_and_extract_file",
        description: "Download a file URL and extract text from PDF or DOCX content.",
        parameters: DownloadAndExtractFileParamsSchema,
        execute: async (params) => {
          const parsed = DownloadAndExtractFileParamsSchema.parse(params);
          return await safeResponse("download_and_extract_file", await client.downloadAndExtractFile(parsed));
        },
      },
      {
        name: "validate",
        description: "Validate configuration and API reachability.",
        parameters: ValidateParamsSchema,
        execute: async (params) => {
          ValidateParamsSchema.parse(params);
          return await client.validate();
        },
      },
    ];
  },
});
