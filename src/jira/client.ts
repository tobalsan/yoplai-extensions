import type {
  AddCommentParams,
  CreateIssueParams,
  GetCreateMetadataParams,
  GetIssueParams,
  GetTransitionsParams,
  JiraConfig,
  ListCommentsParams,
  ListParams,
  SearchParams,
  SearchUsersParams,
  TransitionIssueParams,
  UpdateIssueParams,
} from "./types.js";
import { JiraAuthError, JiraError, JiraValidationError } from "./errors.js";

type Method = "GET" | "POST" | "PUT";
type JsonObject = Record<string, unknown>;

type Project = { key?: string };
type Board = { location?: { projectKey?: string } };
type PagedResponse<T> = JsonObject & { values: T[] };
type IssueResponse = JsonObject & { fields?: { project?: { key?: string } } };
type Transition = JsonObject & { id: string; name?: string };
type TransitionsResponse = JsonObject & { transitions?: Transition[] };
type SearchRequest = {
  jql: string;
  startAt: number;
  maxResults: number;
  fields: string[];
};

const DEFAULT_ISSUE_FIELDS = [
  "summary",
  "description",
  "status",
  "assignee",
  "reporter",
  "priority",
  "labels",
  "issuetype",
  "project",
  "parent",
  "created",
  "updated",
];

export class JiraClient {
  private readonly baseUrl: string;

  constructor(private readonly config: JiraConfig) {
    this.baseUrl = `https://${config.subdomain}.atlassian.net`;
  }

  private async request<T = JsonObject>(path: string, method: Method = "GET", body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString("base64")}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const requestId = response.headers.get("x-arequestid") ?? undefined;
      const text = await response.text().catch(() => "");

      if (!response.ok) {
        const responseBody = text.slice(0, 500);
        const message = `Jira API request failed (${response.status}) ${path}${responseBody ? `: ${responseBody}` : ""}`;
        let details: unknown = text;
        try {
          details = text ? JSON.parse(text) : {};
        } catch {
          // Retain the raw response body.
        }
        if (response.status === 401 || response.status === 403) {
          throw new JiraAuthError(message, response.status, requestId, details, path, responseBody);
        }
        throw new JiraError(message, response.status, requestId, details, path, responseBody);
      }

      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private scoped(requestedProjectKeys?: string[]): string[] | undefined {
    const configuredProjectKeys = this.config.jiraProjectKeys;
    if (!requestedProjectKeys?.length) return configuredProjectKeys;

    for (const projectKey of requestedProjectKeys) {
      this.assertAllowedProject(projectKey);
    }
    return requestedProjectKeys;
  }

  private applyScopeJql(jql: string, scopedProjectKeys?: string[]): string {
    if (!scopedProjectKeys?.length) return jql;
    const projects = scopedProjectKeys.map((projectKey) => `"${projectKey}"`).join(",");
    return `project in (${projects}) AND (${jql})`;
  }

