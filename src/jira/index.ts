import { defineToolExtension, type ToolExtensionTool } from "../tool-extension.js";
import { JiraClient } from "./client.js";
import { AddCommentParamsSchema, CreateIssueParamsSchema, GetBoardConfigurationParamsSchema, GetCreateMetadataParamsSchema, GetIssueParamsSchema, GetTransitionsParamsSchema, JiraConfigSchema, ListCommentsParamsSchema, ListParamsSchema, SearchParamsSchema, SearchUsersParamsSchema, TransitionIssueParamsSchema, UpdateIssueParamsSchema, ValidateParamsSchema } from "./models.js";

export default defineToolExtension({
  id: "jira",
  displayName: "Jira",
  description: "Jira Cloud extension for scoped issue/project/board workflows.",
  configSchema: JiraConfigSchema,
  requiredSecrets: ["email", "apiToken"],
  createTools(config) {
    const resolved = JiraConfigSchema.parse(config.merged);
    const client = new JiraClient(resolved);
    const tools: ToolExtensionTool[] = [
      { name: "search", description: "Search Jira issues via JQL or structured filters.", parameters: SearchParamsSchema, execute: (p) => client.search(SearchParamsSchema.parse(p)) },
      { name: "get_issue", description: "Get an issue with curated default fields.", parameters: GetIssueParamsSchema, execute: (p) => client.getIssue(GetIssueParamsSchema.parse(p)) },
      { name: "get_create_metadata", description: "Fetch create metadata for project/issue types.", parameters: GetCreateMetadataParamsSchema, execute: (p) => client.getCreateMetadata(GetCreateMetadataParamsSchema.parse(p)) },
      { name: "get_transitions", description: "List available transitions for an issue.", parameters: GetTransitionsParamsSchema, execute: (p) => client.getTransitions(GetTransitionsParamsSchema.parse(p)) },
      { name: "list_projects", description: "List accessible projects (scope-filtered when configured).", parameters: ListParamsSchema, execute: (p) => client.listProjects(ListParamsSchema.parse(p)) },
      { name: "list_issue_types", description: "List issue types.", parameters: ValidateParamsSchema, execute: () => client.listIssueTypes() },
      { name: "list_fields", description: "List Jira fields.", parameters: ValidateParamsSchema, execute: () => client.listFields() },
      { name: "list_boards", description: "List boards (scope-filtered when configured).", parameters: ListParamsSchema, execute: (p) => client.listBoards(ListParamsSchema.parse(p)) },
      { name: "get_board_configuration", description: "Get board configuration and columns.", parameters: GetBoardConfigurationParamsSchema, execute: (p) => client.getBoardConfiguration(GetBoardConfigurationParamsSchema.parse(p).boardId) },
      { name: "search_users", description: "Search users globally or by assignable users in a project.", parameters: SearchUsersParamsSchema, execute: (p) => client.searchUsers(SearchUsersParamsSchema.parse(p)) },
      { name: "list_comments", description: "List issue comments.", parameters: ListCommentsParamsSchema, execute: (p) => client.listComments(ListCommentsParamsSchema.parse(p)) },
      { name: "validate", description: "Validate auth and API reachability.", parameters: ValidateParamsSchema, execute: () => client.validate() },
    ];
    if (!resolved.readOnly) {
      tools.splice(tools.length - 1, 0,
        { name: "create_issue", description: "Create issue (supports dryRun).", parameters: CreateIssueParamsSchema, execute: (p) => client.createIssue(CreateIssueParamsSchema.parse(p)) },
        { name: "update_issue", description: "Update issue fields (supports dryRun).", parameters: UpdateIssueParamsSchema, execute: (p) => client.updateIssue(UpdateIssueParamsSchema.parse(p)) },
        { name: "add_comment", description: "Add comment (supports dryRun).", parameters: AddCommentParamsSchema, execute: (p) => client.addComment(AddCommentParamsSchema.parse(p)) },
        { name: "transition_issue", description: "Transition issue by id or name (supports dryRun).", parameters: TransitionIssueParamsSchema, execute: (p) => client.transitionIssue(TransitionIssueParamsSchema.parse(p)) },
      );
    }
    return tools;
  },
});
