import { ConfluenceClient } from "./client.js";
import {
  ConfluenceConfigSchema,
  DownloadAndExtractFileParamsSchema,
  GetPageAncestorsParamsSchema,
  GetPageChildrenParamsSchema,
  GetPageParamsSchema,
  GetPagesByLabelParamsSchema,
  ListAttachmentsParamsSchema,
  ListLabelsParamsSchema,
  ListSpacesParamsSchema,
  SearchParamsSchema,
  ValidateParamsSchema,
} from "./models.js";
import { defineToolExtension, type ToolExtensionTool } from "../tool-extension.js";

export default defineToolExtension({
  id: "confluence",
  displayName: "Confluence",
  description: "Read-only Confluence Cloud extension for search, pages, attachments, and labels.",
  systemPrompt: `Use this extension for read-only access to Confluence Cloud.

Tools:
- confluence_search: search content with raw CQL (see primer below)
- confluence_get_page: fetch a page by id, with body in storage/ADF/view format
- confluence_get_page_children: fetch direct children of a page
- confluence_get_page_ancestors: fetch the parent chain of a page
- confluence_list_attachments: list attachments on a page
- confluence_download_and_extract_file: download a Confluence file URL and extract text from PDF or DOCX content
- confluence_list_labels: list labels (paginated)
- confluence_get_pages_by_label: list pages tagged with a given label id
- confluence_list_spaces: list spaces (paginated, filterable by key/type/status). Unavailable when \`confluenceSpace\` is set.
- confluence_validate: verify auth and API reachability

If \`confluenceSpace\` is set in extension config, results are scoped to that space key: search CQL is wrapped with \`AND space = "<KEY>"\`, label listings use the space's labels, page-by-label results are filtered by space, and list_spaces is not exposed. Page-id-bound tools (get_page, get_page_children, get_page_ancestors, list_attachments, download_and_extract_file) are not enforced — agents must pass page ids that belong to the scoped space.

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
  requiredSecrets: ["email", "apiToken"],
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
        description: "Fetch a page by id with body in the given format.",
        parameters: GetPageParamsSchema,
        execute: async (params) => {
          const parsed = GetPageParamsSchema.parse(params);
          return await client.getPage(parsed);
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
