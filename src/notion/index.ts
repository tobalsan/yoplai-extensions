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
  NotionConfigSchema,
  QueryDataSourceParamsSchema,
  ReplaceChildBlocksParamsSchema,
  UpdateDataSourceParamsSchema,
  UpdatePagePropertiesParamsSchema,
  ValidateParamsSchema,
} from "./models.js";
import { defineToolExtension } from "../tool-extension.js";

export default defineToolExtension({
  id: "notion",
  displayName: "Notion",
  description: "Generic Notion extension for data sources, pages, blocks, and file extraction.",
  systemPrompt: `Use this extension for generic Notion operations.

Tools:
- notion_list_data_sources: discover shared data sources by title
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
          return await client.listDataSources(parsed.query, parsed.pageSize, parsed.startCursor);
        },
      },
      {
        name: "get_data_source",
        description: "Fetch a data source schema and metadata.",
        parameters: GetDataSourceParamsSchema,
        execute: async (params) => {
          const parsed = GetDataSourceParamsSchema.parse(params);
          return await client.getDataSource(parsed.dataSourceId);
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
          return await client.queryDataSource(parsed);
        },
      },
      {
        name: "get_page",
        description: "Fetch a page and its property values.",
        parameters: GetPageParamsSchema,
        execute: async (params) => {
          const parsed = GetPageParamsSchema.parse(params);
          return await client.getPage(parsed.pageId);
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
          return await client.getBlocks(parsed);
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
          return await client.downloadAndExtractFile(parsed);
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
