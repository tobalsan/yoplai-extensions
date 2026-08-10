import { z } from "zod";

const NullableString = z.string().nullable().optional();
const NullableBoolean = z.boolean().nullable().optional();

/**
 * Pennylane int64 ids can exceed JavaScript's safe integer range, so we accept
 * either a JSON number or string and normalize to a string to avoid precision
 * loss.
 */
const Int64Id = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === "number" ? String(value) : value));

/**
 * Money is always a decimal string in API v2 (e.g. "230.32"); never a float or
 * a cents integer. Accept numbers defensively and coerce to string so callers
 * never receive a float.
 */
const MoneyString = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === "number" ? String(value) : value))
  .nullable()
  .optional();

/** Dates are ISO calendar dates: YYYY-MM-DD. */
const DateString = NullableString;

export const InvoiceLineItemSchema = z
  .object({
    id: Int64Id.nullable().optional(),
    label: NullableString,
    description: NullableString,
    quantity: MoneyString,
    unitPrice: MoneyString,
    unitPriceTaxIncluded: MoneyString,
    currencyAmount: MoneyString,
    currencyAmountBeforeTax: MoneyString,
    vatRate: NullableString,
    productId: Int64Id.nullable().optional(),
  })
  .passthrough();
export type InvoiceLineItem = z.infer<typeof InvoiceLineItemSchema>;

/**
 * Customer invoice as returned by API v2. Additional fields are preserved via
 * `.passthrough()` so downstream slices can read them without a schema change.
 */
export const CustomerInvoiceSchema = z
  .object({
    id: Int64Id,
    invoiceNumber: NullableString,
    externalReference: NullableString,
    date: DateString,
    deadline: DateString,
    draft: NullableBoolean,
    status: NullableString,
    currency: NullableString,
    label: NullableString,
    customerId: Int64Id.nullable().optional(),
    amount: MoneyString,
    currencyAmount: MoneyString,
    currencyTax: MoneyString,
    currencyAmountBeforeTax: MoneyString,
    remainingAmountWithTax: MoneyString,
    paid: NullableBoolean,
    lineItems: z.array(InvoiceLineItemSchema).nullable().optional(),
    createdAt: NullableString,
    updatedAt: NullableString,
  })
  .passthrough();
export type CustomerInvoice = z.infer<typeof CustomerInvoiceSchema>;

/**
 * Params for `list_invoices`. Cursor pagination is handled transparently by the
 * client, so `cursor` is optional; callers who omit it get the full list walked
 * for them. `limit` is the page size (default 20, max 100).
 */
export const ListInvoicesParamsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});
export type ListInvoicesParams = z.infer<typeof ListInvoicesParamsSchema>;

/** ISO calendar date, `YYYY-MM-DD`, as used by the Pennylane date filters. */
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

/**
 * Params for `search_invoices`. Every filter below is translated into a
 * Pennylane filter clause by `FilterBuilder` and AND-combined into one `filter`
 * query param. All are optional; omitting all of them lists every invoice.
 *
 * - `customerId` → `customer_id eq` (invoices are filterable by customer id)
 * - `externalReference` → `external_reference eq` (our Pipedrive deal-id hook;
 *   invoices support only `eq` on this field)
 * - `status` → `status eq` (single) or `status in` (list). Note: `status`
 *   filtering is documented in Pennylane's prose guides but is unconfirmed in
 *   the OpenAPI schema (§2.1); prefer `draft eq` when you only need drafts vs.
 *   finalized. Kept here because the tool contract filters by status.
 * - `dateFrom` / `dateTo` → `date gteq` / `date lteq` (inclusive range)
 */
export const SearchInvoicesParamsSchema = z
  .object({
    customerId: z.union([z.string(), z.number()]).optional(),
    externalReference: z.string().optional(),
    status: z.union([z.string(), z.array(z.string()).nonempty()]).optional(),
    dateFrom: IsoDate.optional(),
    dateTo: IsoDate.optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional().default(20),
  })
  .strict();
export type SearchInvoicesParams = z.infer<typeof SearchInvoicesParamsSchema>;

/** Params for `get_invoice`: a single customer invoice by its int64 id. */
export const GetInvoiceParamsSchema = z
  .object({ id: z.union([z.string(), z.number()]) })
  .strict();
export type GetInvoiceParams = z.infer<typeof GetInvoiceParamsSchema>;