  private asAdf(value: unknown): unknown {
    if (typeof value !== "string") return value;
    return {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: value }] }],
    };
  }

  private assertAllowedProject(projectKey: string | undefined): void {
    const allowed = this.config.jiraProjectKeys;
    if (allowed?.length && (!projectKey || !allowed.includes(projectKey))) {
      throw new JiraValidationError(`Project ${projectKey ?? "unknown"} is not allowed`);
    }
  }

  private issueProjectFromKey(issueKey: string): string {
    return issueKey.split("-")[0] ?? issueKey;
  }

  private buildIssueFields(params: UpdateIssueParams): Record<string, unknown> {
    return {
      ...(params.summary ? { summary: params.summary } : {}),
      ...(params.description ? { description: this.asAdf(params.description) } : {}),
      ...(params.labels ? { labels: params.labels } : {}),
      ...(params.assigneeAccountId ? { assignee: { accountId: params.assigneeAccountId } } : {}),
      ...(params.priority ? { priority: { name: params.priority } } : {}),
      ...(params.fields ?? {}),
    };
  }

  private async assertAllowedIssue(issueKey: string): Promise<void> {
    this.assertAllowedProject(this.issueProjectFromKey(issueKey));
    if (!this.config.jiraProjectKeys?.length) return;

    const issue = await this.getIssue({ issueKey, fields: ["project"] });
    this.assertAllowedProject(issue.fields?.project?.key);
  }

  validate(): Promise<JsonObject> {
    return this.request("/rest/api/3/myself");
  }

  async listProjects(params: ListParams): Promise<PagedResponse<Project>> {
    const query = new URLSearchParams();
    if (params.startAt !== undefined) query.set("startAt", String(params.startAt));
    if (params.maxResults !== undefined) query.set("maxResults", String(params.maxResults));

    const response = await this.request<PagedResponse<Project>>(`/rest/api/3/project/search?${query.toString()}`);
    const allowed = this.config.jiraProjectKeys;
    return {
      ...response,
      values: allowed?.length ? response.values.filter((project) => project.key && allowed.includes(project.key)) : response.values,
    };
  }

  listIssueTypes(): Promise<JsonObject> {
    return this.request("/rest/api/3/issuetype");
  }

  listFields(): Promise<JsonObject> {
    return this.request("/rest/api/3/field");
  }

  async listBoards(params: ListParams): Promise<PagedResponse<Board>> {
    const query = new URLSearchParams();
    if (params.startAt !== undefined) query.set("startAt", String(params.startAt));
    if (params.maxResults !== undefined) query.set("maxResults", String(params.maxResults));

    const response = await this.request<PagedResponse<Board>>(`/rest/agile/1.0/board?${query.toString()}`);
    const allowed = this.config.jiraProjectKeys;
    return {
      ...response,
      values: allowed?.length
        ? response.values.filter((board) => board.location?.projectKey && allowed.includes(board.location.projectKey))
        : response.values,
    };
  }

  getBoardConfiguration(boardId: number): Promise<JsonObject> {
    return this.request(`/rest/agile/1.0/board/${boardId}/configuration`);
  }

  async getIssue({ issueKey, fields }: GetIssueParams): Promise<IssueResponse> {
    this.assertAllowedProject(this.issueProjectFromKey(issueKey));
    const query = new URLSearchParams();
    query.set("fields", (fields?.length ? fields : DEFAULT_ISSUE_FIELDS).join(","));

    const issue = await this.request<IssueResponse>(`/rest/api/3/issue/${issueKey}?${query.toString()}`);
    this.assertAllowedProject(issue.fields?.project?.key ?? this.issueProjectFromKey(issueKey));
    return issue;
  }

  async listComments({ issueKey, startAt, maxResults }: ListCommentsParams): Promise<JsonObject> {
    await this.assertAllowedIssue(issueKey);
    const query = new URLSearchParams();
    if (startAt !== undefined) query.set("startAt", String(startAt));
    if (maxResults !== undefined) query.set("maxResults", String(maxResults));
    return this.request(`/rest/api/3/issue/${issueKey}/comment?${query.toString()}`);
  }

  getCreateMetadata({ projectKey, issueTypeId }: GetCreateMetadataParams): Promise<JsonObject> {
    this.assertAllowedProject(projectKey);
    const query = new URLSearchParams({ projectKeys: projectKey, expand: "projects.issuetypes.fields" });
    if (issueTypeId) query.set("issuetypeIds", issueTypeId);
    return this.request(`/rest/api/3/issue/createmeta?${query.toString()}`);
  }

  async getTransitions({ issueKey }: GetTransitionsParams): Promise<TransitionsResponse> {
    await this.assertAllowedIssue(issueKey);
    return this.request(`/rest/api/3/issue/${issueKey}/transitions`);
  }

  async search(params: SearchParams): Promise<JsonObject> {
    const requestedProjectKeys = this.scoped(params.projectKeys);
    const structuredJql = [
      params.projectKeys?.length ? `project in (${params.projectKeys.join(",")})` : undefined,
      params.statuses?.length ? `status in (${params.statuses.map((status) => `"${status}"`).join(",")})` : undefined,
      params.assignee ? `assignee = "${params.assignee}"` : undefined,
      params.text ? `text ~ "${params.text}"` : undefined,
    ].filter((clause): clause is string => Boolean(clause)).join(" AND ");
    const jql = params.jql ?? (structuredJql || "order by updated DESC");
    const body: SearchRequest = {
      jql: this.applyScopeJql(jql, requestedProjectKeys),
      startAt: params.startAt ?? 0,
      maxResults: params.maxResults ?? 50,
      fields: params.fields ?? ["summary", "status", "assignee", "issuetype", "project", "priority", "updated"],
    };
    return this.request("/rest/api/3/search/jql", "POST", body);
  }

  searchUsers(params: SearchUsersParams): Promise<JsonObject> {
    const query = new URLSearchParams();
    let path = "/rest/api/3/user/search";
    if (params.projectKey) {
      this.assertAllowedProject(params.projectKey);
      path = "/rest/api/3/user/assignable/search";
      query.set("project", params.projectKey);
    }
    if (params.query) query.set("query", params.query);
    if (params.startAt !== undefined) query.set("startAt", String(params.startAt));
    if (params.maxResults !== undefined) query.set("maxResults", String(params.maxResults));
    return this.request(`${path}?${query.toString()}`);
  }

  async createIssue(params: CreateIssueParams): Promise<JsonObject> {
    this.assertAllowedProject(params.projectKey);
    const payload = {
      fields: {
        project: { key: params.projectKey },
        issuetype: { name: params.issueType },
        summary: params.summary,
        ...(params.description ? { description: this.asAdf(params.description) } : {}),
        ...(params.fields ?? {}),
      },
    };
    if (params.dryRun) {
      return {
        dryRun: true,
        payload,
        validate: await this.getCreateMetadata({ projectKey: params.projectKey }),
      };
    }
    return this.request("/rest/api/3/issue", "POST", payload);
  }

  async updateIssue(params: UpdateIssueParams): Promise<JsonObject> {
    await this.assertAllowedIssue(params.issueKey);
    const payload = { fields: this.buildIssueFields(params) };
    if (params.dryRun) {
      return {
        dryRun: true,
        issueKey: params.issueKey,
        payload,
        current: await this.getIssue({ issueKey: params.issueKey, fields: ["project", "summary", "status"] }),
      };
    }
    await this.request(`/rest/api/3/issue/${params.issueKey}`, "PUT", payload);
    return { ok: true, issueKey: params.issueKey };
  }

  async addComment(params: AddCommentParams): Promise<JsonObject> {
    await this.assertAllowedIssue(params.issueKey);
    const payload = { body: this.asAdf(params.comment) };
    if (params.dryRun) {
      return {
        dryRun: true,
        issueKey: params.issueKey,
        payload,
        issue: await this.getIssue({ issueKey: params.issueKey, fields: ["project", "summary"] }),
      };
    }
    return this.request(`/rest/api/3/issue/${params.issueKey}/comment`, "POST", payload);
  }

  async transitionIssue(params: TransitionIssueParams): Promise<JsonObject> {
    if (!params.transitionId && !params.transitionName) {
      throw new JiraValidationError("transitionId or transitionName is required");
    }
    await this.assertAllowedIssue(params.issueKey);
    const transitions = await this.getTransitions({ issueKey: params.issueKey });
    const transition = params.transitionId
      ? transitions.transitions?.find((candidate) => candidate.id === params.transitionId)
      : transitions.transitions?.find((candidate) => candidate.name?.toLowerCase() === params.transitionName?.toLowerCase());
    if (!transition) throw new JiraValidationError(`Transition not found for ${params.issueKey}`);

    const payload = { transition: { id: transition.id } };
    if (params.dryRun) return { dryRun: true, issueKey: params.issueKey, transition, payload };
    return this.request(`/rest/api/3/issue/${params.issueKey}/transitions`, "POST", payload);
  }
}
