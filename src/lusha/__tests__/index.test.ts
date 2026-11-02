import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodObject } from "zod";
import extension from "../index.js";
import { LushaConfigSchema } from "../models.js";

function createTools() {
  return extension.createTools({ global: {}, agent: {}, merged: { apiKey: "test-key" } });
}

describe("Lusha extension contract", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exposes the standalone Lusha contract with five ordered tools and object schemas", async () => {
    expect(extension.id).toBe("lusha");
    expect(extension.displayName).toBe("Lusha");
    expect(extension.requiredSecrets).toEqual(["apiKey"]);
    expect(extension.advancedConfigFields).toEqual(["timeoutMs"]);
    const tools = createTools();
    expect(tools.map((tool) => tool.name)).toEqual(["find_work_email", "find_phone", "lookup_company", "credit_usage", "validate"]);
    for (const tool of tools) {
      expect(tool.parameters).toBeInstanceOf(ZodObject);
      expect(tool.parameters.safeParse({ extra: true }).success).toBe(false);
      expect(tool.outputSchema).toBeDefined();
    }
    expect(LushaConfigSchema.parse({ apiKey: "test-key" })).toEqual({ apiKey: "test-key" });
    expect(LushaConfigSchema.parse({ apiKey: "test-key", timeoutMs: 1500 })).toEqual({ apiKey: "test-key", timeoutMs: 1500 });
    expect(LushaConfigSchema.safeParse({ apiKey: "test-key", timeoutMs: 0 }).success).toBe(false);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const phone = tools.find((tool) => tool.name === "find_phone");
    await expect(phone?.execute({ linkedinUrl: "https://www.linkedin.com/in/example" })).rejects.toThrow();
    await expect(phone?.execute({ linkedinUrl: "https://www.linkedin.com/in/example", confirmCost: false })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("executes approved phone lookups without sending the local cost flag to Lusha", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      results: [{ phones: [{ number: "+12025550123", type: "mobile", doNotCall: false }] }],
      billing: { creditsCharged: 6 },
    })));
    const phone = createTools().find((tool) => tool.name === "find_phone");
    const result = await phone?.execute({
      firstName: "Alex", lastName: "Example", companyDomain: "example.com", confirmCost: true,
    });
    expect(result).toMatchObject({ found: true, creditsUsed: 6, phones: [{ number: "+12025550123", doNotCall: false }] });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      contacts: [{ firstName: "Alex", lastName: "Example", companyDomain: "example.com" }], reveal: ["phones"],
    });
    expect(phone?.outputSchema?.safeParse(result).success).toBe(true);
  });
});
