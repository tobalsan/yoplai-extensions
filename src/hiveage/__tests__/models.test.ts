import { describe, expect, it } from "vitest";
import {
  ConnectionSchema,
  CreateEstimateParamsSchema,
  InvoiceSchema,
  PaymentSchema,
  RecurringInvoiceSchema,
  TrashItemSchema,
  ValidateEstimateParamsSchema,
  validateEstimateData,
} from "../models.js";

describe("hiveage models", () => {
  it("parses invoice with nested connection and items", () => {
    const invoice = InvoiceSchema.parse({
      id: 1,
      hashKey: "inv_123",
      connection: {
        id: 2,
        hashKey: "conn_123",
        category: "organization",
        name: "Acme",
      },
      state: "paid",
      items: [{ description: "Work", price: "100.00", quantity: "1", total: "100.00" }],
    });

    expect(invoice.hashKey).toBe("inv_123");
    expect(invoice.connection?.category).toBe("organization");
    expect(invoice.items?.[0]?.description).toBe("Work");
  });

  it("parses recurring invoice enum fields", () => {
    const recurringInvoice = RecurringInvoiceSchema.parse({
      recurringMethod: "auto_send",
      intervalUnit: "months",
      state: "active",
    });

    expect(recurringInvoice.recurringMethod).toBe("auto_send");
    expect(recurringInvoice.intervalUnit).toBe("months");
    expect(recurringInvoice.state).toBe("active");
  });

  it("parses payment and trash fields", () => {
    const payment = PaymentSchema.parse({
      paymentMethod: "bank_transfer",
      state: "realized",
    });
    const trash = TrashItemSchema.parse({
      key: "trash_1",
      kindName: "IN-001",
      deletedAt: "2026-04-03",
    });

    expect(payment.paymentMethod).toBe("bank_transfer");
    expect(trash.kindName).toBe("IN-001");
  });

  it("allows passthrough fields on connection", () => {
    const connection = ConnectionSchema.parse({
      id: 1,
      category: "individual",
      customField: "value",
    });

    expect(connection.customField).toBe("value");
  });

  it("parses stringified estimate line item arrays", () => {
    const payload = ValidateEstimateParamsSchema.parse({
      connectionId: "1260219",
      date: "2026-04-18",
      expireDate: "2026-05-18",
      statementNo: "QU-01990",
      itemsAttributes:
        '[{"description":"CFI-STO-BO : Store subscription","price":"1747.2","quantity":"13","sortOrder":1,"unit":""}]',
    });

    expect(payload.connectionId).toBe(1260219);
    expect(payload.itemsAttributes).toHaveLength(1);
    expect(payload.itemsAttributes?.[0]?.sortOrder).toBe(1);
  });

  it("validates stringified estimate line item arrays", () => {
    const result = validateEstimateData({
      connectionId: "1260219",
      date: "2026-04-18",
      expireDate: "2026-05-18",
      statementNo: "QU-01990",
      itemsAttributes:
        '[{"description":"CFI-STO-BO : Store subscription","price":"1747.2","quantity":"13","sortOrder":1,"unit":""}]',
    });

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("rejects date fields on estimate creation line items", () => {
    expect(() =>
      CreateEstimateParamsSchema.parse({
        connectionId: 1260219,
        date: "2026-04-18",
        expireDate: "2026-05-18",
        statementNo: "QU-01990",
        itemsAttributes: [
          {
            date: "2026-04-18",
            description: "CFI-STO-BO : Store subscription",
            price: "1747.2",
            quantity: "13",
            sortOrder: 1,
          },
        ],
      }),
    ).toThrow();
  });
});
