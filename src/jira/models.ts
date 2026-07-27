import { z } from "zod";

const OptionalPositiveInteger = z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)]).optional();
const OptionalNonNegativeInteger = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]).optional();

const ProjectKeysSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed.split(",").map((part) => part.trim()).filter(Boolean);
}, z.array(z.string().min(1)).optional()).describe(
  "Comma-separated list of Jira project keys to scope this extension to, e.g. \"ENG, OPS\". Leave blank to allow all projects.",
);

export const JiraConfigSchema = z.object({
  subdomain: z.string().regex(
    /^(?=.{1,63}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/,
    "Jira subdomain must be a single DNS label",
  ).describe("Jira Cloud subdomain, e.g. \"acme\" for acme.atlassian.net."),
  email: z.string().email().describe("Email address of the Jira account used to authenticate with the API token."),
  apiToken: z.string().min(1).describe("Jira API token for the account email. Create one at id.atlassian.com/manage-profile/security/api-tokens."),
  jiraProjectKeys: ProjectKeysSchema,
  readOnly: z.boolean().optional().default(false).describe("When enabled, disables issue creation, updates, comments, and transitions."),
  timeoutMs: z.number().int().positive().optional().default(30_000).describe("Request timeout in milliseconds for Jira API calls. Defaults to 30000."),
});

export const ValidateParamsSchema = z.object({}).strict();
export const ListParamsSchema = z.object({ startAt: OptionalNonNegativeInteger, maxResults: OptionalPositiveInteger }).strict();
export const GetIssueParamsSchema = z.object({ issueKey: z.string().min(1), fields: z.array(z.string()).optional() }).strict();
export const SearchParamsSchema = z.object({ jql: z.string().optional(), projectKeys: z.array(z.string()).optional(), text: z.string().optional(), assignee: z.string().optional(), statuses: z.array(z.string()).optional(), startAt: OptionalNonNegativeInteger, maxResults: OptionalPositiveInteger, fields: z.array(z.string()).optional() }).strict();
export const GetCreateMetadataParamsSchema = z.object({ projectKey: z.string().min(1), issueTypeId: z.string().optional() }).strict();
export const GetTransitionsParamsSchema = z.object({ issueKey: z.string().min(1) }).strict();
export const GetBoardConfigurationParamsSchema = z.object({ boardId: z.number().int().positive() }).strict();
export const SearchUsersParamsSchema = z.object({ query: z.string().optional(), projectKey: z.string().optional(), startAt: OptionalNonNegativeInteger, maxResults: OptionalPositiveInteger }).strict();
export const ListCommentsParamsSchema = z.object({ issueKey: z.string().min(1), startAt: OptionalNonNegativeInteger, maxResults: OptionalPositiveInteger }).strict();

const AdfSchema = z.object({ type: z.string(), version: z.number().optional() }).passthrough();
const DescriptionInputSchema = z.union([z.string(), AdfSchema]);

export const CreateIssueParamsSchema = z.object({ projectKey: z.string().min(1), issueType: z.string().min(1), summary: z.string().min(1), description: DescriptionInputSchema.optional(), fields: z.record(z.unknown()).optional(), dryRun: z.boolean().optional() }).strict();
export const UpdateIssueParamsSchema = z.object({ issueKey: z.string().min(1), summary: z.string().optional(), description: DescriptionInputSchema.optional(), labels: z.array(z.string()).optional(), assigneeAccountId: z.string().optional(), priority: z.string().optional(), fields: z.record(z.unknown()).optional(), dryRun: z.boolean().optional() }).strict();
export const AddCommentParamsSchema = z.object({ issueKey: z.string().min(1), comment: DescriptionInputSchema, dryRun: z.boolean().optional() }).strict();
export const TransitionIssueParamsSchema = z.object({ issueKey: z.string().min(1), transitionId: z.string().optional(), transitionName: z.string().optional(), dryRun: z.boolean().optional() }).strict();
