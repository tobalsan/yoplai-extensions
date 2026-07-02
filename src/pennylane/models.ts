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
