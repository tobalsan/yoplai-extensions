import { z } from "zod";

const NullableString = z.string().nullable().optional();
const NullableNumber = z.number().nullable().optional();
const NullableBoolean = z.boolean().nullable().optional();
const NullableStringArray = z.array(z.string()).nullable().optional();

function parseJsonArrayInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function ArrayInput<T extends z.ZodTypeAny>(schema: T): z.ZodEffects<z.ZodUnion<[z.ZodArray<T>, z.ZodString]>, z.output<T>[], z.output<T>[] | string> {
  const arraySchema = z.array(schema);
  return z.union([arraySchema, z.string()]).transform((value, ctx) => {
    const parsed = arraySchema.safeParse(parseJsonArrayInput(value));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue(issue);
      return z.NEVER;
    }
    return parsed.data;
  });
}

const IntegerInput = z.union([z.number().int(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(parsed)) {
    ctx.addIssue({
      code: z.ZodIssueCode.invalid_type,
      expected: "integer",
      received: typeof value === "string" ? "string" : "number",
    });
    return z.NEVER;
  }
  return parsed;
});

export const ConnectionSchema = z.object({
  id: NullableNumber,
  hashKey: NullableString,
  name: NullableString,
  firstName: NullableString,
  lastName: NullableString,
  email: NullableString,
  address: NullableString,
  city: NullableString,
  stateName: NullableString,
  zipCode: NullableString,
  country: NullableString,
  phone: NullableString,
  fax: NullableString,
  websiteUrl: NullableString,
  category: z.enum(["organization", "individual"]).nullable().optional(),
  language: NullableString,
  currency: NullableString,
  primaryContactFirstName: NullableString,
  primaryContactLastName: NullableString,
  createdAt: NullableString,
}).passthrough();
export type Connection = z.infer<typeof ConnectionSchema>;

export const LineItemSchema = z.object({
  id: NullableNumber,
  date: NullableString,
  description: NullableString,
  price: NullableString,
  quantity: NullableString,
  unit: NullableString,
  total: NullableString,
  sortOrder: NullableNumber,
  createdAt: NullableString,
}).passthrough();
export type LineItem = z.infer<typeof LineItemSchema>;

export const EstimateLineItemParamsSchema = z.object({
  description: NullableString,
  price: NullableString,
  quantity: NullableString,
  unit: NullableString,
  sortOrder: z.coerce.number().int().nullable().optional(),
}).strict();

export const TaxSchema = z.object({
  id: NullableNumber,
  name: NullableString,
  key: NullableNumber,
  combinedAmountPercent: NullableString,
  percentage: NullableBoolean,
}).passthrough();
export type Tax = z.infer<typeof TaxSchema>;

export const DiscountSchema = z.object({
  id: NullableNumber,
  name: NullableString,
  key: NullableNumber,
  combinedAmountPercent: NullableString,
  amount: NullableString,
  percentage: NullableBoolean,
}).passthrough();
export type Discount = z.infer<typeof DiscountSchema>;

export const ShippingAmountSchema = z.object({
  id: NullableNumber,
  name: NullableString,
  key: NullableNumber,
  combinedAmountPercent: NullableString,
  percentage: NullableBoolean,
}).passthrough();
export type ShippingAmount = z.infer<typeof ShippingAmountSchema>;

export const ExpenseAttributeSchema = z.object({
  id: NullableNumber,
  date: NullableString,
  description: NullableString,
  amount: NullableString,
  total: NullableString,
}).passthrough();
export type ExpenseAttribute = z.infer<typeof ExpenseAttributeSchema>;

export const TaskAttributeSchema = z.object({
  id: NullableNumber,
  date: NullableString,
  description: NullableString,
  rate: NullableString,
  quantity: NullableString,
  unit: NullableString,
  total: NullableString,
}).passthrough();
export type TaskAttribute = z.infer<typeof TaskAttributeSchema>;

export const TripAttributeSchema = z.object({
  id: NullableNumber,
  date: NullableString,
  description: NullableString,
  distance: NullableString,
  rate: NullableString,
  quantity: NullableString,
  unit: NullableString,
  total: NullableString,
}).passthrough();
export type TripAttribute = z.infer<typeof TripAttributeSchema>;

