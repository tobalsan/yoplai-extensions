import type { JiraConfig } from "./types.js";
import { JiraAuthError, JiraError, JiraValidationError } from "./errors.js";

type Method = "GET"|"POST"|"PUT";

export class JiraClient {
  private baseUrl: string;
  constructor(private config: JiraConfig) { this.baseUrl = `https://${config.subdomain}.atlassian.net`; }

  private async request(path: string, method: Method = "GET", body?: unknown) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Basic ${Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString("base64")}`, Accept: "application/json", "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const reqId = res.headers.get("x-arequestid") ?? undefined;
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new JiraAuthError("Jira authentication failed", res.status, reqId, data);
        throw new JiraError(`Jira API request failed (${res.status})`, res.status, reqId, data);
      }
      return data;
    } finally { clearTimeout(timeout); }
  }

  private scoped(projectKeys?: string[]) { return (projectKeys && projectKeys.length > 0) ? projectKeys : this.config.jiraProjectKeys; }
  private applyScopeJql(jql: string, scoped?: string[]) { return scoped && scoped.length ? `project in (${scoped.map((p)=>`"${p}"`).join(",")}) AND (${jql})` : jql; }
  private asAdf(v: unknown) { return typeof v === "string" ? { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: v }] }] } : v; }
  private assertAllowedProject(projectKey: string) { const allowed = this.config.jiraProjectKeys; if (allowed?.length && !allowed.includes(projectKey)) throw new JiraValidationError(`Project ${projectKey} is not allowed`); }
  private issueProjectFromKey(issueKey: string) { return issueKey.split("-")[0]; }
  private buildIssueFields(params: any) {
    return {
      ...(params.summary ? { summary: params.summary } : {}),
      ...(params.description ? { description: this.asAdf(params.description) } : {}),
      ...(params.labels ? { labels: params.labels } : {}),
      ...(params.assigneeAccountId ? { assignee: { accountId: params.assigneeAccountId } } : {}),
      ...(params.priority ? { priority: { name: params.priority } } : {}),
      ...(params.fields ?? {}),
    };
  }
  private async assertAllowedIssue(issueKey: string) {
    this.assertAllowedProject(this.issueProjectFromKey(issueKey));
    if (!this.config.jiraProjectKeys?.length) return;
    const issue = await this.getIssue({ issueKey, fields: ["project"] });
    this.assertAllowedProject(issue.fields?.project?.key);
  }

  validate() { return this.request("/rest/api/3/myself"); }
  listProjects(params: {startAt?:number;maxResults?:number}) { const keys = this.config.jiraProjectKeys; const q = new URLSearchParams(); if(params.startAt!==undefined) q.set("startAt",String(params.startAt)); if(params.maxResults!==undefined) q.set("maxResults",String(params.maxResults)); return this.request(`/rest/api/3/project/search?${q.toString()}`).then((r)=> ({...r, values: keys?.length ? r.values.filter((p:any)=>keys.includes(p.key)) : r.values})); }
  listIssueTypes() { return this.request("/rest/api/3/issuetype"); }
  listFields() { return this.request("/rest/api/3/field"); }
  listBoards(params:{startAt?:number;maxResults?:number}) { const q = new URLSearchParams(); if(params.startAt!==undefined) q.set("startAt",String(params.startAt)); if(params.maxResults!==undefined) q.set("maxResults",String(params.maxResults)); return this.request(`/rest/agile/1.0/board?${q.toString()}`).then((r)=> ({...r, values: this.config.jiraProjectKeys?.length ? r.values.filter((b:any)=> this.config.jiraProjectKeys?.includes(b.location?.projectKey)) : r.values})); }
  getBoardConfiguration(boardId:number){ return this.request(`/rest/agile/1.0/board/${boardId}/configuration`); }
  async getIssue({issueKey,fields}:{issueKey:string;fields?:string[]}) { this.assertAllowedProject(this.issueProjectFromKey(issueKey)); const q = new URLSearchParams(); q.set("fields", (fields?.length?fields:["summary","description","status","assignee","reporter","priority","labels","issuetype","project","parent","created","updated"]).join(",")); const issue = await this.request(`/rest/api/3/issue/${issueKey}?${q.toString()}`); this.assertAllowedProject(issue.fields?.project?.key ?? this.issueProjectFromKey(issueKey)); return issue; }
  async listComments({issueKey,startAt,maxResults}:{issueKey:string;startAt?:number;maxResults?:number}){ await this.assertAllowedIssue(issueKey); const q=new URLSearchParams(); if(startAt!==undefined) q.set("startAt",String(startAt)); if(maxResults!==undefined) q.set("maxResults",String(maxResults)); return this.request(`/rest/api/3/issue/${issueKey}/comment?${q.toString()}`); }
  getCreateMetadata({projectKey,issueTypeId}:{projectKey:string;issueTypeId?:string}){ this.assertAllowedProject(projectKey); const q=new URLSearchParams({projectKeys:projectKey,expand:"projects.issuetypes.fields"}); if(issueTypeId) q.set("issuetypeIds",issueTypeId); return this.request(`/rest/api/3/issue/createmeta?${q.toString()}`); }
  async getTransitions({issueKey}:{issueKey:string}){ await this.assertAllowedIssue(issueKey); return this.request(`/rest/api/3/issue/${issueKey}/transitions`); }
  async search(params:any){ const built = [params.projectKeys?.length?`project in (${params.projectKeys.join(",")})`:undefined,params.statuses?.length?`status in (${params.statuses.map((s:string)=>`"${s}"`).join(",")})`:undefined,params.assignee?`assignee = "${params.assignee}"`:undefined,params.text?`text ~ "${params.text}"`:undefined].filter(Boolean).join(" AND "); const jql = params.jql ?? (built || "order by updated DESC"); const body:any={jql:this.applyScopeJql(jql,this.scoped(params.projectKeys)),startAt:params.startAt ?? 0,maxResults:params.maxResults ?? 50,fields:params.fields ?? ["summary","status","assignee","issuetype","project","priority","updated"]}; return this.request("/rest/api/3/search/jql","POST",body); }
  searchUsers(params:any){ if(params.projectKey){ this.assertAllowedProject(params.projectKey); const q=new URLSearchParams({project:params.projectKey}); if(params.query) q.set("query",params.query); return this.request(`/rest/api/3/user/assignable/search?${q.toString()}`);} const q=new URLSearchParams(); if(params.query) q.set("query",params.query); return this.request(`/rest/api/3/user/search?${q.toString()}`); }
  async createIssue(params:any){ this.assertAllowedProject(params.projectKey); const payload={fields:{project:{key:params.projectKey},issuetype:{name:params.issueType},summary:params.summary,...(params.description?{description:this.asAdf(params.description)}:{}),...(params.fields??{})}}; if(params.dryRun) return {dryRun:true,payload,validate:await this.getCreateMetadata({projectKey:params.projectKey})}; return this.request("/rest/api/3/issue","POST",payload); }
  async updateIssue(params:any){ await this.assertAllowedIssue(params.issueKey); const payload = { fields: this.buildIssueFields(params) }; if(params.dryRun) return { dryRun:true, issueKey: params.issueKey, payload, current: await this.getIssue({ issueKey: params.issueKey, fields: ["project", "summary", "status"] }) }; await this.request(`/rest/api/3/issue/${params.issueKey}`,"PUT",payload); return { ok:true, issueKey: params.issueKey }; }
  async addComment(params:any){ await this.assertAllowedIssue(params.issueKey); const payload = { body: this.asAdf(params.comment) }; if(params.dryRun) return { dryRun:true, issueKey: params.issueKey, payload, issue: await this.getIssue({ issueKey: params.issueKey, fields: ["project", "summary"] }) }; return this.request(`/rest/api/3/issue/${params.issueKey}/comment`,"POST",payload); }
  async transitionIssue(params:any){ if(!params.transitionId && !params.transitionName) throw new JiraValidationError("transitionId or transitionName is required"); await this.assertAllowedIssue(params.issueKey); const transitions = await this.getTransitions({ issueKey: params.issueKey }); const transition = params.transitionId ? transitions.transitions?.find((t:any)=>t.id === params.transitionId) : transitions.transitions?.find((t:any)=>t.name?.toLowerCase() === params.transitionName?.toLowerCase()); if(!transition) throw new JiraValidationError(`Transition not found for ${params.issueKey}`); const payload = { transition: { id: transition.id } }; if(params.dryRun) return { dryRun:true, issueKey: params.issueKey, transition, payload }; return this.request(`/rest/api/3/issue/${params.issueKey}/transitions`,"POST",payload); }
}
