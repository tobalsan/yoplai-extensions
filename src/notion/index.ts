import { NotionClient } from "./client.js";
import { NotionFileExtractionError } from "./errors.js";
import {
  AppendBlocksParamsSchema,
  CreatePageParamsSchema,
  DeleteBlockParamsSchema,
  DownloadAndExtractFileParamsSchema,
  GetBlocksParamsSchema,
  GetDataSourceParamsSchema,
  GetPageMarkdownParamsSchema,
  GetPageParamsSchema,
  ListDataSourcesParamsSchema,
  ListPagesParamsSchema,
  NotionConfigSchema,
  QueryDataSourceParamsSchema,
  SearchPagesParamsSchema,
  ReplaceChildBlocksParamsSchema,
  UpdateDataSourceParamsSchema,
  UpdatePageMarkdownParamsSchema,
  UpdatePagePropertiesParamsSchema,
  ValidateParamsSchema,
} from "./models.js";
import { defineToolExtension } from "../tool-extension.js";
import type { OAuthProviderDescriptor, ResolvedOAuth, ToolExtensionTool } from "../tool-extension.js";

/** Documented not-connected signal — never a raw 401. */
function notConnected(oauth: ResolvedOAuth | undefined) {
  return {
    connected: false,
    provider: "notion",
    reason: oauth && !oauth.connected ? oauth.reason : "not_connected",
    message:
      oauth && !oauth.connected
        ? oauth.message
        : "Notion is not connected. Connect a Notion workspace in the agent's Notion settings.",
    authorizeUrl:
      oauth && !oauth.connected && "authorizeUrl" in oauth ? oauth.authorizeUrl : undefined,
  };
}


/** Notion descriptor. Client credentials go in a Basic header; the account comes from the token response. */
const notionOAuthProvider: OAuthProviderDescriptor = {
  id: "notion",
  displayName: "Notion",
  authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
  authorizeParams: { owner: "user" },
  tokenUrl: "https://api.notion.com/v1/oauth/token",
  revokeUrl: "https://api.notion.com/v1/oauth/revoke",
  tokenAuth: "basic",
  defaultScopes: [],
  apiBaseUrl: "https://api.notion.com",
  accountFromTokenResponse(token) {
    const response = token as { owner?: { user?: { person?: { email?: unknown } } }; workspace_name?: unknown } | null;
    const email = response?.owner?.user?.person?.email;
    if (typeof email === "string") return email;
    return typeof response?.workspace_name === "string" ? response.workspace_name : undefined;
  },
};