export const InvoiceSchema = z.object({
  id: NullableNumber,
  hashKey: NullableString,
  connection: ConnectionSchema.nullable().optional(),
  date: NullableString,
  dueDate: NullableString,
  state: z.enum(["draft", "viewed", "sent", "paid", "partial"]).nullable().optional(),
  summary: NullableString,
  note: NullableString,
  companyId: NullableNumber,
  statementNo: NullableString,
  paymentOptions: NullableStringArray,
  allowPartialPayments: NullableBoolean,
  sendReceiptsAutomatically: NullableBoolean,
  sendReminders: NullableBoolean,
  poNumber: NullableString,
  currency: NullableString,
  billedTotal: NullableString,
  formattedBilledTotal: NullableString,
  subTotal: NullableString,
  formattedSubTotal: NullableString,
  totalDue: NullableString,
  formattedTotalDue: NullableString,
  paidTotal: NullableString,
  formattedPaidTotal: NullableString,
  createdAt: NullableString,
  taxes: z.array(TaxSchema).nullable().optional(),
  discounts: z.array(DiscountSchema).nullable().optional(),
  shippingAmounts: z.array(ShippingAmountSchema).nullable().optional(),
  items: z.array(LineItemSchema).nullable().optional(),
  expenses: z.array(ExpenseAttributeSchema).nullable().optional(),
  tasks: z.array(TaskAttributeSchema).nullable().optional(),
  trips: z.array(TripAttributeSchema).nullable().optional(),
  invoiceUrl: NullableString,
}).passthrough();
export type Invoice = z.infer<typeof InvoiceSchema>;

export const RecurringInvoiceSchema = z.object({
  id: NullableNumber,
  hashKey: NullableString,
  connection: ConnectionSchema.nullable().optional(),
  recurringMethod: z.enum(["save_draft", "auto_send", "auto_bill"]).nullable().optional(),
  startDate: NullableString,
  nextBillingDate: NullableString,
  profileName: NullableString,
  profileNo: NullableString,
  occurrences: NullableNumber,
  interval: NullableNumber,
  intervalUnit: z.enum(["days", "weeks", "months", "years"]).nullable().optional(),
  iterationNo: NullableNumber,
  dueDateOptions: NullableNumber,
  state: z.enum(["draft", "scheduled", "pending", "active", "completed", "closed"]).nullable().optional(),
  summary: NullableString,
  note: NullableString,
  companyId: NullableNumber,
  paymentOptions: NullableStringArray,
  allowPartialPayments: NullableBoolean,
  sendReceiptsAutomatically: NullableBoolean,
  sendReminders: NullableBoolean,
  poNumber: NullableString,
  currency: NullableString,
  billedTotal: NullableString,
  formattedBilledTotal: NullableString,
  subTotal: NullableString,
  formattedSubTotal: NullableString,
  createdAt: NullableString,
  taxes: z.array(TaxSchema).nullable().optional(),
  discounts: z.array(DiscountSchema).nullable().optional(),
  shippingAmounts: z.array(ShippingAmountSchema).nullable().optional(),
  items: z.array(LineItemSchema).nullable().optional(),
  expenses: z.array(ExpenseAttributeSchema).nullable().optional(),
  tasks: z.array(TaskAttributeSchema).nullable().optional(),
  trips: z.array(TripAttributeSchema).nullable().optional(),
  recurringInvoiceUrl: NullableString,
}).passthrough();
export type RecurringInvoice = z.infer<typeof RecurringInvoiceSchema>;

export const EstimateSchema = z.object({
  id: NullableNumber,
  hashKey: NullableString,
  connection: ConnectionSchema.nullable().optional(),
  date: NullableString,
  expireDate: NullableString,
  state: z.enum(["draft", "viewed", "sent", "accept", "invoiced"]).nullable().optional(),
  summary: NullableString,
  note: NullableString,
  companyId: NullableNumber,
  statementNo: NullableString,
  currency: NullableString,
  sendReminders: NullableBoolean,
  billedTotal: NullableString,
  formattedBilledTotal: NullableString,
  subTotal: NullableString,
  formattedSubTotal: NullableString,
  createdAt: NullableString,
  taxes: z.array(TaxSchema).nullable().optional(),
  discounts: z.array(DiscountSchema).nullable().optional(),
  shippingAmounts: z.array(ShippingAmountSchema).nullable().optional(),
  items: z.array(LineItemSchema).nullable().optional(),
  expenses: z.array(ExpenseAttributeSchema).nullable().optional(),
  tasks: z.array(TaskAttributeSchema).nullable().optional(),
  trips: z.array(TripAttributeSchema).nullable().optional(),
  estimateUrl: NullableString,
}).passthrough();
export type Estimate = z.infer<typeof EstimateSchema>;