/**
 * Pennylane `vat_rate` is a fixed enum, not a listable endpoint. The full set is
 * ~180 country codes in the form `{ISO2}_{rate×10}` plus special codes. We ship
 * the common French rates + the cross-border/special codes Sally needs so the
 * agent can discover valid codes without a network call. Ref: §4.3.
 *
 * `.passthrough()` is not applicable to an enum, so we keep this permissive: the
 * schema validates the known codes, and `VatRateReferenceSchema` documents them
 * with human-readable percentages for `list_vat_rates`.
 */
export const VAT_RATES = [
  { code: "FR_200", label: "France — standard rate", percentage: 20 },
  { code: "FR_100", label: "France — intermediate rate", percentage: 10 },
  { code: "FR_55", label: "France — reduced rate", percentage: 5.5 },
  { code: "FR_21", label: "France — super-reduced rate", percentage: 2.1 },
  { code: "exempt", label: "Exempt / 0%", percentage: 0 },
  { code: "any", label: "Not applicable (shows N/A in UI)", percentage: null },
] as const;

/**
 * A single VAT rate reference entry, as returned by `list_vat_rates`. `percentage`
 * is `null` for the `any` code ("N/A"), otherwise the numeric rate (e.g. 20).
 */
export const VatRateReferenceSchema = z.object({
  code: z.string(),
  label: z.string(),
  percentage: z.number().nullable(),
});
export type VatRateReference = z.infer<typeof VatRateReferenceSchema>;

/**
 * Quote / invoice line item. Pennylane returns lines with a `vat_rate` enum code
 * (e.g. `FR_200`), a decimal-string unit price excluding tax, and optional
 * product link. Shared shape between quotes and invoices (§2.2, §3.2).
 */
export const LineItemSchema = z
  .object({
    id: Int64Id.nullable().optional(),
    label: NullableString,
    description: NullableString,
    unit: NullableString,
    quantity: MoneyString,
    rawCurrencyUnitPrice: MoneyString,
    vatRate: NullableString,
    amount: MoneyString,
    currencyAmount: MoneyString,
    tax: MoneyString,
    currencyTax: MoneyString,
    productId: Int64Id.nullable().optional(),
    sectionRank: z.number().nullable().optional(),
  })
  .passthrough();
export type LineItem = z.infer<typeof LineItemSchema>;

/**
 * Quote (devis) as returned by API v2. `status` is one of
 * `pending | accepted | denied | invoiced | expired` (no "draft" state — §3.0).
 * Additional fields preserved via `.passthrough()`.
 */
export const QuoteSchema = z
  .object({
    id: Int64Id,
    quoteNumber: NullableString,
    externalReference: NullableString,
    status: NullableString,
    label: NullableString,
    currency: NullableString,
    date: DateString,
    deadline: DateString,
    customerId: Int64Id.nullable().optional(),
    amount: MoneyString,
    currencyAmount: MoneyString,
    currencyAmountBeforeTax: MoneyString,
    tax: MoneyString,
    currencyTax: MoneyString,
    lineItems: z.array(LineItemSchema).nullable().optional(),
    createdAt: NullableString,
    updatedAt: NullableString,
  })
  .passthrough();
export type Quote = z.infer<typeof QuoteSchema>;

/** Postal address as used on customer billing/delivery. */
export const AddressSchema = z
  .object({
    address: NullableString,
    postalCode: NullableString,
    city: NullableString,
    countryAlpha2: NullableString,
  })
  .passthrough();
export type Address = z.infer<typeof AddressSchema>;

/**
 * Customer as returned by the unified `GET /customers` endpoint. Covers both
 * `company` and `individual` types (§4.1); individual customers carry
 * `firstName`/`lastName` instead of `name`. Extra fields preserved.
 */
export const CustomerSchema = z
  .object({
    id: Int64Id,
    customerType: NullableString,
    name: NullableString,
    firstName: NullableString,
    lastName: NullableString,
    externalReference: NullableString,
    vatNumber: NullableString,
    regNo: NullableString,
    emails: z.array(z.string()).nullable().optional(),
    phone: NullableString,
    reference: NullableString,
    notes: NullableString,
    paymentConditions: NullableString,
    billingLanguage: NullableString,
    billingAddress: AddressSchema.nullable().optional(),
    deliveryAddress: AddressSchema.nullable().optional(),
    createdAt: NullableString,
    updatedAt: NullableString,
  })
  .passthrough();
