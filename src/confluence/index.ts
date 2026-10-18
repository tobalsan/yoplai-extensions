import { ConfluenceClient } from "./client.js";
import {
  ConfluenceConfigSchema,
  CreatePageParamsSchema,
  DownloadAndExtractFileParamsSchema,
  GetPageAncestorsParamsSchema,
  GetPageChildrenParamsSchema,
  GetPageParamsSchema,
  GetPagesByLabelParamsSchema,
  ListAttachmentsParamsSchema,
  ListLabelsParamsSchema,
  ListSpacePagesParamsSchema,
  ListSpacesParamsSchema,
  ReplacePageParamsSchema,
  SearchParamsSchema,
  ValidateParamsSchema,
} from "./models.js";
import { defineToolExtension, type ToolExtensionTool } from "../tool-extension.js";

export default defineToolExtension({
  id: "confluence",
  displayName: "Confluence",
  description: "Confluence Cloud extension for search, pages, attachments, labels, and page writes.",
  systemPrompt: `Use this extension for Confluence Cloud access, including page reads and controlled page writes.

For space-page listings, use the configured space when \`confluenceSpace\` is set; otherwise supply the NUMERIC \`spaceId\`, not the space key, and resolve keys via confluence_list_spaces.

If \`confluenceSpace\` is set in extension config, results are scoped to that space key: search CQL is wrapped with \`AND space = "<KEY>"\`, label listings use the space's labels, page-by-label results are filtered by space, and list_spaces is not exposed. create_page defaults to the configured space and rejects any mismatched \`spaceId\`. Page-id-bound tools (get_page, get_page_children, get_page_ancestors, list_attachments, download_and_extract_file, replace_page) are not space-enforced — agents must pass page ids that belong to the scoped space. Page-id tools require a real wiki page id; passing a space id or non-page content (whiteboard, database, folder, smart link) returns an opaque 500.

For writes, \`body\` must be valid Confluence storage-format XHTML, not Markdown. To append content, first call get_page, compose the full new storage XHTML body locally, then call replace_page; each successful replace creates a recoverable Confluence page version. replace_page fetches the current version and sends the next version number; a concurrent edit returns a typed conflict error.

CQL primer (used by confluence_search):
- text ~ "needle"            full-text match
- space = "ENG"              restrict to a space key
- type = page                or "blogpost", "comment", "attachment"
- label = "runbook"          tagged content
- lastModified > "2026-01-01"
- creator = "user@example.com"
- ancestor = "<pageId>"      descendants of a page
- combine with AND / OR / NOT, parens for grouping
- order by: append \`ORDER BY lastmodified DESC\`

Pages can be very large; bodies are returned raw without truncation. Each page/search result includes a derived \`webUrl\` field for citation. CQL is passed through verbatim — sanitize agent-derived input before composing it.

Return and consume JSON-serializable data only.`,
  configSchema: ConfluenceConfigSchema,
  requiredSecrets: ["apiToken"],
  advancedConfigFields: ["timeoutMs"],
  createTools(config) {
    const resolved = ConfluenceConfigSchema.parse(config.merged);
    const client = new ConfluenceClient(resolved);
    const isScoped = !!resolved.confluenceSpace;

    const tools: ToolExtensionTool[] = [
      {
        name: "search",
        description: "Search Confluence content with raw CQL.",
        parameters: SearchParamsSchema,
        execute: async (params) => {
          const parsed = SearchParamsSchema.parse(params);
          return await client.search(parsed);
        },
      },
      {
        name: "get_page",
        description:
          "Fetch a page by id with body in the given format. pageId must be a real wiki page id, not a space id or non-page content (whiteboard/database/folder/smart link).",
        parameters: GetPageParamsSchema,
        execute: async (params) => {
          const parsed = GetPageParamsSchema.parse(params);
          return await client.getPage(parsed);
        },
      },
      {
        name: "create_page",
        description:
          "Create a Confluence page with storage-format XHTML body; uses confluenceSpace when configured.",
        parameters: CreatePageParamsSchema,
        execute: async (params) => {
          const parsed = CreatePageParamsSchema.parse(params);
          return await client.createPage(parsed);
        },
      },
      {
        name: "replace_page",
        description:
          "Replace an existing page body with storage-format XHTML and optionally update its title.",
        parameters: ReplacePageParamsSchema,
        execute: async (params) => {
          const parsed = ReplacePageParamsSchema.parse(params);
          return await client.replacePage(parsed);
        },
      },
      {
        name: "get_page_children",
        description: "Fetch direct children of a page.",
        parameters: GetPageChildrenParamsSchema,
        execute: async (params) => {
          const parsed = GetPageChildrenParamsSchema.parse(params);
          return await client.getPageChildren(parsed);
        },
      },
      {
        name: "get_page_ancestors",
        description: "Fetch the parent chain of a page.",
        parameters: GetPageAncestorsParamsSchema,
        execute: async (params) => {
          const parsed = GetPageAncestorsParamsSchema.parse(params);
          return await client.getPageAncestors(parsed);
        },
      },
      {
        name: "list_attachments",
        description: "List attachments on a page.",
        parameters: ListAttachmentsParamsSchema,
        execute: async (params) => {
          const parsed = ListAttachmentsParamsSchema.parse(params);
          return await client.listAttachments(parsed);
        },
      },
      {
        name: "download_and_extract_file",
        description: "Download a Confluence file URL and extract text from PDF or DOCX content.",
        parameters: DownloadAndExtractFileParamsSchema,
        execute: async (params) => {
          const parsed = DownloadAndExtractFileParamsSchema.parse(params);
          return await client.downloadAndExtractFile(parsed);
        },
      },
      {
        name: "list_labels",
        description: "List labels with cursor-based pagination.",
        parameters: ListLabelsParamsSchema,
        execute: async (params) => {
          const parsed = ListLabelsParamsSchema.parse(params);
          return await client.listLabels(parsed);
        },
      },
      {
        name: "get_pages_by_label",
        description: "List pages tagged with a given label id.",
        parameters: GetPagesByLabelParamsSchema,
        execute: async (params) => {
          const parsed = GetPagesByLabelParamsSchema.parse(params);
          return await client.getPagesByLabel(parsed);
        },
      },
      {
        name: "list_space_pages",
        description:
          "List pages in a space (uses confluenceSpace when configured, otherwise requires spaceId). spaceId must be the NUMERIC space id, not the space key (e.g. \"CS\"); resolve keys via confluence_list_spaces.",
        parameters: ListSpacePagesParamsSchema,
        execute: async (params) => {
          const parsed = ListSpacePagesParamsSchema.parse(params);
          return await client.listSpacePages(parsed);
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

    if (!isScoped) {
      tools.splice(tools.length - 1, 0, {
        name: "list_spaces",
        description: "List spaces with optional filters.",
        parameters: ListSpacesParamsSchema,
        execute: async (params) => {
          const parsed = ListSpacesParamsSchema.parse(params);
          return await client.listSpaces(parsed);
        },
      });
    }

    return tools;
  },
});