export const PaymentSchema = z.object({
  id: NullableNumber,
  date: NullableString,
  amount: NullableString,
  formattedAmount: NullableString,
  balance: NullableString,
  formattedBalance: NullableString,
  paymentMethod: NullableString,
  details: NullableString,
  combinedPaymentDetails: NullableString,
  currency: NullableString,
  paymentReceiptNo: NullableString,
  paymentReceiptHashKey: NullableString,
  state: z.enum(["realized", "unrealized"]).nullable().optional(),
  createdAt: NullableString,
}).passthrough();
export type Payment = z.infer<typeof PaymentSchema>;

export const ItemDetailSchema = z.object({
  id: NullableNumber,
  hashKey: NullableString,
  name: NullableString,
  description: NullableString,
  unit: NullableString,
  price: NullableString,
  formattedPrice: NullableString,
  createdAt: NullableString,
}).passthrough();
export type ItemDetail = z.infer<typeof ItemDetailSchema>;

export const TrashItemSchema = z.object({
  id: NullableNumber,
  key: NullableString,
  kind: NullableString,
  kindName: NullableString,
  summary: NullableString,
  createdAt: NullableString,
  deletedAt: NullableString,
}).passthrough();
export type TrashItem = z.infer<typeof TrashItemSchema>;

export const ListParamsSchema = z.object({
  perPage: z.number().int().min(1).max(100).optional().default(20),
  page: z.number().int().min(1).optional().default(1),
  order: z.enum(["asc", "desc"]).optional().default("asc"),
});

export const SearchParamsSchema = z.object({
  query: z.string(),
  fields: z.string().optional().default("list"),
  order: z.string().optional().default("desc"),
  column: z.string().optional().default("date"),
});

export const ListInvoicesParamsSchema = ListParamsSchema;
export const GetInvoiceParamsSchema = z.object({
  hashKey: z.string(),
});
export const CreateInvoiceParamsSchema = z.object({
  connectionId: z.number().int(),
  date: z.string(),
  dueDate: z.string(),
  statementNo: z.string(),
  summary: z.string().optional(),
  note: z.string().optional(),
  paymentOptions: z.array(z.string()).optional(),
  allowPartialPayments: z.boolean().optional(),
  sendReceiptsAutomatically: z.boolean().optional(),
  sendReminders: z.boolean().optional(),
  poNumber: z.string().optional(),
  itemsAttributes: z.array(LineItemSchema).optional(),
  expensesAttributes: z.array(ExpenseAttributeSchema).optional(),
  tasksAttributes: z.array(TaskAttributeSchema).optional(),
  tripsAttributes: z.array(TripAttributeSchema).optional(),
  taxesAttributes: z.array(TaxSchema).optional(),
  discountsAttributes: z.array(DiscountSchema).optional(),
  shippingAmountsAttributes: z.array(ShippingAmountSchema).optional(),
});
export const SearchInvoicesParamsSchema = SearchParamsSchema;

export const ListRecurringInvoicesParamsSchema = ListParamsSchema;
export const GetRecurringInvoiceParamsSchema = z.object({
  hashKey: z.string(),
});
export const CreateRecurringInvoiceParamsSchema = z.object({
  connectionId: z.number().int(),
  recurringMethod: z.enum(["save_draft", "auto_send", "auto_bill"]),
  startDate: z.string(),
  profileName: z.string(),
  interval: z.number().int(),
  intervalUnit: z.enum(["days", "weeks", "months", "years"]),
  dueDateOptions: z.number().int(),
  occurrences: z.number().int().optional().default(0),
  profileNo: z.string().optional(),
  summary: z.string().optional(),
  note: z.string().optional(),
  paymentOptions: z.array(z.string()).optional(),
  allowPartialPayments: z.boolean().optional(),
  sendReceiptsAutomatically: z.boolean().optional(),
  sendReminders: z.boolean().optional(),
  poNumber: z.string().optional(),
  itemsAttributes: z.array(LineItemSchema).optional(),
  expensesAttributes: z.array(ExpenseAttributeSchema).optional(),
  tasksAttributes: z.array(TaskAttributeSchema).optional(),
  tripsAttributes: z.array(TripAttributeSchema).optional(),
  taxesAttributes: z.array(TaxSchema).optional(),
  discountsAttributes: z.array(DiscountSchema).optional(),
  shippingAmountsAttributes: z.array(ShippingAmountSchema).optional(),
});
export const SearchRecurringInvoicesParamsSchema = SearchParamsSchema;