export type Customer = z.infer<typeof CustomerSchema>;

const CreateCustomerAddressSchema = z
  .object({
    address: z.string(),
    postalCode: z.string(),
    city: z.string(),
    countryAlpha2: z.string(),
  })
  .strict();

const CustomerSharedFieldsSchema = {
  phone: z.string().optional(),
  emails: z.array(z.string()).optional(),
  externalReference: z.string().optional(),
  paymentConditions: z
    .enum([
      "upon_receipt",
      "custom",
      "7_days",
      "15_days",
      "30_days",
      "30_days_end_of_month",
      "45_days",
      "45_days_end_of_month",
      "60_days",
    ])
    .optional(),
  billingLanguage: z.enum(["fr_FR", "en_GB", "de_DE"]).optional(),
  billingIban: z.string().optional(),
  recipient: z.string().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
  billingAddress: CreateCustomerAddressSchema,
  deliveryAddress: CreateCustomerAddressSchema.optional(),
  ledgerAccount: z.object({ number: z.string() }).strict().optional(),
};

/** Params for `create_customer`; select the Pennylane endpoint by customer type. */
export const CreateCustomerParamsSchema = z.discriminatedUnion("customerType", [
  z
    .object({
      customerType: z.literal("company"),
      name: z.string(),
      vatNumber: z.string().optional(),
      regNo: z.string().optional(),
      ...CustomerSharedFieldsSchema,
    })
    .strict(),
  z
    .object({
      customerType: z.literal("individual"),
      firstName: z.string(),
      lastName: z.string(),
      ...CustomerSharedFieldsSchema,
    })
    .strict(),
]);
export type CreateCustomerParams = z.infer<typeof CreateCustomerParamsSchema>;

/**
 * Product as returned by API v2 (§4.2). Money fields are decimal strings and
 * `vatRate` is an enum code. Extra fields preserved.
 */
export const ProductSchema = z
  .object({
    id: Int64Id,
    label: NullableString,
    description: NullableString,
    externalReference: NullableString,
    reference: NullableString,
    priceBeforeTax: MoneyString,
    price: MoneyString,
    vatRate: NullableString,
    unit: NullableString,
    currency: NullableString,
    createdAt: NullableString,
    updatedAt: NullableString,
    archivedAt: NullableString,
  })
  .passthrough();
export type Product = z.infer<typeof ProductSchema>;

/**
 * Params for `list_quotes` / `list_customers` / `list_products`. Cursor is walked
 * transparently when omitted; provide one to fetch a single page.
 */
export const ListParamsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});
export type ListParams = z.infer<typeof ListParamsSchema>;

/**
 * Params for `search_quotes`. Quotes are filterable server-side only on
 * `customer_id` and `status` (§3.1); `external_reference` is NOT server-side
 * filterable, so it is matched client-side on the returned objects (§4.5).
 */
export const SearchQuotesParamsSchema = z
  .object({
    customerId: z.union([z.string(), z.number()]).optional(),
    externalReference: z.string().optional(),
    status: z.union([z.string(), z.array(z.string()).nonempty()]).optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional().default(20),
  })
  .strict();
export type SearchQuotesParams = z.infer<typeof SearchQuotesParamsSchema>;

/** Params for `get_quote`: a single quote by its int64 id. */
export const GetQuoteParamsSchema = z
  .object({ id: z.union([z.string(), z.number()]) })
  .strict();
export type GetQuoteParams = z.infer<typeof GetQuoteParamsSchema>;

/**
 * Params for `search_customers`. Customers ARE server-side filterable on
 * `external_reference` (`eq`, `start_with`), `name` (`start_with`, `eq`), and
 * `customer_type` (§4.1).
 */
export const SearchCustomersParamsSchema = z
  .object({
    externalReference: z.string().optional(),
    name: z.string().optional(),
    customerType: z.enum(["company", "individual"]).optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional().default(20),
  })
  .strict();
export type SearchCustomersParams = z.infer<typeof SearchCustomersParamsSchema>;

/**
 * Params for `get_customer`: fetch by internal `id` OR by `externalReference`
 * (the Pipedrive org/person id hook). Exactly one must be provided.
 */
export const GetCustomerParamsSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    externalReference: z.string().optional(),
  })
  .strict();
export type GetCustomerParams = z.infer<typeof GetCustomerParamsSchema>;

