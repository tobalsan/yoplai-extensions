import { describe, expect, it } from "vitest";

import {
  DownloadFileParamsSchema,
  DownloadFileResultSchema,
  EntityByIdParamsSchema,
  FileSchema,
  GetPipelineParamsSchema,
  GetStageParamsSchema,
  ListDealDiscountsParamsSchema,
  ListDealFilesParamsSchema,
  ListDealProductsParamsSchema,
  ListDealsParamsSchema,
  ListStagesParamsSchema,
  OrganizationSchema,
  PersonSchema,
  PipedriveConfigSchema,
  ActivitySchema,
  ListDealActivitiesParamsSchema,
  ListDealNotesParamsSchema,
  NoteSchema,
  SearchDealsParamsSchema,
} from "../models.js";

describe("PipedriveConfigSchema", () => {
  it("accepts a valid config", () => {
    const parsed = PipedriveConfigSchema.parse({ apiToken: "tok", domain: "acme" });
    expect(parsed).toEqual({ apiToken: "tok", domain: "acme" });
  });

  it("rejects a missing/empty token with a clear error", () => {
    const result = PipedriveConfigSchema.safeParse({ apiToken: "", domain: "acme" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("PIPEDRIVE_API_TOKEN is required");
    }
  });

  it("rejects a missing domain", () => {
    const result = PipedriveConfigSchema.safeParse({ apiToken: "tok" });
    expect(result.success).toBe(false);
  });
});

describe("ListDealsParamsSchema", () => {
  it("accepts an empty params object (all filters optional)", () => {
    expect(ListDealsParamsSchema.parse({})).toEqual({});
  });

  it("coerces stringified integer ids to numbers", () => {
    const parsed = ListDealsParamsSchema.parse({ pipeline_id: "2", limit: "50" });
    expect(parsed.pipeline_id).toBe(2);
    expect(parsed.limit).toBe(50);
  });

  it("rejects a non-integer id", () => {
    expect(ListDealsParamsSchema.safeParse({ pipeline_id: "abc" }).success).toBe(false);
  });

  it("validates the close-date range format", () => {
    expect(
      ListDealsParamsSchema.safeParse({ expected_close_from: "2025-07-01" }).success,
    ).toBe(true);
    expect(
      ListDealsParamsSchema.safeParse({ expected_close_from: "07/01/2025" }).success,
    ).toBe(false);
  });

  it("rejects an unknown status value", () => {
    expect(ListDealsParamsSchema.safeParse({ status: "archived" }).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(ListDealsParamsSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe("File entity + deal-file schemas", () => {
  it("accepts a valid file entity with nullable metadata", () => {
    const parsed = FileSchema.parse({
      id: 1,
      name: "sale.xlsx",
      type: "xlsx",
      size: 100,
      deal_id: 42,
      add_time: null,
      url: null,
    });
    expect(parsed.name).toBe("sale.xlsx");
    expect(parsed.type).toBe("xlsx");
  });

  it("requires deal_id for list_deal_files and coerces strings", () => {
    expect(ListDealFilesParamsSchema.parse({ deal_id: "42" }).deal_id).toBe(42);
    expect(ListDealFilesParamsSchema.safeParse({}).success).toBe(false);
    expect(ListDealFilesParamsSchema.safeParse({ deal_id: 1, extra: 2 }).success).toBe(false);
  });

  it("requires file_id for download_file", () => {
    expect(DownloadFileParamsSchema.parse({ file_id: "100" }).file_id).toBe(100);
    expect(DownloadFileParamsSchema.safeParse({}).success).toBe(false);
  });

  it("pins the download result encoding to base64", () => {
    const parsed = DownloadFileResultSchema.parse({
      file_id: 1,
      name: null,
      mime_type: null,
      size: 3,
      encoding: "base64",
      content_base64: "AAAA",
    });
    expect(parsed.encoding).toBe("base64");
    expect(DownloadFileResultSchema.safeParse({
      file_id: 1,
      name: null,
      mime_type: null,
      size: 3,
      encoding: "hex",
      content_base64: "AAAA",
    }).success).toBe(false);
  });
});

describe("pipeline and stage param schemas", () => {
  it("ListStagesParamsSchema accepts an optional coerced pipeline_id filter", () => {
    expect(ListStagesParamsSchema.parse({})).toEqual({});
    expect(ListStagesParamsSchema.parse({ pipeline_id: "3" }).pipeline_id).toBe(3);
  });

  it("ListStagesParamsSchema rejects unknown keys", () => {
    expect(ListStagesParamsSchema.safeParse({ nope: 1 }).success).toBe(false);
  });

  it("GetPipelineParamsSchema requires a pipeline_id", () => {
    expect(GetPipelineParamsSchema.safeParse({}).success).toBe(false);
    expect(GetPipelineParamsSchema.parse({ pipeline_id: "7" }).pipeline_id).toBe(7);
  });

  it("GetStageParamsSchema requires a stage_id", () => {
    expect(GetStageParamsSchema.safeParse({}).success).toBe(false);
    expect(GetStageParamsSchema.parse({ stage_id: 9 }).stage_id).toBe(9);
  });
});

describe("deal product and discount param schemas", () => {
  it("ListDealProductsParamsSchema requires deal_id and coerces it", () => {
    expect(ListDealProductsParamsSchema.safeParse({}).success).toBe(false);
    const parsed = ListDealProductsParamsSchema.parse({ deal_id: "3782", limit: "25" });
    expect(parsed.deal_id).toBe(3782);
    expect(parsed.limit).toBe(25);
  });

  it("ListDealDiscountsParamsSchema requires deal_id", () => {
    expect(ListDealDiscountsParamsSchema.safeParse({}).success).toBe(false);
    expect(ListDealDiscountsParamsSchema.parse({ deal_id: 3782 }).deal_id).toBe(3782);
  });

  it("deal product/discount schemas reject unknown keys", () => {
    expect(ListDealProductsParamsSchema.safeParse({ deal_id: 1, nope: 1 }).success).toBe(false);
    expect(ListDealDiscountsParamsSchema.safeParse({ deal_id: 1, nope: 1 }).success).toBe(false);
  });
});

describe("EntityByIdParamsSchema", () => {
  it("coerces a stringified id to a number", () => {
    expect(EntityByIdParamsSchema.parse({ id: "679" })).toEqual({ id: 679 });
  });

  it("rejects a missing or non-positive id", () => {
    expect(EntityByIdParamsSchema.safeParse({}).success).toBe(false);
    expect(EntityByIdParamsSchema.safeParse({ id: 0 }).success).toBe(false);
    expect(EntityByIdParamsSchema.safeParse({ id: "abc" }).success).toBe(false);
  });
});

describe("OrganizationSchema", () => {
  it("accepts a resolved organization with a null address and null VAT/SIREN", () => {
    const parsed = OrganizationSchema.parse({
      id: 679,
      name: "ATLAS COPCO",
      address: null,
      vat: null,
      siren: null,
      org_url: "https://acme.pipedrive.com/organization/679",
    });
    expect(parsed.name).toBe("ATLAS COPCO");
  });
});

describe("PersonSchema", () => {
  it("accepts a resolved person with contact details", () => {
    const parsed = PersonSchema.parse({
      id: 1609,
      name: "Kristof Heselmans",
      first_name: "Kristof",
      last_name: "Heselmans",
      job_title: null,
      org_id: 10282,
      emails: [{ label: "work", value: "k@x.com", primary: true }],
      phones: [],
      primary_email: "k@x.com",
      primary_phone: null,
      person_url: "https://acme.pipedrive.com/person/1609",
    });
    expect(parsed.primary_email).toBe("k@x.com");
  });
});

describe("SearchDealsParamsSchema", () => {
  it("accepts a term with optional filters and coerces ids", () => {
    const parsed = SearchDealsParamsSchema.parse({
      term: "try & buy",
      status: "open",
      org_id: "8949",
    });
    expect(parsed.term).toBe("try & buy");
    expect(parsed.org_id).toBe(8949);
  });

  it("rejects a term shorter than 2 characters", () => {
    expect(SearchDealsParamsSchema.safeParse({ term: "t" }).success).toBe(false);
  });

  it("requires a term", () => {
    expect(SearchDealsParamsSchema.safeParse({ status: "open" }).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(SearchDealsParamsSchema.safeParse({ term: "try", nope: 1 }).success).toBe(false);
  });
});

describe("ListDealNotesParamsSchema", () => {
  it("requires a deal_id and coerces it", () => {
    expect(ListDealNotesParamsSchema.parse({ deal_id: "3776" }).deal_id).toBe(3776);
    expect(ListDealNotesParamsSchema.safeParse({}).success).toBe(false);
  });
});

describe("ListDealActivitiesParamsSchema", () => {
  it("accepts a deal_id and optional done flag", () => {
    const parsed = ListDealActivitiesParamsSchema.parse({ deal_id: 3776, done: true });
    expect(parsed.done).toBe(true);
  });

  it("rejects a non-boolean done", () => {
    expect(ListDealActivitiesParamsSchema.safeParse({ deal_id: 3776, done: "yes" }).success).toBe(
      false,
    );
  });
});

describe("NoteSchema / ActivitySchema", () => {
  it("parse projected entity shapes", () => {
    expect(
      NoteSchema.parse({
        id: 1,
        deal_id: 3776,
        content: "PO ok",
        user_id: 15,
        user_name: "Eric",
        person_id: null,
        org_id: null,
        add_time: "2026-01-26 13:42:18",
        update_time: "2026-01-26 13:42:18",
      }).user_name,
    ).toBe("Eric");

    expect(
      ActivitySchema.parse({
        id: 2,
        deal_id: 3776,
        type: "task",
        subject: "Follow up",
        note: null,
        done: false,
        due_date: "2021-12-09",
        due_time: null,
        marked_as_done_time: null,
        user_id: 12,
        add_time: null,
        update_time: null,
      }).type,
    ).toBe("task");
  });
});