export const ListEstimatesParamsSchema = ListParamsSchema;
export const GetEstimateParamsSchema = z.object({
  hashKey: z.string(),
});
export const CreateEstimateParamsSchema = z.object({
  connectionId: IntegerInput,
  date: z.string(),
  expireDate: z.string(),
  statementNo: z.string(),
  summary: z.string().optional(),
  note: z.string().optional(),
  sendReminders: z.boolean().optional(),
  itemsAttributes: ArrayInput(EstimateLineItemParamsSchema).optional(),
  expensesAttributes: ArrayInput(ExpenseAttributeSchema).optional(),
  tasksAttributes: ArrayInput(TaskAttributeSchema).optional(),
  tripsAttributes: ArrayInput(TripAttributeSchema).optional(),
  taxesAttributes: ArrayInput(TaxSchema).optional(),
  discountsAttributes: ArrayInput(DiscountSchema).optional(),
  shippingAmountsAttributes: ArrayInput(ShippingAmountSchema).optional(),
});
export const SearchEstimatesParamsSchema = SearchParamsSchema;

export const ListPaymentsParamsSchema = z.object({
  invoiceHashKey: z.string(),
  perPage: z.number().int().min(1).max(100).optional().default(20),
  page: z.number().int().min(1).optional().default(1),
});
export const GetPaymentParamsSchema = z.object({
  invoiceHashKey: z.string(),
  paymentId: z.number().int(),
});
export const CreatePaymentParamsSchema = z.object({
  invoiceHashKey: z.string(),
  date: z.string(),
  amount: z.string(),
  paymentMethod: z.string(),
  details: z.string().optional(),
});

export const ListItemsParamsSchema = ListParamsSchema;
export const GetItemParamsSchema = z.object({
  itemId: z.number().int(),
});
export const SearchItemsParamsSchema = SearchParamsSchema;

export const ListConnectionsParamsSchema = ListParamsSchema;
export const GetConnectionParamsSchema = z.object({
  hashKey: z.string(),
});
export const SearchConnectionsParamsSchema = z.object({
  query: z.string(),
  order: z.string().optional().default("desc"),
  column: z.string().optional().default("created_at"),
});

export const ValidateEstimateLineItemSchema = EstimateLineItemParamsSchema;

export const ValidateEstimateDiscountSchema = z.object({
  name: z.string().nullable().optional(),
  combinedAmountPercent: z.string().nullable().optional(),
  amount: z.string().nullable().optional(),
  percentage: z.boolean().nullable().optional(),
}).passthrough();

export const ValidateEstimateParamsSchema = z.object({
  connectionId: IntegerInput.optional(),
  date: z.string().optional(),
  expireDate: z.string().optional(),
  statementNo: z.string().optional(),
  summary: z.string().optional(),
  note: z.string().optional(),
  sendReminders: z.boolean().optional(),
  itemsAttributes: ArrayInput(ValidateEstimateLineItemSchema).optional(),
  expensesAttributes: ArrayInput(z.record(z.unknown())).optional(),
  tasksAttributes: ArrayInput(z.record(z.unknown())).optional(),
  tripsAttributes: ArrayInput(z.record(z.unknown())).optional(),
  taxesAttributes: ArrayInput(z.record(z.unknown())).optional(),
  discountsAttributes: ArrayInput(ValidateEstimateDiscountSchema).optional(),
  shippingAmountsAttributes: ArrayInput(z.record(z.unknown())).optional(),
});

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateEstimateData(input: unknown): ValidationResult {
  const parsed = ValidateEstimateParamsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const data = parsed.data;
  const issues: ValidationIssue[] = [];

  // Required fields
  if (data.connectionId == null) {
    issues.push({ field: "connectionId", message: "connectionId is required" });
  }
  if (!data.date) {
    issues.push({ field: "date", message: "date is required" });
  }
  if (!data.expireDate) {
    issues.push({ field: "expireDate", message: "expireDate is required" });
  }
  if (!data.statementNo) {
    issues.push({ field: "statementNo", message: "statementNo is required" });
  }

  // Date format
  if (data.date && !DATE_RE.test(data.date)) {
    issues.push({ field: "date", message: "date must be YYYY-MM-DD format" });
  }
  if (data.expireDate && !DATE_RE.test(data.expireDate)) {
    issues.push({ field: "expireDate", message: "expireDate must be YYYY-MM-DD format" });
  }

  // expireDate after date
  if (data.date && data.expireDate && DATE_RE.test(data.date) && DATE_RE.test(data.expireDate)) {
    if (data.expireDate <= data.date) {
      issues.push({ field: "expireDate", message: "expireDate must be after date" });
    }
  }

  // Line items
  const items = data.itemsAttributes ?? [];
  if (items.length === 0) {
    issues.push({ field: "itemsAttributes", message: "at least one line item is required" });
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.description) {
      issues.push({ field: `itemsAttributes[${i}].description`, message: "line item description is required" });
    }
    if (!item.price) {
      issues.push({ field: `itemsAttributes[${i}].price`, message: "line item price is required" });
    }
    if (item.price && Number.isNaN(Number(item.price))) {
      issues.push({ field: `itemsAttributes[${i}].price`, message: "line item price must be numeric" });
    }
    if (item.quantity && Number.isNaN(Number(item.quantity))) {
      issues.push({ field: `itemsAttributes[${i}].quantity`, message: "line item quantity must be numeric" });
    }
  }

  // Discounts
  const discounts = data.discountsAttributes ?? [];
  for (let i = 0; i < discounts.length; i++) {
    const d = discounts[i];
    if (!d.name) {
      issues.push({ field: `discountsAttributes[${i}].name`, message: "discount name is required" });
    }
  }

  return { valid: issues.length === 0, issues };
}