/**
 * Params for `search_products`. Products are server-side filterable on
 * `external_reference`, `label`, and `reference` (§4.2).
 */
export const SearchProductsParamsSchema = z
  .object({
    externalReference: z.string().optional(),
    label: z.string().optional(),
    reference: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional().default(20),
  })
  .strict();
export type SearchProductsParams = z.infer<typeof SearchProductsParamsSchema>;

/** Params for `get_product`: a single product by its int64 id. */
export const GetProductParamsSchema = z
  .object({ id: z.union([z.string(), z.number()]) })
  .strict();
export type GetProductParams = z.infer<typeof GetProductParamsSchema>;

/** Params for `list_vat_rates`: no inputs — returns the static VAT enum reference. */
export const ListVatRatesParamsSchema = z.object({}).strict();
export type ListVatRatesParams = z.infer<typeof ListVatRatesParamsSchema>;

/** An int64 id accepted as string or number for write payloads. */
const IdInput = z.union([z.string(), z.number()]);
const NumericInt64IdInput = z.number().int().safe();
const NumericString = z.string().regex(/^-?\d+(?:\.\d+)?$/, "value must be a numeric string");

export const DiscountInputSchema = z
  .object({ type: z.enum(["relative", "absolute"]), value: NumericString })
  .strict();

/** Loose invoice/update line input; Pennylane enforces its write `oneOf`. */
export const InvoiceLineInputSchema = z
  .object({
    productId: IdInput.optional(),
    label: z.string().optional(),
    description: z.string().optional(),
    quantity: z.union([z.string(), z.number()]),
    rawCurrencyUnitPrice: z.union([z.string(), z.number()]).optional(),
    unit: z.string().optional(),
    vatRate: z.string().optional(),
    ledgerAccountId: IdInput.optional(),
    sectionRank: z.number().optional(),
    discount: DiscountInputSchema.optional(),
  })
  .strict();

const QuoteLineSharedFields = {
  description: z.string().nullable().optional(),
  sectionRank: z.number().int().optional(),
  ledgerAccountId: NumericInt64IdInput.optional(),
  discount: DiscountInputSchema.optional(),
};

/** Strict quote-create line shapes from Pennylane's `oneOf`. */
const QuoteLineInputSchema = z.union([
  z.object({
    productId: NumericInt64IdInput,
    quantity: z.number(),
    label: z.string().optional(),
    rawCurrencyUnitPrice: z.string().optional(),
    unit: z.string().optional(),
    vatRate: z.string().optional(),
    ...QuoteLineSharedFields,
  }).strict(),
  z.object({
    label: z.string(),
    quantity: z.number(),
    rawCurrencyUnitPrice: z.string(),
    unit: z.string(),
    vatRate: z.string(),
    ...QuoteLineSharedFields,
  }).strict(),
]);
export type InvoiceLineInput = z.infer<typeof InvoiceLineInputSchema>;

/**
 * Params for `create_invoice_draft` (§2.3). Always creates with `draft: true`
 * (never exposed to the caller — this tool cannot finalize). `externalReference`
 * is the Pipedrive deal-id hook used for client-side dedup/correlation.
 */
export const CreateInvoiceDraftParamsSchema = z
  .object({
    customerId: IdInput,
    date: IsoDate,
    deadline: IsoDate,
    invoiceLines: z.array(InvoiceLineInputSchema).min(1),
    label: z.string().max(2000).optional(),
    externalReference: z.string().optional(),
    currency: z.string().optional(),
    language: z.string().optional(),
    customerInvoiceTemplateId: IdInput.optional(),
    pdfInvoiceSubject: z.string().optional(),
    pdfInvoiceFreeText: z.string().optional(),
    pdfDescription: z.string().optional(),
    specialMention: z.string().max(20000).optional(),
  })
  .strict();
export type CreateInvoiceDraftParams = z.infer<typeof CreateInvoiceDraftParamsSchema>;

/**
 * Params for `update_invoice_draft` (§2.4). `id` selects the target, which the
 * client re-reads and routes through `DraftGuard` before any write — a finalized
 * invoice is refused. `PUT` is a full replace, so all editable fields are
 * accepted; `draft` stays `true` (this tool cannot finalize).
 */