export default defineToolExtension({
  id: "notion",
  displayName: "Notion",
  description: "Generic Notion extension for data sources, pages, blocks, and file extraction.",
  systemPrompt: `Use this extension for generic Notion operations.

Tools:
- notion_list_data_sources: find data source (database) IDs by title; omit query to list all
- notion_list_pages: find page IDs by an optional title query; omit query to list all
- notion_search_pages: same as list_pages but the title query is required — titles only, not full-text body search
- notion_get_data_source: inspect a data source's schema/properties and metadata, not its rows
- notion_update_data_source: patch a data source's schema, title, or description, not its rows
- notion_query_data_source: query ALL rows from a data source, auto-paginated
- notion_get_page: fetch a page's property values and metadata only — NO content; use get_page_markdown or get_blocks for content
- notion_get_page_markdown: read page content as Markdown (cheap, no block IDs); call this before update_page_markdown to get exact old_str text
- notion_create_page: create a data source row (dataSourceId) or a subpage (pageId), exactly one required; markdown and children are mutually exclusive
- notion_update_page_properties: patch page PROPERTY VALUES only — never content/body
- notion_update_page_markdown: edit page content via update_content (exact-string find/replace) or replace_content (overwrite everything)
- notion_get_blocks: fetch raw block JSON with block IDs — use when you need to target a specific block
- notion_append_blocks: append new raw blocks to the end of a page or block's children
- notion_delete_block: delete/archive a single block by ID (get the ID from get_blocks)
- notion_replace_child_blocks: swap direct child sections identified by heading text (appends then deletes matches)
- notion_download_and_extract_file: download a file URL and extract text from PDF or DOCX
- notion_validate: verify auth and API reachability

Return and consume JSON-serializable data only.
In oauth mode the requester's connected Notion workspace is used. If a tool reports not connected, share the connect link it returns; do not guess or supply credentials.`,
  configSchema: NotionConfigSchema,
  requiredSecrets: ["apiKey"],
  advancedConfigFields: ["notionVersion", "timeoutMs"],
  oauthHiddenFields: ["mode", "apiKey", "notionVersion", "timeoutMs"],
  oauthProviders: [notionOAuthProvider],
  oauth: (config) => (config.merged.mode !== "api_key" ? { provider: "notion" } : undefined),
  createTools(config) {
    const resolved = NotionConfigSchema.parse(config.merged);
    const oauth = config.oauth;
    // OAuth mode uses the connected workspace's bearer token; api_key mode uses the integration secret.
    const apiKey = resolved.mode === "oauth" ? (oauth?.connected === true ? oauth.accessToken : undefined) : resolved.apiKey;
    const client = new NotionClient({ ...resolved, apiKey: apiKey ?? "" });

    const tools: ToolExtensionTool[] = [
      {
        name: "list_data_sources",
        description:
          "List or search shared data sources (Notion databases) by title, returning their IDs and schemas. Use to discover a dataSourceId for get_data_source or query_data_source; omit query to list all.",
        parameters: ListDataSourcesParamsSchema,
        execute: async (params) => {
          const parsed = ListDataSourcesParamsSchema.parse(params);
          return await client.listDataSources(parsed.query, parsed.pageSize, parsed.startCursor);
        },
      },
      {
        name: "list_pages",
        description:
          "List shared pages by title, with an optional query. Use search_pages instead when you require a title match; use this to browse or list all pages when no query is needed.",
        parameters: ListPagesParamsSchema,
        execute: async (params) => {
          const parsed = ListPagesParamsSchema.parse(params);
          return await client.listPages(parsed.query, parsed.pageSize, parsed.startCursor);
        },
      },
      {
        name: "search_pages",
        description:
          "List shared pages matching a required title query. This is list_pages with a mandatory query — it matches page titles only, not body content, so it is not full-text search.",
        parameters: SearchPagesParamsSchema,
        execute: async (params) => {
          const parsed = SearchPagesParamsSchema.parse(params);
          return await client.searchPages(parsed.query, parsed.pageSize, parsed.startCursor);
        },
      },
      {
        name: "get_data_source",
        description:
          "Fetch a data source's schema (its properties/columns) and metadata. Does NOT return rows; use query_data_source to fetch rows.",
        parameters: GetDataSourceParamsSchema,
        execute: async (params) => {
          const parsed = GetDataSourceParamsSchema.parse(params);
          return await client.getDataSource(parsed.dataSourceId);
        },
      },
      {
        name: "update_data_source",
        description:
          "Patch a data source's title, description, or property schema. Does not modify rows; use update_page_properties or update_page_markdown to edit row/page content.",
        parameters: UpdateDataSourceParamsSchema,
        execute: async (params) => {
          const parsed = UpdateDataSourceParamsSchema.parse(params);
          return await client.updateDataSource(parsed);
        },
      },
      {
        name: "query_data_source",
        description:
          "Query ALL rows from a data source (given its dataSourceId). Auto-paginates internally and returns the complete result set in `results` (has_more is always false) — never assume a partial page. Do NOT pass a `filter` unless the user explicitly asked to narrow results — an unrequested filter silently drops rows and breaks completeness. If a call fails, retry the SAME query or surface the error; never add a filter to force success.",
        parameters: QueryDataSourceParamsSchema,
        execute: async (params) => {
          const parsed = QueryDataSourceParamsSchema.parse(params);
          return await client.queryDataSource(parsed);
        },
      },
      {
        name: "get_page",
        description:
          "Fetch a page's property values and metadata (parent, icon, cover, timestamps) only — it returns NO page content. Use get_page_markdown for content as text, or get_blocks for raw block JSON with block IDs.",
        parameters: GetPageParamsSchema,
        execute: async (params) => {
          const parsed = GetPageParamsSchema.parse(params);
          return await client.getPage(parsed.pageId);
        },
      },
      {
        name: "get_page_markdown",
        description:
          "Fetch a page's content rendered as enhanced Markdown — the cheapest way to read content. Call this FIRST before update_page_markdown's update_content mode, to get byte-exact text for old_str. Response includes `truncated` (true if content was cut off for exceeding the record limit) and up to 100 `unknown_block_ids` for blocks that couldn't be rendered (shown as `<unknown>` in the markdown); the markdown itself carries no block IDs — use get_blocks if you need to target a specific block.",
        parameters: GetPageMarkdownParamsSchema,
        execute: async (params) => {
          const parsed = GetPageMarkdownParamsSchema.parse(params);
          return await client.getPageMarkdown(parsed);
        },
      },
      {
        name: "create_page",
        description:
          "Create a new page: a data source row when given `dataSourceId`, or a subpage when given `pageId` — exactly one of the two is required. Provide content via `markdown` (Notion-flavored Markdown) or `children` (raw blocks), which are mutually exclusive; if no title is given, the first `# h1` heading in markdown becomes the page title. Rejected if it would create a completely blank page (no properties, markdown, or children).",
        parameters: CreatePageParamsSchema,
        execute: async (params) => {
          const parsed = CreatePageParamsSchema.parse(params);
          return await client.createPage(parsed);
        },
      },
      {
        name: "update_page_properties",
        description:
          "Patch page PROPERTY VALUES (e.g. status, tags, dates) by property name or ID. This never touches page content/body — use update_page_markdown, append_blocks, or replace_child_blocks for content. Rejected if `properties` is empty.",
        parameters: UpdatePagePropertiesParamsSchema,
        execute: async (params) => {
          const parsed = UpdatePagePropertiesParamsSchema.parse(params);
          return await client.updatePageProperties(parsed);
        },
      },
      {
        name: "update_page_markdown",
        description:
          "Edit page content as Notion-flavored Markdown. Call get_page_markdown FIRST to get exact text for `old_str`, since mode `update_content` requires byte-exact string matches for its find/replace operations (max 100 updates, gated by `allowDeletingContent` for deletions); mode `replace_content` overwrites the entire page body instead. For raw-block edits, use append_blocks, replace_child_blocks, or delete_block instead.",
        parameters: UpdatePageMarkdownParamsSchema,
        execute: async (params) => {
          const parsed = UpdatePageMarkdownParamsSchema.parse(params);
          return await client.updatePageMarkdown(parsed);
        },
      },
      {
        name: "get_blocks",
        description:
          "Fetch a page or block's direct children as raw block JSON, including each block's ID. Use this over get_page_markdown when you need to target a specific block (e.g. for delete_block), at the cost of being more verbose than markdown.",
        parameters: GetBlocksParamsSchema,
        execute: async (params) => {
          const parsed = GetBlocksParamsSchema.parse(params);
          return await client.getBlocks(parsed);
        },
      },
      {
        name: "append_blocks",
        description:
          "Append new raw blocks to the end of a page or block's children, without touching existing content. Use replace_child_blocks instead to swap out an existing heading section. Rejected if `children` is empty.",
        parameters: AppendBlocksParamsSchema,
        execute: async (params) => {
          const parsed = AppendBlocksParamsSchema.parse(params);
          return await client.appendBlocks(parsed);
        },
      },
      {
        name: "delete_block",
        description:
          "Delete (archive) a single block by its ID. Get the ID from get_blocks first — get_page_markdown does not expose block IDs.",
        parameters: DeleteBlockParamsSchema,
        execute: async (params) => {
          const parsed = DeleteBlockParamsSchema.parse(params);
          return await client.deleteBlock(parsed.blockId);
        },
      },
      {
        name: "replace_child_blocks",
        description:
          "Replace one or more direct child sections identified by heading text: appends the new blocks first, then deletes the matched heading-through-next-heading ranges. Use this over delete_block to swap a labeled section, or over update_page_markdown when you don't have exact text to find/replace.",
        parameters: ReplaceChildBlocksParamsSchema,
        execute: async (params) => {
          const parsed = ReplaceChildBlocksParamsSchema.parse(params);
          return await client.replaceChildBlocks(parsed);
        },
      },
      {
        name: "download_and_extract_file",
        description:
          "Download a file from a URL (e.g. a Notion file/attachment URL) and extract its text. Supports PDF and DOCX by content-sniffing; other types are returned as raw decoded text.",
        parameters: DownloadAndExtractFileParamsSchema,
        execute: async (params) => {
          const parsed = DownloadAndExtractFileParamsSchema.parse(params);
          try {
            return await client.downloadAndExtractFile(parsed);
          } catch (error) {
            if (error instanceof NotionFileExtractionError) {
              return { ok: false, error: error.toJSON() };
            }
            throw error;
          }
        },
      },
      {
        name: "validate",
        description:
          "Verify the configured credentials and connectivity by fetching the current bot user. Use to diagnose auth/config issues; it does not read or write any Notion content.",
        parameters: ValidateParamsSchema,
        execute: async (params) => {
          ValidateParamsSchema.parse(params);
          return await client.validate();
        },
      },
    ];
    return apiKey ? tools : tools.map((tool) => ({ ...tool, execute: async () => notConnected(oauth) }));
  },
});
