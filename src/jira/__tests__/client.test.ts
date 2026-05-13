import { afterEach, describe, expect, it, vi } from "vitest";
import { JiraClient } from "../client.js";

const config = {
  subdomain: "example",
  email: "user@example.com",
  apiToken: "token",
  jiraProjectKeys: ["CFS"],
  readOnly: false,
  timeoutMs: 30_000,
};

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("JiraClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("wraps JQL search with configured project allowlist", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ issues: [] }));
    const client = new JiraClient(config);

    await client.search({ jql: "status = Done", maxResults: 10 });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      jql: 'project in ("CFS") AND (status = Done)',
      maxResults: 10,
    });
  });

  it("dry-runs create_issue with remote metadata validation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ projects: [] }));
    const client = new JiraClient(config);

    const result = await client.createIssue({ projectKey: "CFS", issueType: "Task", summary: "Hello", description: "Body", dryRun: true });

    expect(result).toMatchObject({ dryRun: true, payload: { fields: { project: { key: "CFS" }, issuetype: { name: "Task" }, summary: "Hello" } } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.atlassian.net/rest/api/3/issue/createmeta?projectKeys=CFS&expand=projects.issuetypes.fields");
  });

  it("updates issue after scoped issue verification", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ fields: { project: { key: "CFS" } } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new JiraClient(config);

    await expect(client.updateIssue({ issueKey: "CFS-1", summary: "New" })).resolves.toEqual({ ok: true, issueKey: "CFS-1" });

    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://example.atlassian.net/rest/api/3/issue/CFS-1");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ fields: { summary: "New" } });
  });

  it("adds comments as ADF", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ fields: { project: { key: "CFS" } } }))
      .mockResolvedValueOnce(jsonResponse({ id: "10000" }));
    const client = new JiraClient(config);

    await client.addComment({ issueKey: "CFS-1", comment: "Looks good" });

    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://example.atlassian.net/rest/api/3/issue/CFS-1/comment");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ body: { type: "doc", version: 1 } });
  });

  it("resolves transition by name", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ fields: { project: { key: "CFS" } } }))
      .mockResolvedValueOnce(jsonResponse({ fields: { project: { key: "CFS" } } }))
      .mockResolvedValueOnce(jsonResponse({ transitions: [{ id: "31", name: "Done" }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new JiraClient(config);

    await client.transitionIssue({ issueKey: "CFS-1", transitionName: "done" });

    expect(fetchMock.mock.calls[3]?.[0]).toBe("https://example.atlassian.net/rest/api/3/issue/CFS-1/transitions");
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({ transition: { id: "31" } });
  });
});
