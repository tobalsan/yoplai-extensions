import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import extension from "../index.js";

const READ_TOOLS = [
  "validate", "list_deals", "list_deal_files", "download_file", "list_pipelines", "get_pipeline", "list_stages", "get_stage",
  "list_deal_products", "list_deal_discounts", "get_deal", "list_deal_fields", "get_deal_field", "refresh_field_registry",
  "get_organization", "get_person", "search_deals", "list_deal_notes", "list_deal_activities", "list_leads", "get_lead",
  "search_leads", "list_lead_labels", "list_users", "list_lead_sources", "list_lead_notes", "list_lead_activities",
];
const SUPPORTING_READS = ["search_persons", "search_organizations", "list_contact_fields", "get_activity", "list_activity_types"];
const WRITE_TOOLS = [
  "create_lead", "update_lead", "create_deal", "update_deal", "create_person", "update_person", "create_organization",
  "update_organization", "create_note", "create_activity", "update_activity", "convert_lead_to_deal", "create_lead_label",
  "update_lead_label",
];

const credentials = { apiToken: "secret-token", domain: "acme" };
const names = (merged: Record<string, unknown>) =>
  extension.createTools({ global: {}, agent: {}, merged: { ...credentials, ...merged } }).map((tool) => tool.name);

describe("pipedrive allowWrite gating", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("snapshots the existing 27 read tools and keeps them when writes are omitted or false", () => {
    expect(names({})).toEqual(READ_TOOLS);
    expect(READ_TOOLS).toHaveLength(27);
    expect(names({ allowWrite: false })).toEqual(READ_TOOLS);
  });

  it("adds exactly the planned supporting reads and writes when enabled", () => {
    expect(names({ allowWrite: true })).toEqual([...READ_TOOLS, ...SUPPORTING_READS, ...WRITE_TOOLS]);
  });

  it.each([
    [true, false, false],
    [false, true, true],
  ])("agent override beats root default (root %s / agent %s)", async (rootWrite, agentWrite, expectedWrite) => {
    const context = { config: { extensions: { pipedrive: { ...credentials, allowWrite: rootWrite } } } };
    const agent = { id: "a1", extensions: { pipedrive: { allowWrite: agentWrite } } };
    const tools = await extension.getAgentTools(agent, context);
    expect(tools.some((tool) => tool.name === "pipedrive_create_lead")).toBe(expectedWrite);
    expect(tools.some((tool) => tool.name === "pipedrive_search_persons")).toBe(expectedWrite);
    expect(tools.some((tool) => tool.name === "pipedrive_list_deals")).toBe(true);
  });

  it("inherits the root default when the agent does not set allowWrite", async () => {
    const context = { config: { extensions: { pipedrive: { ...credentials, allowWrite: true } } } };
    const tools = await extension.getAgentTools({ id: "a1", extensions: { pipedrive: {} } }, context);
    expect(tools.some((tool) => tool.name === "pipedrive_update_deal")).toBe(true);
  });

  it("exposes no tools when the extension is disabled or not opted in", async () => {
    const context = { config: { extensions: { pipedrive: { ...credentials, allowWrite: true } } } };
    expect(await extension.getAgentTools({ id: "a1", extensions: { pipedrive: { enabled: false } } }, context)).toEqual([]);
    expect(await extension.getAgentTools({ id: "a1", extensions: {} }, context)).toEqual([]);
    expect(await extension.getAgentTools({ id: "a1", extensions: { pipedrive: {} } })).toEqual([]);
  });

  it("publishes a boolean config default and UI title", () => {
    expect(extension.configJsonSchema).toMatchObject({
      properties: { allowWrite: { type: "boolean", default: false, title: "Enable creating and updating CRM records" } },
    });
  });

  it("keeps the prompt truthful when writes are off and adds consent guidance for write mode", async () => {
    const prompt = async (allowWrite: boolean) => {
      const context = { config: { extensions: { pipedrive: { ...credentials, allowWrite } } } };
      return ((await extension.getSystemPromptContributions({ id: "a1", extensions: { pipedrive: {} } }, context)) ?? []).join("\n");
    };
    const off = await prompt(false);
    expect(off).toContain("READ-ONLY by default");
    expect(off).toContain("never claim an update was applied");
    expect(off).not.toContain("pipedrive_create_lead:");
    expect(off).not.toContain("(read-only)");
    expect(off).toContain("pipedrive_list_deals");
    const on = await prompt(true);
    expect(on).toContain("confirmed: true");
    expect(on).toContain("requested_by");
    expect(on).toContain("pipedrive_create_lead:");
  });

  it("exports an object schema for every tool", () => {
    for (const tool of extension.createTools({ global: {}, agent: {}, merged: { ...credentials, allowWrite: true } })) {
      expect(tool.parameters, tool.name).toBeInstanceOf(z.ZodObject);
    }
  });

  it("rejects invalid write parameters before any request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const tools = extension.createTools({ global: {}, agent: {}, merged: { ...credentials, allowWrite: true } });
    const create = tools.find((tool) => tool.name === "create_note");
    expect(create).toBeDefined();
    await expect(create?.execute({})).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