export const UpdateInvoiceDraftParamsSchema = z
  .object({
    id: IdInput,
    customerId: IdInput.optional(),
    date: IsoDate.optional(),
    deadline: IsoDate.optional(),
    invoiceLines: z.array(InvoiceLineInputSchema).min(1).optional(),
    label: z.string().max(2000).optional(),
    externalReference: z.string().optional(),
    currency: z.string().optional(),
    language: z.string().optional(),
    customerInvoiceTemplateId: IdInput.optional(),
    pdfInvoiceSubject: z.string().optional(),
    pdfInvoiceFreeText: z.string().optional(),
    pdfDescription: z.string().optional(),
    specialMention: z.string().max(20000).optional(),
  })
  .strict();
export type UpdateInvoiceDraftParams = z.infer<typeof UpdateInvoiceDraftParamsSchema>;

/**
 * Params for `create_quote` (§3.3). Pennylane quotes have **no** draft/status
 * field on create — a created quote is always `pending`, which the write path
 * treats as the draft-equivalent. `externalReference` is the Pipedrive deal-id
 * hook for correlation/dedup (returned on the quote but not server-side
 * filterable, so callers match it client-side via `search_quotes`). Line items
 * share the same product-based / free-form shapes as invoice drafts (§2.3).
 * Unlike invoices, quotes have **no top-level `label`**: `POST /quotes` rejects
 * it with a 500 `NotExistPropertyDefinition` ("These additional properties are
 * not supported: label."). The quote's response `label` field is read-only,
 * mirroring the quote number — it is not settable here. (Line-level `label` on
 * `invoiceLines` is unaffected.)
 */
export const CreateQuoteParamsSchema = z
  .object({
    customerId: NumericInt64IdInput,
    date: IsoDate,
    deadline: IsoDate,
    invoiceLines: z.array(QuoteLineInputSchema).min(1),
    discount: DiscountInputSchema.optional(),
    externalReference: z.string().optional(),
    currency: z.string().optional(),
    language: z.string().optional(),
    quoteTemplateId: NumericInt64IdInput.optional(),
    pdfInvoiceSubject: z.string().optional(),
    pdfInvoiceFreeText: z.string().optional(),
    pdfDescription: z.string().optional(),
    specialMention: z.string().max(20000).optional(),
  })
  .strict();
export type CreateQuoteParams = z.infer<typeof CreateQuoteParamsSchema>;

/**
 * `invoice_lines` diff for a quote update (§3.4): `PUT /quotes/{id}` takes a diff
 * object `{ create, update, delete }`, NOT a flat array. `create` adds new
 * free-form/product lines, `update` edits existing lines (each needs its `id`),
 * and `delete` removes lines by id. All three are optional; supply only what
 * changes.
 */
export const QuoteLinesDiffSchema = z
  .object({
    create: z.array(InvoiceLineInputSchema).optional(),
    update: z.array(InvoiceLineInputSchema.extend({ id: IdInput })).optional(),
    delete: z.array(IdInput).optional(),
  })
  .strict();
export type QuoteLinesDiff = z.infer<typeof QuoteLinesDiffSchema>;

/**
 * Params for `update_quote` (§3.4). `id` selects the target, which the client
 * re-reads and routes through `DraftGuard` before any write — a non-`pending`
 * quote (accepted/denied/invoiced/expired/sent) is refused and the `PUT` never
 * issues. Status is not editable here (there is deliberately no accept/send
 * tool). `invoiceLines` uses the `{ create, update, delete }` diff object.
 * Unlike invoices, quotes have **no top-level `label`**: `PUT /quotes/{id}`
 * rejects it with a 500 `NotExistPropertyDefinition` ("These additional
 * properties are not supported: label."). The quote's response `label` field
 * is read-only, mirroring the quote number — it is not settable here.
 * (Line-level `label` on `invoiceLines` is unaffected.)
 */
export const UpdateQuoteParamsSchema = z
  .object({
    id: IdInput,
    customerId: IdInput.optional(),
    date: IsoDate.optional(),
    deadline: IsoDate.optional(),
    invoiceLines: QuoteLinesDiffSchema.optional(),
    externalReference: z.string().optional(),
    currency: z.string().optional(),
    language: z.string().optional(),
    quoteTemplateId: IdInput.optional(),
    pdfInvoiceSubject: z.string().optional(),
    pdfInvoiceFreeText: z.string().optional(),
    pdfDescription: z.string().optional(),
    specialMention: z.string().max(20000).optional(),
  })
  .strict();
export type UpdateQuoteParams = z.infer<typeof UpdateQuoteParamsSchema>;
