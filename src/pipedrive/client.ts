import {
  PipedriveAuthError,
  PipedriveConnectionError,
  PipedriveError,
  PipedriveNotFoundError,
  PipedriveOutcomeUnknownError,
  PipedriveRateLimitError,
  PipedriveServerError,
  PipedriveValidationError,
} from "./errors.js";
import {
  type ActivityDetail,
  type ActivityType,
  type Address,
  type ContactDetail,
  type DealDetail,
  DealFieldSchema,
  type DealField,
  type DealDiscount,
  type DealProduct,
  type DealSummary,
  type DownloadFileParams,
  type DownloadFileResult,
  type File,
  type GetActivityParams,
  type GetDealFieldParams,
  type GetDealParams,
  type ListActivityTypesResult,
  type ListContactFieldsParams,
  type OrganizationDetail,
  type OrganizationSearchMatch,
  type PersonDetail,
  type PersonSearchMatch,
  type SearchOrganizationsParams,
  type SearchOrganizationsResult,
  type SearchPersonsParams,
  type SearchPersonsResult,
  type ListDealDiscountsParams,
  type ListUsersResult,
  type ListDealDiscountsResult,
  type ListDealFieldsParams,
  type ListDealFieldsResult,
  type ListDealFilesParams,
  type ListDealFilesResult,
  type ListDealProductsParams,
  type ListDealProductsResult,
  type ListDealsParams,
  type ListDealsResult,
  type ListPipelinesParams,
  type ListPipelinesResult,
  type ListStagesParams,
  type ListStagesResult,
  type PaginationInfo,
  type Pipeline,
  type PipedriveConfig,
  type RefreshFieldRegistryResult,
  type Stage,
  type Activity,
  type DealSearchMatch,
  type GetLeadParams,
  type LeadDetail,
  type LeadSearchMatch,
  type LeadSummary,
  type ListDealActivitiesParams,
  type ListDealActivitiesResult,
  type ListDealNotesParams,
  type ListDealNotesResult,
  type ListLeadActivitiesParams,
  type ListLeadLabelsResult,
  type ListLeadNotesParams,
  type ListLeadsParams,
  type ListLeadsResult,
  type ListLeadSourcesResult,
  type Note,
  type SearchDealsParams,
  type SearchDealsResult,
  type SearchLeadsParams,
  type SearchLeadsResult,
} from "./models.js";
import { buildRegistry, FieldRegistryStore, type FieldRegistryStoreOptions } from "./field-registry.js";
import { normalizeCustomFields } from "./normalizer.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 6;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

/** v1 dealFields page size when the registry builder paginates. */
const FIELD_PAGE_LIMIT = 500;
/** Safety bound on dealField pagination pages. */
const MAX_FIELD_PAGES = 20;

