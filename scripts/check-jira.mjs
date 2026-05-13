#!/usr/bin/env node
const required = ["JIRA_SUBDOMAIN", "JIRA_EMAIL", "JIRA_API_TOKEN"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const baseUrl = `https://${process.env.JIRA_SUBDOMAIN}.atlassian.net`;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString("base64");
const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };
const scopedProjects = (process.env.JIRA_PROJECT_KEYS ?? "").split(",").map((key) => key.trim()).filter(Boolean);

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(data)}`);
  return data;
}

const myself = await get("/rest/api/3/myself");
const projects = await get("/rest/api/3/project/search?maxResults=50");
const boards = await get("/rest/agile/1.0/board?maxResults=50");
const jql = scopedProjects.length ? `project in (${scopedProjects.map((key) => `"${key}"`).join(",")}) order by updated DESC` : "order by updated DESC";
const search = await post("/rest/api/3/search/jql", { jql, maxResults: 1, fields: ["summary", "status", "project"] });

console.log(JSON.stringify({
  ok: true,
  user: { accountId: myself.accountId, displayName: myself.displayName, emailAddress: myself.emailAddress },
  projects: projects.values?.map((project) => ({ key: project.key, name: project.name })) ?? [],
  boards: boards.values?.map((board) => ({ id: board.id, name: board.name, projectKey: board.location?.projectKey })) ?? [],
  sampleSearch: { total: search.total, returned: search.issues?.length ?? 0, jql },
}, null, 2));
