import { describe, expect, it } from "vitest";
import {
  ConnectionSchema,
  InvoiceSchema,
  PaymentSchema,
  RecurringInvoiceSchema,
  TrashItemSchema,
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
});