/** Number of internal pages fetched per list_deals call when a close-date range narrows results. */
const MAX_INTERNAL_PAGES = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Best-effort file extension from a name, lowercased, without the dot. */
function fileExtension(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

function toBooleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Like toStringOrNull but also accepts a finite number, stringified (Pipedrive is inconsistent about it for e.g. visible_to). */
function toStringLikeOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** A lead's monetary value ({amount, currency}), or null when either part is missing. */
function toLeadValue(value: unknown): { amount: number; currency: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const amount = toNumberOrNull(record.amount);
  const currency = toStringOrNull(record.currency);
  if (amount === null || currency === null) return null;
  return { amount, currency };
}

/** An {id, name} reference (owner/person/organization on a lead search match), or null. */
function toRef(value: unknown): { id: number; name: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = toNumberOrNull(record.id);
  if (id === null) return null;
  return { id, name: toStringOrNull(record.name) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export interface PipedriveClientOptions extends Omit<PipedriveConfig, "allowWrite"> {
  /** Enables mutation methods on PipedriveWriteClient; the base read client ignores it. Defaults to false. */
  allowWrite?: boolean;
  timeoutMs?: number;
  /** Overrides for the file-backed field-registry cache (path/TTL/grace/clock). */
  registryOptions?: FieldRegistryStoreOptions;
}

interface RawDeal {
  id: number;
  title?: string;
  value?: unknown;
  currency?: unknown;
  status?: unknown;
  stage_id?: unknown;
  pipeline_id?: unknown;
  person_id?: unknown;
  org_id?: unknown;
  owner_id?: unknown;
  user_id?: unknown;
  expected_close_date?: unknown;
  add_time?: unknown;
  update_time?: unknown;
  won_time?: unknown;
  custom_fields?: unknown;
  [key: string]: unknown;
}

interface DealsPage {
  data: RawDeal[];
  nextCursor: string | null;
}

interface RawFile {
  id: number;
  name?: unknown;
  file_name?: unknown;
  file_type?: unknown;
  file_size?: unknown;
  deal_id?: unknown;
  add_time?: unknown;
  url?: unknown;
  remote_location?: unknown;
  [key: string]: unknown;
}

interface RawAddress {
  /** v2 documents the display line as `value`; `formatted_address` is the older name. */
  formatted_address?: unknown;
  value?: unknown;
  street_number?: unknown;
  route?: unknown;
  locality?: unknown;
  sublocality?: unknown;
  admin_area_level_1?: unknown;
  admin_area_level_2?: unknown;
  postal_code?: unknown;
  country?: unknown;
  [key: string]: unknown;
}

interface RawContactDetail {
  label?: unknown;
  value?: unknown;
  primary?: unknown;
}

/** Substring patterns (lowercased field name) that identify a VAT or SIREN custom field. */
const VAT_NAME_PATTERNS = ["vat", "tva"];
const SIREN_NAME_PATTERNS = ["siren", "siret"];

interface RawNote {
  id: number;
  deal_id?: unknown;
  lead_id?: unknown;
  content?: unknown;
  user_id?: unknown;
  person_id?: unknown;
  org_id?: unknown;
  add_time?: unknown;
  update_time?: unknown;
  user?: { name?: unknown } | null;
  [key: string]: unknown;
}

interface RawActivity {
  id: number;
  deal_id?: unknown;
  type?: unknown;
  subject?: unknown;
  note?: unknown;
  done?: unknown;
  due_date?: unknown;
  due_time?: unknown;
  marked_as_done_time?: unknown;
  user_id?: unknown;
  add_time?: unknown;
  update_time?: unknown;
  [key: string]: unknown;
}

/** v2 /activities payload shape — owner_id in place of v1's user_id. */
interface RawActivityV2 {
  id?: unknown;
  lead_id?: unknown;
  deal_id?: unknown;
  person_id?: unknown;
  org_id?: unknown;
  owner_id?: unknown;
  subject?: unknown;
  type?: unknown;
  done?: unknown;
  due_date?: unknown;
  due_time?: unknown;
  marked_as_done_time?: unknown;
  note?: unknown;
  add_time?: unknown;
  update_time?: unknown;
  [key: string]: unknown;
}

interface RawLead {
  id: string;
  title?: unknown;
  owner_id?: unknown;
  creator_id?: unknown;
  label_ids?: unknown;
  person_id?: unknown;
  organization_id?: unknown;
  source_name?: unknown;
  origin?: unknown;
  origin_id?: unknown;
  channel?: unknown;
  channel_id?: unknown;
  is_archived?: unknown;
  was_seen?: unknown;
  value?: unknown;
  expected_close_date?: unknown;
  next_activity_id?: unknown;
  add_time?: unknown;
  update_time?: unknown;
  visible_to?: unknown;
  cc_email?: unknown;
  custom_fields?: unknown;
  [key: string]: unknown;
}


/** The `data.items` list of a v2 search response ([] when absent). */
function searchItems(data: Record<string, unknown>): Record<string, unknown>[] {
  const items = asRecord(data.data).items;
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}

function ownerName(names: Map<number, string>, id: number | null): string | null {
  return id === null ? null : (names.get(id) ?? null);
}

export class PipedriveClient {
  readonly apiToken: string;
  readonly domain: string;
  readonly baseUrlV1: string;
  readonly baseUrlV2: string;
  readonly registry: FieldRegistryStore;
  protected readonly timeoutMs: number;
  protected readonly allowWrite: boolean;
  /** Lazily-resolved custom-field keys for VAT / SIREN (undefined until first lookup). */
  private orgFieldKeys: { vat: string | null; siren: string | null } | undefined;
  /** Cached user id → name map for owner_name (null until first successful load). */
  private ownerNames: Map<number, string> | null = null;

  constructor(options: PipedriveClientOptions) {
    this.apiToken = options.apiToken;
    this.domain = options.domain;
    this.baseUrlV1 = `https://${this.domain}.pipedrive.com/api/v1`;
    this.baseUrlV2 = `https://${this.domain}.pipedrive.com/api/v2`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.allowWrite = options.allowWrite === true;
    this.registry = new FieldRegistryStore(
      () => this.fetchAllDealFields(),
      options.registryOptions,
    );
  }

  /**
   * Resolve a deal's org_id to the organization entity: name, structured
   * address, and VAT/SIREN when stored as custom fields. Throws
   * PipedriveNotFoundError when the org does not exist (e.g. a deal with no
   * linked organization passes org_id=null and should be guarded by the caller).
   */
  async getOrganization(id: number, outputType?: "full" | "lean"): Promise<OrganizationDetail> {
    const data = await this.requestJson("GET", "v2", `organizations/${id}`);
    const raw = data.data as Record<string, unknown> | null | undefined;
    if (!raw || typeof raw.id !== "number") {
      throw new PipedriveNotFoundError(`Organization ${id} not found`, {
        endpoint: `organizations/${id}`,
        status: 404,
      });
    }
    const customFields = (raw.custom_fields as Record<string, unknown> | undefined) ?? {};
    const keys = await this.resolveOrgFieldKeys();
    const detail: OrganizationDetail = {
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : "",
      address: parseAddress(raw.address),
      vat: keys.vat ? toStringOrNull(customFields[keys.vat]) : null,
      siren: keys.siren ? toStringOrNull(customFields[keys.siren]) : null,
      org_url: `https://${this.domain}.pipedrive.com/organization/${raw.id}`,
    };
    if (outputType !== "full") return detail;
    detail.owner_id = toNumberOrNull(raw.owner_id);
    detail.add_time = toStringOrNull(raw.add_time);
    detail.update_time = toStringOrNull(raw.update_time);
    await this.attachContactCustomFields(detail, "organization", customFields);
    return detail;
  }

  /** Best-effort normalized custom fields for get_person/get_organization full mode. */
  private async attachContactCustomFields(
    detail: PersonDetail | OrganizationDetail,
    entity: "person" | "organization",
    customFields: Record<string, unknown>,
  ): Promise<void> {
    try {
      const registry = buildRegistry(await this.fetchAllFields(entity));
      const normalized = normalizeCustomFields(customFields, registry);
      detail.normalized_extra_fields = normalized.normalized_extra_fields;
      detail.normalized_field_metadata = normalized.normalized_field_metadata;
    } catch {
      // Field metadata is best-effort on reads; writes re-fetch it and fail closed.
    }
  }

  /**
   * Resolve a deal's person_id to the person entity: primary contact name and
   * contact details (emails/phones with primary flagged). Throws
   * PipedriveNotFoundError when the person does not exist.
   */
  async getPerson(id: number, outputType?: "full" | "lean"): Promise<PersonDetail> {
    const data = await this.requestJson("GET", "v2", `persons/${id}`);
    const raw = data.data as Record<string, unknown> | null | undefined;
    if (!raw || typeof raw.id !== "number") {
      throw new PipedriveNotFoundError(`Person ${id} not found`, {
        endpoint: `persons/${id}`,
        status: 404,
      });
    }
    const emails = parseContactDetails(raw.emails);
    const phones = parseContactDetails(raw.phones);
    const detail: PersonDetail = {
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : "",
      first_name: toStringOrNull(raw.first_name),
      last_name: toStringOrNull(raw.last_name),
      job_title: toStringOrNull(raw.job_title),
      org_id: toNumberOrNull(raw.org_id),
      emails,
      phones,
      primary_email: primaryValue(emails),
      primary_phone: primaryValue(phones),
      person_url: `https://${this.domain}.pipedrive.com/person/${raw.id}`,
    };
    if (outputType !== "full") return detail;
    detail.owner_id = toNumberOrNull(raw.owner_id);
    detail.add_time = toStringOrNull(raw.add_time);
    detail.update_time = toStringOrNull(raw.update_time);
    await this.attachContactCustomFields(detail, "person", asRecord(raw.custom_fields));
    return detail;
  }

  /**
   * Look up (and cache) the VAT/SIREN custom-field keys by name-matching the
   * organizationFields definitions. Returns nulls when the Pipedrive account
   * has no such fields, so VAT/SIREN resolve to null ("when present").
   */
  private async resolveOrgFieldKeys(): Promise<{ vat: string | null; siren: string | null }> {
    if (this.orgFieldKeys !== undefined) return this.orgFieldKeys;
    let vat: string | null = null;
    let siren: string | null = null;
    try {
      const data = await this.requestJson("GET", "v1", "organizationFields");
      const fields = Array.isArray(data.data) ? (data.data as Record<string, unknown>[]) : [];
      for (const field of fields) {
        const name = typeof field.name === "string" ? field.name.toLowerCase() : "";
        const key = typeof field.key === "string" ? field.key : null;
        if (key === null) continue;
        if (vat === null && VAT_NAME_PATTERNS.some((p) => name.includes(p))) vat = key;
        if (siren === null && SIREN_NAME_PATTERNS.some((p) => name.includes(p))) siren = key;
      }
    } catch {
      // Custom-field discovery is best-effort; without it VAT/SIREN stay null.
    }
    this.orgFieldKeys = { vat, siren };
    return this.orgFieldKeys;
  }

  /**
   * List deals with server-side filters (pipeline/stage/status/person/org/user)
   * plus the net-new expected-close-date and won-date range filters, both
   * applied client-side during cursor pagination assembly. Returns a lean
   * per-deal projection and a next_cursor that resumes exactly where this
   * page stopped (no gaps or dupes).
   */
  async listDeals(params: ListDealsParams): Promise<ListDealsResult> {
    const limit = Math.min(params.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const from = params.expected_close_from ?? null;
    const to = params.expected_close_to ?? null;
    const hasRange = from !== null || to !== null;
    const wonFrom = params.won_from ?? null;
    const wonTo = params.won_to ?? null;
    const hasWonRange = wonFrom !== null || wonTo !== null;
    const hasFilter = hasRange || hasWonRange;

    const query: Record<string, string | number> = {
      limit,
      status: params.status ?? "open",
      sort_by: params.sort_by ?? "update_time",
      sort_direction: params.sort_direction ?? "desc",
    };
    if (params.pipeline_id !== undefined) query.pipeline_id = params.pipeline_id;
    if (params.stage_id !== undefined) query.stage_id = params.stage_id;
    if (params.person_id !== undefined) query.person_id = params.person_id;
    if (params.org_id !== undefined) query.org_id = params.org_id;
    if (params.user_id !== undefined) query.user_id = params.user_id;
    const fieldKeys = params.custom_fields ? await this.resolveDealFieldKeys(params.custom_fields) : null;
    if (fieldKeys) query.custom_fields = fieldKeys.join(",");

    const matches: DealSummary[] = [];
    let cursor = params.cursor ?? null;
    let pagesFetched = 0;

    // Without a close-date range this loop runs once and returns Pipedrive's
    // native page + cursor unchanged. With a range it keeps fetching pages
    // until `limit` matches are collected (or the pipeline is exhausted),
    // returning the cursor at the stopping point so the next call resumes cleanly.
    do {
      const pageQuery = { ...query };
      if (cursor !== null) pageQuery.cursor = cursor;

      const page = await this.fetchDealsPage(pageQuery);
      pagesFetched += 1;

      for (const raw of page.data) {
        if (hasRange && !inCloseDateRange(raw.expected_close_date, from, to)) continue;
        if (hasWonRange && !inWonDateRange(raw.won_time, wonFrom, wonTo)) continue;
        const summary = this.toDealSummary(raw);
        if (fieldKeys) summary.custom_fields = await this.pickCustomFields(raw, fieldKeys);
        matches.push(summary);
      }

      cursor = page.nextCursor;

      if (!hasFilter) break;
      // Stop once we have at least `limit` in-range matches. We break at a
      // native page boundary (never mid-page), so the returned cursor resumes
      // cleanly with no gaps or dupes. A single page may push the count
      // slightly over `limit`; we keep those deals rather than drop them
      // (dropping would lose deals the advanced cursor has already skipped).
      if (matches.length >= limit) break;
      if (cursor === null) break;
    } while (pagesFetched < MAX_INTERNAL_PAGES);

    const names = await this.loadOwnerNames();
    for (const deal of matches) deal.owner_name = ownerName(names, deal.user_id);

    return {
      deals: matches,
      next_cursor: cursor,
      count: matches.length,
    };
  }

  /**
   * List files/attachments linked to a deal with a lean metadata projection
   * (name, type, size + the id needed to download). Read-only; nothing parsed.
   */
  async listDealFiles(params: ListDealFilesParams): Promise<ListDealFilesResult> {
    // Deal files live on the v1 API: GET /deals/{id}/files.
    const data = await this.requestJson("GET", "v1", `deals/${params.deal_id}/files`, {
      limit: 500,
    });
    const rows = Array.isArray(data.data) ? (data.data as RawFile[]) : [];
    const files = rows.map((raw) => this.toFile(raw));
    return { files, count: files.length };
  }

  /**
   * Download a file's raw bytes, unparsed and untransformed. Returns the
   * content base64-encoded so binary formats (e.g. .xlsx) round-trip through
   * JSON with byte integrity intact. Parsing happens downstream, not here.
   */
  async downloadFile(params: DownloadFileParams): Promise<DownloadFileResult> {
    // v1 raw download endpoint returns the file body, not JSON.
    const { bytes, contentType } = await this.requestBinary(
      "v1",
      `files/${params.file_id}/download`,
    );
    return {
      file_id: params.file_id,
      name: null,
      mime_type: contentType,
      size: bytes.length,
      encoding: "base64",
      content_base64: bytes.toString("base64"),
    };
  }

  private toFile(raw: RawFile): File {
    const name = toStringOrNull(raw.name) ?? toStringOrNull(raw.file_name) ?? "";
    return {
      id: raw.id,
      name,
      type: toStringOrNull(raw.file_type) ?? fileExtension(name),
      size: toNumberOrNull(raw.file_size),
      deal_id: toNumberOrNull(raw.deal_id),
      add_time: toStringOrNull(raw.add_time),
      url: toStringOrNull(raw.url),
      remote_location: toStringOrNull(raw.remote_location),
    };
  }

  /**
   * List custom-field (dealField) definitions for one v1 offset page.
   * Returns the raw field list + pagination block so callers can page through.
   */
  async listDealFields(params: ListDealFieldsParams = {}): Promise<ListDealFieldsResult> {
    const query: Record<string, string | number> = {
      start: params.start ?? 0,
      limit: params.limit ?? DEFAULT_PAGE_LIMIT,
    };
    const data = await this.requestJson("GET", "v1", "dealFields", query);
    const rows = Array.isArray(data.data) ? data.data : [];
    const fields = rows.map((row) => this.toDealField(row));

    const additional = data.additional_data as Record<string, unknown> | undefined;
    const pagination = this.toPagination(additional?.pagination);
    return { fields, pagination };
  }

  /** Get a single custom-field (dealField) definition by numeric ID (v1). */
  async getDealField(params: GetDealFieldParams): Promise<DealField> {
    const data = await this.requestJson("GET", "v1", `dealFields/${params.field_id}`);
    return this.toDealField(data.data);
  }

  /**
   * Fetch every dealField across all v1 offset pages. Used by the registry
   * builder; not exposed as a tool directly.
   */
  async fetchAllDealFields(): Promise<DealField[]> {
    const all: DealField[] = [];
    let start = 0;

    for (let page = 0; page < MAX_FIELD_PAGES; page += 1) {
      const result = await this.listDealFields({ start, limit: FIELD_PAGE_LIMIT });
      all.push(...result.fields);

      const pagination = result.pagination;
      if (!pagination || !pagination.more_items_in_collection) break;
      const next = pagination.next_start;
      if (typeof next !== "number") break;
      start = next;
    }

    return all;
  }

  /**
   * Fetch every field definition of one entity across all v1 offset pages,
   * failing closed (throws) on malformed pages, pagination loops or hitting
   * the page safety bound. Never cached: writes need complete, fresh metadata.
   */
  async fetchAllFields(entity: "deal" | "person" | "organization"): Promise<DealField[]> {
    const endpoint = { deal: "dealFields", person: "personFields", organization: "organizationFields" }[entity];
    const all: DealField[] = [];
    let start = 0;

    for (let page = 0; page < MAX_FIELD_PAGES; page += 1) {
      const data = await this.requestJson("GET", "v1", endpoint, { start, limit: FIELD_PAGE_LIMIT });
      if (!Array.isArray(data.data)) {
        throw new PipedriveError(`Malformed ${endpoint} response: expected a list of field definitions`, { endpoint });
      }
      for (const row of data.data) {
        const definition = asRecord(row);
        if (typeof definition.key !== "string" || definition.key === "" || typeof definition.name !== "string" || typeof definition.field_type !== "string") {
          throw new PipedriveError(`Malformed ${endpoint} response: a field definition has no key, name or field_type`, { endpoint });
        }
      }
      all.push(...data.data.map((row) => this.toDealField(row)));

      const rawPagination = asRecord(data.additional_data).pagination;
      if (rawPagination !== undefined && typeof asRecord(rawPagination).more_items_in_collection !== "boolean") {
        throw new PipedriveError(`Malformed ${endpoint} pagination metadata; field list may be incomplete`, { endpoint });
      }
      const pagination = this.toPagination(rawPagination);
      if (!pagination) {
        if (data.data.length < FIELD_PAGE_LIMIT) return all;
        throw new PipedriveError(`${endpoint} pagination metadata missing for a full page; field list may be incomplete`, { endpoint });
      }
      if (!pagination.more_items_in_collection) return all;
      const next = pagination.next_start;
      if (typeof next !== "number" || next <= start) {
        throw new PipedriveError(`${endpoint} pagination did not advance; field list may be incomplete`, { endpoint });
      }
      start = next;
    }
    throw new PipedriveError(`${endpoint} exceeded ${MAX_FIELD_PAGES} pages; field list may be incomplete`, { endpoint });
  }

  /** List person/organization custom-field definitions for one v1 offset page. */
  async listContactFields(params: ListContactFieldsParams): Promise<ListDealFieldsResult> {
    const endpoint = params.entity === "person" ? "personFields" : "organizationFields";
    const data = await this.requestJson("GET", "v1", endpoint, {
      start: params.start ?? 0,
      limit: params.limit ?? DEFAULT_PAGE_LIMIT,
    });
    const rows = Array.isArray(data.data) ? data.data : [];
    return {
      fields: rows.map((row) => this.toDealField(row)),
      pagination: this.toPagination(asRecord(data.additional_data).pagination),
    };
  }

  /** Free-text person search (v2 /persons/search), cursor-paginated. */
  async searchPersons(params: SearchPersonsParams): Promise<SearchPersonsResult> {
    const query: Record<string, string | number> = {
      term: params.term,
      limit: Math.min(params.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    };
    if (params.fields !== undefined) query.fields = params.fields;
    if (params.exact_match) query.exact_match = "true";
    if (params.organization_id !== undefined) query.organization_id = params.organization_id;
    if (params.cursor !== undefined) query.cursor = params.cursor;

    const data = await this.requestJson("GET", "v2", "persons/search", query);
    const items = searchItems(data);
    const persons = items.map((entry) => this.toPersonSearchMatch(entry));
    return { persons, next_cursor: toStringOrNull(asRecord(data.additional_data).next_cursor), count: persons.length };
  }

  private toPersonSearchMatch(entry: Record<string, unknown>): PersonSearchMatch {
    const item = asRecord(entry.item ?? entry);
    const org = asRecord(item.organization);
    const id = toNumberOrNull(item.id) ?? 0;
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    return {
      id,
      name: typeof item.name === "string" ? item.name : "",
      emails: strings(item.emails),
      phones: strings(item.phones),
      org_id: toNumberOrNull(org.id),
      org_name: toStringOrNull(org.name),
      result_score: toNumberOrNull(entry.result_score),
      person_url: `https://${this.domain}.pipedrive.com/person/${id}`,
    };
  }

  /** Free-text organization search (v2 /organizations/search), cursor-paginated. */
  async searchOrganizations(params: SearchOrganizationsParams): Promise<SearchOrganizationsResult> {
    const query: Record<string, string | number> = {
      term: params.term,
      limit: Math.min(params.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    };
    if (params.fields !== undefined) query.fields = params.fields;
    if (params.exact_match) query.exact_match = "true";
    if (params.cursor !== undefined) query.cursor = params.cursor;

    const data = await this.requestJson("GET", "v2", "organizations/search", query);
    const organizations = searchItems(data).map((entry): OrganizationSearchMatch => {
      const item = asRecord(entry.item ?? entry);
      const id = toNumberOrNull(item.id) ?? 0;
      return {
        id,
        name: typeof item.name === "string" ? item.name : "",
        address: toStringOrNull(item.address),
        result_score: toNumberOrNull(entry.result_score),
        org_url: `https://${this.domain}.pipedrive.com/organization/${id}`,
      };
    });
    return {
      organizations,
      next_cursor: toStringOrNull(asRecord(data.additional_data).next_cursor),
      count: organizations.length,
    };
  }

  /** Read one activity by id (v2 /activities/{id}). */
  async getActivity(params: GetActivityParams): Promise<ActivityDetail> {
    const data = await this.requestJson("GET", "v2", `activities/${params.id}`);
    const raw = asRecord(data.data) as RawActivityV2;
    if (toNumberOrNull(raw.id) === null) {
      throw new PipedriveNotFoundError(`Activity ${params.id} not found`, {
        endpoint: `activities/${params.id}`,
        status: 404,
      });
    }
    return {
      ...toActivityV2(raw),
      lead_id: toStringOrNull(raw.lead_id),
      person_id: toNumberOrNull(raw.person_id),
      org_id: toNumberOrNull(raw.org_id),
      duration: toStringOrNull(raw.duration),
    };
  }

  /** List activity types (v1 /activityTypes) to resolve a valid `type` key for create_activity. */
  async listActivityTypes(): Promise<ListActivityTypesResult> {
    const data = await this.requestJson("GET", "v1", "activityTypes");
    const rows = Array.isArray(data.data) ? (data.data as Record<string, unknown>[]) : [];
    const types = rows
      .filter((raw) => typeof raw.id === "number" && typeof raw.key_string === "string")
      .map(
        (raw): ActivityType => ({
          id: raw.id as number,
          name: typeof raw.name === "string" ? raw.name : "",
          key_string: raw.key_string as string,
          active: raw.active_flag === true,
        }),
      );
    return { types, count: types.length };
  }

  /** Force a rebuild of the cached field registry from the API. */
  async refreshFieldRegistry(): Promise<RefreshFieldRegistryResult> {
    try {
      const registry = await this.registry.refresh();
      return {
        success: true,
        message: "Field registry refreshed successfully",
        field_count: Object.keys(registry.by_key).length,
        version: registry.version,
        built_at: registry.built_at,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to refresh registry: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Full single-deal read. Flattens v2 `custom_fields`, resolves them through
   * the file-cached registry + normalizer, and builds the deal URL. `full`
   * mode (default) returns normalized custom fields + metadata; `lean` strips
   * them.
   */
  async getDeal(params: GetDealParams): Promise<DealDetail> {
    const mode = params.output_type ?? "full";
    const data = await this.requestJson("GET", "v2", `deals/${params.deal_id}`);
    const raw = (data.data ?? {}) as RawDeal;

    const detail: DealDetail = {
      id: typeof raw.id === "number" ? raw.id : params.deal_id,
      title: typeof raw.title === "string" ? raw.title : "",
      value: toNumberOrNull(raw.value),
      currency: toStringOrNull(raw.currency),
      status: toStringOrNull(raw.status),
      stage_id: toNumberOrNull(raw.stage_id),
      pipeline_id: toNumberOrNull(raw.pipeline_id),
      person_id: toNumberOrNull(raw.person_id),
      org_id: toNumberOrNull(raw.org_id),
      user_id: toNumberOrNull(raw.owner_id ?? raw.user_id),
      owner_name: null,
      expected_close_date: toStringOrNull(raw.expected_close_date),
      add_time: toStringOrNull(raw.add_time),
      update_time: toStringOrNull(raw.update_time),
      won_time: toStringOrNull(raw.won_time),
      deal_url: `https://${this.domain}.pipedrive.com/deal/${params.deal_id}`,
    };

    detail.owner_name = ownerName(await this.loadOwnerNames(), detail.user_id);

    if (mode === "lean") {
      return detail;
    }

    return this.withNormalizedFields(detail, flattenCustomFields(raw));
  }

  /**
   * Attach normalized custom fields to a detail. Registry unavailable (fetch
   * failed, no cache): return standard fields rather than fail the whole read;
   * custom fields simply stay unresolved.
   */
  private async withNormalizedFields<T extends DealDetail | LeadDetail>(
    detail: T,
    extraFields: Record<string, unknown>,
  ): Promise<T> {
    let registry = null;
    try {
      registry = await this.registry.get();
    } catch {
      registry = null;
    }

    const normalized = normalizeCustomFields(extraFields, registry);
    detail.normalized_extra_fields = normalized.normalized_extra_fields;
    detail.normalized_field_metadata = normalized.normalized_field_metadata;
    return detail;
  }

  protected toDealField(raw: unknown): DealField {
    const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const known = new Set([
      "id",
      "key",
      "name",
      "field_type",
      "options",
      "edit_flag",
      "add_visible_flag",
      "mandatory_flag",
    ]);
    const extra_fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!known.has(key)) extra_fields[key] = value;
    }
    return DealFieldSchema.parse({
      id: typeof record.id === "number" ? record.id : null,
      key: typeof record.key === "string" ? record.key : "",
      name: typeof record.name === "string" ? record.name : "",
      field_type: typeof record.field_type === "string" ? record.field_type : "",
      options: Array.isArray(record.options) ? record.options : null,
      edit_flag: typeof record.edit_flag === "boolean" ? record.edit_flag : undefined,
      add_visible_flag:
        typeof record.add_visible_flag === "boolean" ? record.add_visible_flag : undefined,
      mandatory_flag:
        typeof record.mandatory_flag === "boolean" ? record.mandatory_flag : undefined,
      extra_fields,
    });
  }

  private toPagination(raw: unknown): PaginationInfo | null {
    if (!raw || typeof raw !== "object") return null;
    const p = raw as Record<string, unknown>;
    return {
      start: toNumberOrNull(p.start) ?? 0,
      limit: toNumberOrNull(p.limit) ?? 0,
      more_items_in_collection: p.more_items_in_collection === true,
      next_start: toNumberOrNull(p.next_start),
    };
  }

  private async fetchDealsPage(query: Record<string, string | number>): Promise<DealsPage> {
    const data = await this.requestJson("GET", "v2", "deals", query);
    const rows = Array.isArray(data.data) ? (data.data as RawDeal[]) : [];
    const additional = data.additional_data as Record<string, unknown> | undefined;
    const nextCursor = toStringOrNull(additional?.next_cursor);
    return { data: rows, nextCursor };
  }

  private toDealSummary(raw: RawDeal): DealSummary {
    return {
      id: raw.id,
      title: typeof raw.title === "string" ? raw.title : "",
      value: toNumberOrNull(raw.value),
      currency: toStringOrNull(raw.currency),
      status: toStringOrNull(raw.status),
      stage_id: toNumberOrNull(raw.stage_id),
      pipeline_id: toNumberOrNull(raw.pipeline_id),
      person_id: toNumberOrNull(raw.person_id),
      org_id: toNumberOrNull(raw.org_id),
      user_id: toNumberOrNull(raw.owner_id ?? raw.user_id),
      owner_name: null,
      expected_close_date: toStringOrNull(raw.expected_close_date),
      won_time: toStringOrNull(raw.won_time),
      local_won_date: toStringOrNull(raw.local_won_date),
      local_close_date: toStringOrNull(raw.local_close_date),
      deal_url: `https://${this.domain}.pipedrive.com/deal/${raw.id}`,
    };
  }

  private buildUrl(
    version: "v1" | "v2",
    endpoint: string,
    query: Record<string, string | number>,
  ): string {
    const base = version === "v2" ? this.baseUrlV2 : this.baseUrlV1;
    const url = new URL(`${base}/${endpoint}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    url.searchParams.set("api_token", this.apiToken);
    return url.toString();
  }

  async validate(): Promise<{ ok: true; account: Record<string, unknown> }> {
    const data = await this.requestJson("GET", "v1", "users/me");
    return { ok: true, account: asRecord(data.data) };
  }

  /**
   * JSON transport. GET keeps the existing retry behaviour (429 and 5xx). Any
   * other method is a mutation: only an explicit 429 is retried (the request
   * was rejected, so replay is safe); timeouts, network failures, 5xx and
   * malformed success bodies raise PipedriveOutcomeUnknownError because the
   * write may already have been applied.
   */
  protected async requestJson(
    method: string,
    version: "v1" | "v2",
    endpoint: string,
    query: Record<string, string | number> = {},
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const url = this.buildUrl(version, endpoint, query);
    const isMutation = method !== "GET";
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.status === 429) {
          if (attempt < MAX_ATTEMPTS - 1) {
            await sleep(this.retryDelayMs(response, attempt));
            continue;
          }
          throw new PipedriveRateLimitError("Pipedrive rate limit exceeded", {
            endpoint,
            status: 429,
          });
        }

        if (response.status >= 500) {
          if (!isMutation && attempt < MAX_ATTEMPTS - 1) {
            await sleep(this.retryDelayMs(response, attempt));
            continue;
          }
          const responseBody = await this.readErrorMessage(response);
          if (isMutation) {
            throw new PipedriveOutcomeUnknownError(
              `Pipedrive returned status ${response.status} for ${method} ${endpoint}; the change may or may not have been applied. Do not retry blindly: read the record to reconcile first. ${responseBody}`,
              { endpoint, status: response.status, responseBody },
            );
          }
          throw new PipedriveServerError(
            `Pipedrive server error with status ${response.status} for ${endpoint}: ${responseBody}`,
            {
              endpoint,
              status: response.status,
              responseBody,
            },
          );
        }

        if (!response.ok) {
          const responseBody = await this.readErrorMessage(response);
          const message = `Pipedrive request failed for ${endpoint}: ${responseBody}`;
          const options = { endpoint, status: response.status, responseBody };
          if (response.status === 401 || response.status === 403) {
            throw new PipedriveAuthError(message, options);
          }
          if (response.status === 404) {
            throw new PipedriveNotFoundError(message, options);
          }
          if (response.status === 400 || response.status === 409 || response.status === 422) {
            throw new PipedriveValidationError(message, options);
          }
          throw new PipedriveError(message, options);
        }

        const text = await response.text();
        if (!isMutation) return text ? (JSON.parse(text) as Record<string, unknown>) : {};
        return this.parseMutationBody(text, method, endpoint);
      } catch (error) {
        if (error instanceof PipedriveError) {
          throw error;
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error instanceof TypeError)) {
          if (isMutation) {
            throw new PipedriveOutcomeUnknownError(
              `${error.message}. The ${method} ${endpoint} change may or may not have been applied; read the record to reconcile before any retry.`,
              { endpoint },
            );
          }
          throw new PipedriveConnectionError(error.message, { endpoint });
        }
        throw error;
      }
    }

    throw new PipedriveRateLimitError("Pipedrive rate limit exceeded", { endpoint, status: 429 });
  }

  /** Mutation success bodies must be a JSON object envelope; `success: false` is a failed write. */
  private parseMutationBody(text: string, method: string, endpoint: string): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new PipedriveOutcomeUnknownError(
        `Pipedrive returned a malformed success body for ${method} ${endpoint}; the change may have been applied. Read the record to reconcile before any retry.`,
        { endpoint },
      );
    }
    const envelope = parsed as Record<string, unknown>;
    if (envelope.success === false) {
      const detail = typeof envelope.error === "string" ? envelope.error : text.slice(0, 500);
      throw new PipedriveError(`Pipedrive rejected ${method} ${endpoint}: ${detail}`, { endpoint });
    }
    return envelope;
  }

  /**
   * Like requestJson but returns the raw response body as bytes (no JSON
   * parsing). Used for the file download endpoint. Shares the same retry and
   * typed-error mapping so binary downloads behave consistently.
   */
  private async requestBinary(
    version: "v1" | "v2",
    endpoint: string,
    query: Record<string, string | number> = {},
  ): Promise<{ bytes: Buffer; contentType: string | null }> {
    const url = this.buildUrl(version, endpoint, query);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.status === 429) {
          if (attempt < MAX_ATTEMPTS - 1) {
            await sleep(this.retryDelayMs(response, attempt));
            continue;
          }
          throw new PipedriveRateLimitError("Pipedrive rate limit exceeded", {
            endpoint,
            status: 429,
          });
        }

        if (response.status >= 500) {
          if (attempt < MAX_ATTEMPTS - 1) {
            await sleep(this.retryDelayMs(response, attempt));
            continue;
          }
          const responseBody = await this.readErrorMessage(response);
          throw new PipedriveServerError(
            `Pipedrive server error with status ${response.status} for ${endpoint}: ${responseBody}`,
            {
            endpoint,
            status: response.status,
              responseBody,
            },
          );
        }

        if (!response.ok) {
          const responseBody = await this.readErrorMessage(response);
          // A non-ok response whose final URL left *.pipedrive.com means the
          // file is stored remotely (e.g. Google Drive) and Pipedrive 302'd us
          // to the provider, which needs its own auth — the bytes aren't
          // retrievable via the API token. Surface the provider link instead of
          // a misleading 401/500. (S3-hosted files return 200 and never hit this.)
          let finalHost = "";
          try {
            finalHost = new URL(response.url).host;
          } catch {
            finalHost = "";
          }
          if (finalHost && !finalHost.endsWith("pipedrive.com")) {
            throw new PipedriveError(
              `File is stored remotely (${finalHost}) and cannot be downloaded via the Pipedrive API. Open it directly at: ${response.url}. Response: ${responseBody}`,
              { endpoint, status: response.status, responseBody },
            );
          }
          const message = `Pipedrive request failed for ${endpoint}: ${responseBody}`;
          const options = { endpoint, status: response.status, responseBody };
          if (response.status === 401 || response.status === 403) {
            throw new PipedriveAuthError(message, options);
          }
          if (response.status === 404) {
            throw new PipedriveNotFoundError(message, options);
          }
          if (response.status === 400 || response.status === 409 || response.status === 422) {
            throw new PipedriveValidationError(message, options);
          }
          throw new PipedriveError(message, options);
        }

        const arrayBuffer = await response.arrayBuffer();
        return {
          bytes: Buffer.from(arrayBuffer),
          contentType: response.headers.get("content-type"),
        };
      } catch (error) {
        if (error instanceof PipedriveError) {
          throw error;
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error instanceof TypeError)) {
          throw new PipedriveConnectionError(error.message, { endpoint });
        }
        throw error;
      }
    }

    throw new PipedriveRateLimitError("Pipedrive rate limit exceeded", { endpoint, status: 429 });
  }

  /** Backoff delay honoring Retry-After (seconds or HTTP-date) when present. */
  private retryDelayMs(response: Response, attempt: number): number {
    const header = response.headers.get("retry-after");
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
      }
      const dateMs = Date.parse(header);
      if (Number.isFinite(dateMs)) {
        return Math.max(0, dateMs - Date.now());
      }
    }
    return Math.min(250 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250);
  }

  /**
   * List pipelines (v2 /pipelines). One native cursor page per call; pass the
   * returned next_cursor back as cursor to page through all pipelines.
   */
  async listPipelines(params: ListPipelinesParams): Promise<ListPipelinesResult> {
    const { rows, nextCursor } = await this.fetchListPage("pipelines", params.limit, params.cursor);
    return {
      pipelines: rows.map((row) => this.toPipeline(row)),
      next_cursor: nextCursor,
      count: rows.length,
    };
  }

  /** Fetch a single pipeline by id (v2 /pipelines/{id}). */
  async getPipeline(pipelineId: number): Promise<Pipeline> {
    const data = await this.requestJson("GET", "v2", `pipelines/${pipelineId}`);
    return this.toPipeline(asRecord(data.data));
  }

  /**
   * List stages (v2 /stages) with an optional server-side pipeline_id filter.
   * One native cursor page per call.
   */
  async listStages(params: ListStagesParams): Promise<ListStagesResult> {
    const extra: Record<string, string | number> = {};
    if (params.pipeline_id !== undefined) extra.pipeline_id = params.pipeline_id;
    const { rows, nextCursor } = await this.fetchListPage("stages", params.limit, params.cursor, extra);
    return {
      stages: rows.map((row) => this.toStage(row)),
      next_cursor: nextCursor,
      count: rows.length,
    };
  }

  /** Fetch a single stage by id (v2 /stages/{id}). */
  async getStage(stageId: number): Promise<Stage> {
    const data = await this.requestJson("GET", "v2", `stages/${stageId}`);
    return this.toStage(asRecord(data.data));
  }

  /**
   * List a deal's attached products / line items (v2 /deals/{id}/products) —
   * the source for devis amounts and recurring (MRR/ARR) products. One native
   * cursor page per call.
   */
  async listDealProducts(params: ListDealProductsParams): Promise<ListDealProductsResult> {
    const { rows, nextCursor } = await this.fetchListPage(
      `deals/${params.deal_id}/products`,
      params.limit,
      params.cursor,
    );
    return {
      deal_id: params.deal_id,
      products: rows.map((row) => this.toDealProduct(row)),
      next_cursor: nextCursor,
      count: rows.length,
    };
  }

  /** List a deal's deal-level discounts (v2 /deals/{id}/discounts). */
  async listDealDiscounts(params: ListDealDiscountsParams): Promise<ListDealDiscountsResult> {
    const { rows, nextCursor } = await this.fetchListPage(
      `deals/${params.deal_id}/discounts`,
      params.limit,
      params.cursor,
    );
    return {
      deal_id: params.deal_id,
      discounts: rows.map((row) => this.toDealDiscount(row)),
      next_cursor: nextCursor,
      count: rows.length,
    };
  }

  /**
   * Fetch one native v2 cursor page for a list endpoint, returning the raw rows
   * and the next_cursor from additional_data. Shared by the pipeline/stage/
   * product/discount list ops for consistent cursor pagination.
   */
  private async fetchListPage(
    endpoint: string,
    limit: number | undefined,
    cursor: string | undefined,
    extra: Record<string, string | number> = {},
  ): Promise<{ rows: Record<string, unknown>[]; nextCursor: string | null }> {
    const query: Record<string, string | number> = {
      limit: Math.min(limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
      ...extra,
    };
    if (cursor !== undefined) query.cursor = cursor;

    const data = await this.requestJson("GET", "v2", endpoint, query);
    const rows = Array.isArray(data.data) ? (data.data as Record<string, unknown>[]) : [];
    const additional = data.additional_data as Record<string, unknown> | undefined;
    return { rows, nextCursor: toStringOrNull(additional?.next_cursor) };
  }

  private toPipeline(raw: Record<string, unknown>): Pipeline {
    return {
      id: Number(raw.id),
      name: toStringOrNull(raw.name),
      order_nr: toNumberOrNull(raw.order_nr),
      is_selected: toBooleanOrNull(raw.is_selected),
      is_deal_probability_enabled: toBooleanOrNull(raw.is_deal_probability_enabled),
      active: toBooleanOrNull(raw.is_deleted === undefined ? undefined : !raw.is_deleted),
    };
  }

  private toStage(raw: Record<string, unknown>): Stage {
    return {
      id: Number(raw.id),
      name: toStringOrNull(raw.name),
      pipeline_id: toNumberOrNull(raw.pipeline_id),
      order_nr: toNumberOrNull(raw.order_nr),
      deal_probability: toNumberOrNull(raw.deal_probability),
      is_deal_rot_enabled: toBooleanOrNull(raw.is_deal_rot_enabled),
    };
  }

  private toDealProduct(raw: Record<string, unknown>): DealProduct {
    return {
      id: Number(raw.id),
      product_id: toNumberOrNull(raw.product_id),
      name: toStringOrNull(raw.name),
      quantity: toNumberOrNull(raw.quantity),
      item_price: toNumberOrNull(raw.item_price),
      sum: toNumberOrNull(raw.sum),
      currency: toStringOrNull(raw.currency),
      billing_frequency: toStringOrNull(raw.billing_frequency),
      billing_frequency_cycles: toNumberOrNull(raw.billing_frequency_cycles),
      tax: toNumberOrNull(raw.tax),
      tax_method: toStringOrNull(raw.tax_method),
      discount: toNumberOrNull(raw.discount),
      discount_type: toStringOrNull(raw.discount_type),
      product_variation_id: toNumberOrNull(raw.product_variation_id),
      comments: toStringOrNull(raw.comments),
    };
  }

  private toDealDiscount(raw: Record<string, unknown>): DealDiscount {
    return {
      id: String(raw.id),
      description: toStringOrNull(raw.description),
      amount: toNumberOrNull(raw.amount),
      type: toStringOrNull(raw.type),
    };
  }

  private async readErrorMessage(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text.slice(0, 500);
    } catch {
      return "";
    }
  }
  /**
   * Free-text search over deal titles via the v2 /deals/search endpoint, with
   * optional server-side status/person/org filters. Unlike the legacy port
   * (single page, limit <= 500, no cursor), cursor pagination is wired here:
   * next_cursor resumes from the last item, so the caller pages the full match
   * set with no single-page cap and reliably surfaces every matching deal —
   * e.g. all "Try and Buy" titled deals so none is missed for invoicing.
   */
  async searchDeals(params: SearchDealsParams): Promise<SearchDealsResult> {
    const limit = Math.min(params.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);

    const query: Record<string, string | number> = {
      term: params.term,
      fields: "title",
      limit,
    };
    if (params.exact_match) query.exact_match = "true";
    if (params.status !== undefined) query.status = params.status;
    if (params.person_id !== undefined) query.person_id = params.person_id;
    if (params.org_id !== undefined) query.organization_id = params.org_id;
    if (params.cursor !== undefined) query.cursor = params.cursor;

    const data = await this.requestJson("GET", "v2", "deals/search", query);
    const container = (data.data ?? {}) as Record<string, unknown>;
    const items = Array.isArray(container.items) ? (container.items as Record<string, unknown>[]) : [];
    const additional = data.additional_data as Record<string, unknown> | undefined;

    const deals = items.map((entry) => this.toSearchMatch(entry));
    return {
      deals,
      next_cursor: toStringOrNull(additional?.next_cursor),
      count: deals.length,
    };
  }

  /** Read a deal's notes (author + timestamps) via the v1 /notes endpoint. */
  async listDealNotes(params: ListDealNotesParams): Promise<ListDealNotesResult> {
    return this.listNotes({ deal_id: params.deal_id }, params);
  }

  private async listNotes(
    owner: { deal_id: number } | { lead_id: string },
    params: { limit?: number; cursor?: string },
  ): Promise<ListDealNotesResult> {
    const limit = Math.min(params.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const query: Record<string, string | number> = {
      ...owner,
      limit,
      start: decodeStartCursor(params.cursor),
      sort: "add_time DESC",
    };

    const data = await this.requestJson("GET", "v1", "notes", query);
    const rows = Array.isArray(data.data) ? (data.data as RawNote[]) : [];
    const notes = rows.map((raw) => toNote(raw));
    return {
      notes,
      next_cursor: nextStartCursor(data.additional_data),
      count: notes.length,
    };
  }

  /** Read a deal's activity history via the v1 /activities endpoint. */
  async listDealActivities(params: ListDealActivitiesParams): Promise<ListDealActivitiesResult> {
    const limit = Math.min(params.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const query: Record<string, string | number> = {
      deal_id: params.deal_id,
      limit,
      start: decodeStartCursor(params.cursor),
    };
    if (params.done !== undefined) query.done = params.done ? 1 : 0;

    const data = await this.requestJson("GET", "v1", "activities", query);
    const rows = Array.isArray(data.data) ? (data.data as RawActivity[]) : [];
    const activities = rows.map((raw) => toActivity(raw));
    return {
      activities,
      next_cursor: nextStartCursor(data.additional_data),
      count: activities.length,
    };
  }

  /** List leads for the Leads inbox (v1 /leads) with a lean projection. */
  async listLeads(params: ListLeadsParams): Promise<ListLeadsResult> {
    const limit = Math.min(params.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const query: Record<string, string | number> = {
      limit,
      start: decodeStartCursor(params.cursor),
      archived_status: params.archived_status ?? "not_archived",
    };
    if (params.owner_id !== undefined) query.owner_id = params.owner_id;
    if (params.person_id !== undefined) query.person_id = params.person_id;
    if (params.organization_id !== undefined) query.organization_id = params.organization_id;
    if (params.filter_id !== undefined) query.filter_id = params.filter_id;
    if (params.sort !== undefined) query.sort = params.sort;

    const data = await this.requestJson("GET", "v1", "leads", query);
    const rows = Array.isArray(data.data) ? (data.data as RawLead[]) : [];
    const leads = rows.map((raw) => this.toLeadSummary(raw));
    return {
      leads,
      next_cursor: nextStartCursor(data.additional_data),
      count: leads.length,
    };
  }

  /**
   * Full single-lead read (v1 /leads/{id}). Leads share the deal
   * custom-field schema, so hash-key custom fields on the lead payload
   * resolve through the same field registry + normalizer as getDeal. `full`
   * mode (default) returns normalized custom fields + metadata; `lean`
   * strips them.
   */
  async getLead(params: GetLeadParams): Promise<LeadDetail> {
    const mode = params.output_type ?? "full";
    const data = await this.requestJson("GET", "v1", `leads/${params.id}`);
    const raw = (data.data ?? {}) as RawLead;
    const detail: LeadDetail = this.toLeadSummary({ ...raw, id: raw.id ?? params.id });

    if (mode === "lean") {
      return detail;
    }

    return this.withNormalizedFields(
      detail,
      flattenCustomFields(raw, STANDARD_LEAD_KEYS),
    );
  }

  private toLeadSummary(raw: RawLead): LeadSummary {
    const id = typeof raw.id === "string" ? raw.id : String(raw.id ?? "");
    return {
      id,
      title: typeof raw.title === "string" ? raw.title : "",
      owner_id: toNumberOrNull(raw.owner_id),
      creator_id: toNumberOrNull(raw.creator_id),
      label_ids: Array.isArray(raw.label_ids)
        ? raw.label_ids.filter((v): v is string => typeof v === "string")
        : [],
      person_id: toNumberOrNull(raw.person_id),
      organization_id: toNumberOrNull(raw.organization_id),
      source_name: toStringOrNull(raw.source_name),
      origin: toStringOrNull(raw.origin),
      origin_id: toStringOrNull(raw.origin_id),
      channel: toNumberOrNull(raw.channel),
      channel_id: toStringLikeOrNull(raw.channel_id),
      is_archived: toBooleanOrNull(raw.is_archived),
      was_seen: toBooleanOrNull(raw.was_seen),
      value: toLeadValue(raw.value),
      expected_close_date: toStringOrNull(raw.expected_close_date),
      next_activity_id: toNumberOrNull(raw.next_activity_id),
      add_time: toStringOrNull(raw.add_time),
      update_time: toStringOrNull(raw.update_time),
      visible_to: toStringLikeOrNull(raw.visible_to),
      cc_email: toStringOrNull(raw.cc_email),
      lead_url: `https://${this.domain}.pipedrive.com/leads/inbox/${id}`,
    };
  }

  /**
   * Free-text search over lead title/notes/custom fields (v1 /leads/search),
   * with optional server-side person/org filters.
   */
  async searchLeads(params: SearchLeadsParams): Promise<SearchLeadsResult> {
    const limit = Math.min(params.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const query: Record<string, string | number> = {
      term: params.term,
      limit,
      start: decodeStartCursor(params.cursor),
    };
    if (params.fields !== undefined) query.fields = params.fields;
    if (params.exact_match) query.exact_match = "true";
    if (params.person_id !== undefined) query.person_id = params.person_id;
    if (params.organization_id !== undefined) query.organization_id = params.organization_id;
    if (params.include_fields !== undefined) query.include_fields = params.include_fields;

    const data = await this.requestJson("GET", "v1", "leads/search", query);
    const container = (data.data ?? {}) as Record<string, unknown>;
    const items = Array.isArray(container.items) ? (container.items as Record<string, unknown>[]) : [];
    const leads = items.map((entry) => this.toLeadSearchMatch(entry));
    return {
      leads,
      next_cursor: nextStartCursor(data.additional_data),
      count: leads.length,
    };
  }

  private toLeadSearchMatch(entry: Record<string, unknown>): LeadSearchMatch {
    const item = (entry.item ?? entry) as Record<string, unknown>;
    const value = toLeadValue(item.value);
    return {
      id: typeof item.id === "string" ? item.id : String(item.id ?? ""),
      title: typeof item.title === "string" ? item.title : "",
      owner: toRef(item.owner),
      person: toRef(item.person),
      organization: toRef(item.organization),
      is_archived: toBooleanOrNull(item.is_archived),
      value,
      currency: value?.currency ?? toStringOrNull(item.currency),
      expected_close_date: toStringOrNull(item.expected_close_date),
      result_score: toNumberOrNull(entry.result_score),
    };
  }

  /** List lead labels (v1 /leadLabels). No pagination. */
  async listLeadLabels(): Promise<ListLeadLabelsResult> {
    const data = await this.requestJson("GET", "v1", "leadLabels");
    const rows = Array.isArray(data.data) ? (data.data as Record<string, unknown>[]) : [];
    const labels = rows.map((raw) => ({
      id: String(raw.id),
      name: typeof raw.name === "string" ? raw.name : "",
      color: toStringOrNull(raw.color),
      add_time: toStringOrNull(raw.add_time),
      update_time: toStringOrNull(raw.update_time),
    }));
    return { labels, count: labels.length };
  }

  /** Resolve custom-field names (case-insensitive) or hash keys to hash keys; unknown entries throw. */
  private async resolveDealFieldKeys(fields: string[]): Promise<string[]> {
    const byKey = (await this.registry.get()).by_key;
    const byName = new Map(Object.entries(byKey).map(([key, meta]) => [meta.name.toLowerCase(), key]));
    const unknown: string[] = [];
    const keys = fields.map((field) => {
      const key = field in byKey ? field : byName.get(field.toLowerCase());
      if (!key) unknown.push(field);
      return key ?? "";
    });
    if (unknown.length) {
      throw new PipedriveValidationError(
        `Unknown deal custom field(s): ${unknown.join(", ")}. Use pipedrive_list_deal_fields to find names.`,
      );
    }
    return [...new Set(keys)];
  }

  /** Requested custom fields of one raw deal, keyed by field name with human-readable values. */
  private async pickCustomFields(raw: RawDeal, keys: string[]): Promise<Record<string, unknown>> {
    const flat = flattenCustomFields(raw);
    const picked = Object.fromEntries(keys.map((key) => [key, flat[key] ?? null]));
    return normalizeCustomFields(picked, await this.registry.get()).normalized_extra_fields;
  }

  /** List all company users (v1 /users), active and deactivated. No pagination. */
  async listUsers(): Promise<ListUsersResult> {
    const data = await this.requestJson("GET", "v1", "users");
    const rows = Array.isArray(data.data) ? (data.data as Record<string, unknown>[]) : [];
    const users = rows
      .filter((raw) => typeof raw.id === "number")
      .map((raw) => ({
        id: raw.id as number,
        name: typeof raw.name === "string" ? raw.name : "",
        email: toStringOrNull(raw.email),
        active: raw.active_flag === true,
      }));
    return { users, count: users.length };
  }

  /**
   * user id → name map for owner_name, cached per client. A failed lookup
   * leaves owner_name null instead of failing the deal read, and is retried
   * on the next call.
   */
  protected async loadOwnerNames(): Promise<Map<number, string>> {
    if (this.ownerNames) return this.ownerNames;
    try {
      const { users } = await this.listUsers();
      this.ownerNames = new Map(users.map((u) => [u.id, u.name]));
      return this.ownerNames;
    } catch {
      return new Map();
    }
  }

  /** List lead sources (v1 /leadSources). No pagination. */
  async listLeadSources(): Promise<ListLeadSourcesResult> {
    const data = await this.requestJson("GET", "v1", "leadSources");
    const rows = Array.isArray(data.data) ? (data.data as Record<string, unknown>[]) : [];
    const sources = rows.map((raw) => ({ name: typeof raw.name === "string" ? raw.name : "" }));
    return { sources, count: sources.length };
  }

  /** Read a lead's notes (author + timestamps) via the v1 /notes endpoint. */
  async listLeadNotes(params: ListLeadNotesParams): Promise<ListDealNotesResult> {
    return this.listNotes({ lead_id: params.lead_id }, params);
  }

  /** Read a lead's activity history via the v2 /activities endpoint. */
  async listLeadActivities(params: ListLeadActivitiesParams): Promise<ListDealActivitiesResult> {
    const limit = Math.min(params.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const query: Record<string, string | number> = {
      lead_id: params.lead_id,
      limit,
    };
    if (params.cursor !== undefined) query.cursor = params.cursor;
    if (params.done !== undefined) query.done = params.done ? "true" : "false";

    const data = await this.requestJson("GET", "v2", "activities", query);
    const rows = Array.isArray(data.data) ? (data.data as RawActivityV2[]) : [];
    const activities = rows.map((raw) => toActivityV2(raw));
    const additional = data.additional_data as Record<string, unknown> | undefined;
    return {
      activities,
      next_cursor: toStringOrNull(additional?.next_cursor),
      count: activities.length,
    };
  }

  private toSearchMatch(entry: Record<string, unknown>): DealSearchMatch {
    const item = (entry.item ?? entry) as Record<string, unknown>;
    const stage = item.stage as Record<string, unknown> | undefined;
    const pipeline = item.pipeline as Record<string, unknown> | undefined;
    const person = item.person as Record<string, unknown> | undefined;
    const org = item.organization as Record<string, unknown> | undefined;
    const id = toNumberOrNull(item.id) ?? 0;
    return {
      id,
      title: typeof item.title === "string" ? item.title : "",
      status: toStringOrNull(item.status),
      value: toNumberOrNull(item.value),
      currency: toStringOrNull(item.currency),
      stage_id: toNumberOrNull(stage?.id),
      pipeline_id: toNumberOrNull(pipeline?.id),
      person_id: toNumberOrNull(person?.id),
      org_id: toNumberOrNull(org?.id),
      result_score: toNumberOrNull(entry.result_score),
      deal_url: `https://${this.domain}.pipedrive.com/deal/${id}`,
    };
  }

}

/** Deal-standard keys that are never treated as custom fields. */
const STANDARD_DEAL_KEYS = new Set([
  "id",
  "title",
  "value",
  "currency",
  "status",
  "stage_id",
  "pipeline_id",
  "person_id",
  "org_id",
  "user_id",
  "owner_id",
  "creator_user_id",
  "expected_close_date",
  "add_time",
  "update_time",
  "won_time",
  "custom_fields",
]);

/**
 * Flatten a raw deal's custom fields into a single hash-key map. Pipedrive v2
 * nests custom fields under `custom_fields`; v1 spreads hash keys at the top
 * level. This merges both, dropping the nested container and standard keys.
 */
export function flattenCustomFields(
  raw: RawDeal | RawLead,
  standardKeys: ReadonlySet<string> = STANDARD_DEAL_KEYS,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // v1-style: hash keys spread at the top level.
  for (const [key, value] of Object.entries(raw)) {
    if (!standardKeys.has(key)) out[key] = value;
  }

  // v2-style: nested `custom_fields` container.
  const nested = raw.custom_fields;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
      out[key] = value;
    }
  }

  return out;
}

/** Lead-standard keys that are never treated as custom fields. */
const STANDARD_LEAD_KEYS = new Set([
  "id",
  "title",
  "owner_id",
  "creator_id",
  "label_ids",
  "person_id",
  "organization_id",
  "source_name",
  "origin",
  "origin_id",
  "channel",
  "channel_id",
  "is_archived",
  "was_seen",
  "value",
  "expected_close_date",
  "next_activity_id",
  "add_time",
  "update_time",
  "visible_to",
  "cc_email",
  "custom_fields",
]);

/** Flatten a raw lead's custom fields; leads share the deal custom-field schema. */
export function flattenLeadCustomFields(raw: RawLead): Record<string, unknown> {
  return flattenCustomFields(raw, STANDARD_LEAD_KEYS);
}

/**
 * Inclusive expected-close-date range check. Deals without an expected close
 * date are excluded when any bound is set (they cannot satisfy a date range).
 */
export function inCloseDateRange(
  value: unknown,
  from: string | null,
  to: string | null,
): boolean {
  const date = toStringOrNull(value);
  if (date === null) return false;
  if (from !== null && date < from) return false;
  if (to !== null && date > to) return false;
  return true;
}

/**
 * Inclusive won-date range check. won_time is a full timestamp (e.g.
 * "2026-06-15 10:23:00"); only its date portion is compared so a `to` bound on
 * that same calendar day still matches. Deals not yet won (won_time null) are
 * excluded when any bound is set.
 */
export function inWonDateRange(
  value: unknown,
  from: string | null,
  to: string | null,
): boolean {
  const ts = toStringOrNull(value);
  if (ts === null) return false;
  const date = ts.slice(0, 10);
  if (from !== null && date < from) return false;
  if (to !== null && date > to) return false;
  return true;
}

/** Normalize Pipedrive's structured address into the lean Address projection, or null when absent. */
export function parseAddress(value: unknown): Address | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as RawAddress;
  const address: Address = {
    formatted_address: toStringOrNull(raw.formatted_address ?? raw.value),
    street_number: toStringOrNull(raw.street_number),
    route: toStringOrNull(raw.route),
    locality: toStringOrNull(raw.locality),
    sublocality: toStringOrNull(raw.sublocality),
    admin_area_level_1: toStringOrNull(raw.admin_area_level_1),
    admin_area_level_2: toStringOrNull(raw.admin_area_level_2),
    postal_code: toStringOrNull(raw.postal_code),
    country: toStringOrNull(raw.country),
  };
  // An address object with no usable parts is equivalent to no address.
  const hasAny = Object.values(address).some((part) => part !== null);
  return hasAny ? address : null;
}

/** Extract labelled email/phone entries, dropping entries without a value. */
export function parseContactDetails(value: unknown): ContactDetail[] {
  if (!Array.isArray(value)) return [];
  const details: ContactDetail[] = [];
  for (const entry of value as RawContactDetail[]) {
    const contactValue = toStringOrNull(entry?.value);
    if (contactValue === null) continue;
    details.push({
      label: toStringOrNull(entry?.label),
      value: contactValue,
      primary: entry?.primary === true,
    });
  }
  return details;
}

/** The primary contact value, falling back to the first entry, or null when empty. */
export function primaryValue(details: ContactDetail[]): string | null {
  if (details.length === 0) return null;
  const primary = details.find((detail) => detail.primary);
  return (primary ?? details[0]).value;
}

function toNote(raw: RawNote): Note {
  return {
    id: raw.id,
    deal_id: toNumberOrNull(raw.deal_id),
    lead_id: toStringOrNull(raw.lead_id),
    content: toStringOrNull(raw.content),
    user_id: toNumberOrNull(raw.user_id),
    user_name: toStringOrNull(raw.user?.name),
    person_id: toNumberOrNull(raw.person_id),
    org_id: toNumberOrNull(raw.org_id),
    add_time: toStringOrNull(raw.add_time),
    update_time: toStringOrNull(raw.update_time),
  };
}

function toActivity(raw: RawActivity): Activity {
  return toActivityProjection(raw, raw.id, raw.user_id);
}

/**
 * Maps a v2 /activities payload (owner_id in place of v1's user_id) onto the
 * same lean Activity projection as toActivity.
 */
function toActivityV2(raw: RawActivityV2): Activity {
  return toActivityProjection(raw, toNumberOrNull(raw.id) ?? 0, raw.owner_id);
}

function toActivityProjection(
  raw: RawActivity | RawActivityV2,
  id: number,
  userId: unknown,
): Activity {
  return {
    id,
    deal_id: toNumberOrNull(raw.deal_id),
    type: toStringOrNull(raw.type),
    subject: toStringOrNull(raw.subject),
    note: toStringOrNull(raw.note),
    done: toBooleanOrNull(raw.done),
    due_date: toStringOrNull(raw.due_date),
    due_time: toStringOrNull(raw.due_time),
    marked_as_done_time: toStringOrNull(raw.marked_as_done_time),
    user_id: toNumberOrNull(userId),
    add_time: toStringOrNull(raw.add_time),
    update_time: toStringOrNull(raw.update_time),
  };
}

/**
 * The v1 /notes and /activities endpoints paginate with a numeric `start`
 * offset rather than an opaque cursor. We expose the same opaque-cursor
 * interface as the other tools by encoding `start` as the cursor string.
 */
function decodeStartCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number(cursor);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nextStartCursor(additionalData: unknown): string | null {
  const additional = additionalData as Record<string, unknown> | undefined;
  const pagination = additional?.pagination as Record<string, unknown> | undefined;
  if (pagination?.more_items_in_collection !== true) return null;
  const nextStart = toNumberOrNull(pagination.next_start);
  return nextStart === null ? null : String(nextStart);
}