export const ListTrashParamsSchema = z.object({
  perPage: z.number().int().min(1).max(100).optional().default(20),
  page: z.number().int().min(1).optional().default(1),
});

export const ListInvoicesResponseSchema = z.object({
  invoices: z.array(InvoiceSchema).default([]),
});
export const GetInvoiceResponseSchema = z.object({
  invoice: InvoiceSchema,
});
export const CreateInvoiceResponseSchema = GetInvoiceResponseSchema;
export const SearchInvoicesResponseSchema = ListInvoicesResponseSchema;

export const ListRecurringInvoicesResponseSchema = z.object({
  recurringInvoices: z.array(RecurringInvoiceSchema).default([]),
});
export const GetRecurringInvoiceResponseSchema = z.object({
  recurringInvoice: RecurringInvoiceSchema,
});
export const CreateRecurringInvoiceResponseSchema = GetRecurringInvoiceResponseSchema;
export const SearchRecurringInvoicesResponseSchema = ListRecurringInvoicesResponseSchema;

export const ListEstimatesResponseSchema = z.object({
  estimates: z.array(EstimateSchema).default([]),
});
export const GetEstimateResponseSchema = z.object({
  estimate: EstimateSchema,
});
export const CreateEstimateResponseSchema = GetEstimateResponseSchema;
export const SearchEstimatesResponseSchema = ListEstimatesResponseSchema;

export const ListPaymentsResponseSchema = z.object({
  payments: z.array(PaymentSchema).default([]),
});
export const GetPaymentResponseSchema = z.object({
  payment: PaymentSchema,
});
export const CreatePaymentResponseSchema = GetPaymentResponseSchema;

export const ListItemsResponseSchema = z.object({
  itemCategories: z.array(ItemDetailSchema).default([]),
});
export const GetItemResponseSchema = z.object({
  itemCategory: ItemDetailSchema,
});
export const SearchItemsResponseSchema = ListItemsResponseSchema;

export const ListConnectionsResponseSchema = z.object({
  networks: z.array(ConnectionSchema).default([]),
});
export const GetConnectionResponseSchema = z.object({
  network: ConnectionSchema,
});
export const SearchConnectionsResponseSchema = ListConnectionsResponseSchema;

export const ListTrashResponseSchema = z.object({
  trash: z.array(TrashItemSchema).default([]),
});

export function addInvoiceUrl(invoice: Invoice, subdomain: string): Invoice {
  return invoice.hashKey
    ? { ...invoice, invoiceUrl: `https://${subdomain}.hiveage.com/invs/${invoice.hashKey}` }
    : invoice;
}

export function addRecurringInvoiceUrl(
  recurringInvoice: RecurringInvoice,
  subdomain: string,
): RecurringInvoice {
  return recurringInvoice.hashKey
    ? {
        ...recurringInvoice,
        recurringInvoiceUrl: `https://${subdomain}.hiveage.com/rinv/${recurringInvoice.hashKey}`,
      }
    : recurringInvoice;
}

export function addEstimateUrl(estimate: Estimate, subdomain: string): Estimate {
  return estimate.hashKey
    ? { ...estimate, estimateUrl: `https://${subdomain}.hiveage.com/estm/${estimate.hashKey}` }
    : estimate;
}
