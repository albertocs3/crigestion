import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createInitialAccountingFiscalYear } from "@/modules/accounting/application/fiscalYears";
import { login } from "@/modules/platform/application/auth";
import { hashRequestBody, initializePlatform, type InitializeCommand } from "@/modules/platform/application/installation";
import { createPurchase, createPurchaseCorrection, createPurchaseRectification, purchaseRequestHash, registerPurchase, registerSupplierPayment, replacePurchaseDueDates, replacePurchaseLines } from "@/modules/purchases/application/purchases";
import { createSupplier, supplierRequestHash } from "@/modules/suppliers/application/suppliers";
import { applySupplierCredit, approveSupplierCreditRefund, getSupplierCredit, hashSupplierCreditApplication, hashSupplierCreditRefundAction, hashSupplierCreditRefundPost, hashSupplierCreditRefundRequest, postSupplierCreditRefund, requestSupplierCreditRefund } from "@/modules/treasury/application/supplierCredits";
import type { SessionUser } from "@/modules/platform/application/auth";

const password = "Cambiar-esta-clave-2026";
const initialization: InitializeCommand = { company: { legalName: "CriGestion Test SL", taxId: "B12345678", email: "admin@example.test" }, administrator: { displayName: "Administrador", userName: "admin", password } };
let testActor: SessionUser;

describe("supplier purchases and payments", () => {
  beforeEach(async () => { configureSecrets(); await reset(); testActor = await initialize(); });
  afterAll(async () => { await reset(); await prisma.$disconnect(); });

  it("registers purchase accounting, supported VAT, stock and partial/full supplier payments atomically", async () => {
    const actor = testActor; const supplier = await supplierFor(actor); const tax = await prisma.catalogTaxRate.findUniqueOrThrow({ where: { code: "IVA_21" } });
    const item = await prisma.catalogItem.create({ data: { code: "COMPRA-1", kind: "PRODUCT", name: "Producto comprado", unitName: "Unidades", salePrice: "20", costPrice: "10", taxRateId: tax.id, taxRate: tax.rate, purchaseAccountCode: "600000000", stockTracked: true, stockCurrent: "2", stockMinimum: "0", createdById: actor.id } });
    const created = await createPurchase({ supplierId: supplier.id, supplierInvoiceNumber: "F-2026/001", issueDate: "2026-07-01", receivedDate: "2026-07-02", operationDate: "2026-07-01", accountingDate: "2026-07-02", notes: null }, actor, context("create", "create", {}));
    if (!created.ok) throw new Error(created.error.code);
    const lines = { expectedVersion: created.value.version, lines: [{ catalogItemId: item.id, description: "Producto comprado", quantity: "10", unitPrice: "10", discountPercent: "0", discountAmount: "0", purchaseAccountCode: null, taxRateId: tax.id }] };
    const withLines = await replacePurchaseLines(created.value.id, lines, actor, context("lines", "lines", lines)); if (!withLines.ok) throw new Error(withLines.error.code); expect(withLines.value.total).toBe("121.00");
    const staleLines = { ...lines, lines: [{ ...lines.lines[0]!, description: "Sobrescritura obsoleta" }] };
    expect(await replacePurchaseLines(created.value.id, staleLines, actor, context("stale-lines", "lines", staleLines))).toMatchObject({ ok: false, error: { code: "PURCHASE_VERSION_CONFLICT" } });
    const dueDates = { expectedVersion: withLines.value.version, dueDates: [{ dueDate: "2026-07-31", amount: "121.00", paymentMethod: "BANK_TRANSFER" as const }] };
    const scheduled = await replacePurchaseDueDates(created.value.id, dueDates, actor, context("due", "due", dueDates)); if (!scheduled.ok) throw new Error(scheduled.error.code);
    const registered = await registerPurchase(created.value.id, { expectedVersion: scheduled.value.version }, actor, context("register", "register", { expectedVersion: scheduled.value.version }));
    expect(registered).toMatchObject({ ok: true, value: { status: "REGISTERED", paymentStatus: "PENDING", total: "121.00" } });
    expect(await prisma.purchaseVatRecord.count({ where: { purchaseInvoiceId: created.value.id } })).toBe(1);
    expect(await prisma.catalogItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ stockCurrent: expect.objectContaining({}) });
    const storedItem = await prisma.catalogItem.findUniqueOrThrow({ where: { id: item.id } }); expect(storedItem.stockCurrent.toFixed(3)).toBe("12.000"); expect(storedItem.costPrice.toFixed(2)).toBe("10.00");
    const vat = await prisma.purchaseVatRecord.findFirstOrThrow({ where: { purchaseInvoiceId: created.value.id } }); expect(Buffer.from(vat.supplierTaxIdEncryptedSnapshot).byteLength).toBeGreaterThan(32);
    await expect(prisma.purchaseInvoice.update({ where: { id: created.value.id }, data: { status: "DRAFT", registeredAt: null, registeredById: null } })).rejects.toThrow("REGISTERED_PURCHASE_IMMUTABLE");
    await expect(prisma.purchaseDueDate.update({ where: { id: registered.ok ? registered.value.dueDates[0]!.id : randomUUID() }, data: { amount: "120.00" } })).rejects.toThrow("REGISTERED_PURCHASE_DUE_DATE_IMMUTABLE");
    await expect(prisma.purchaseVatRecord.update({ where: { id: vat.id }, data: { taxAmount: "20.00" } })).rejects.toThrow("PURCHASE_VAT_HISTORY_IMMUTABLE");
    const purchaseEntry = await prisma.accountingJournalEntry.findUniqueOrThrow({ where: { purchaseInvoiceId: created.value.id }, include: { lines: { include: { account: true } } } });
    expect(purchaseEntry.origin).toBe("PURCHASE_INVOICE"); expect(purchaseEntry.lines.map((line) => line.account.code)).toEqual(expect.arrayContaining(["600000000", "472000000", supplier.accountingCode]));
    if (!registered.ok) throw new Error("registration failed"); const due = registered.value.dueDates[0]!;
    const partialCommand = { supplierId: supplier.id, paymentDate: "2026-07-20", paymentMethod: "BANK_TRANSFER" as const, reference: "TR-1", notes: null, allocations: [{ dueDateId: due.id, amount: "40.00" }] };
    const partial = await registerSupplierPayment(partialCommand, actor, context("pay-1", "pay", partialCommand)); expect(partial).toMatchObject({ ok: true, status: 201, value: { totalAmount: "40.00" } });
    if (!partial.ok) throw new Error("partial payment failed"); await expect(prisma.supplierPayment.update({ where: { id: partial.value.id }, data: { totalAmount: "39.00" } })).rejects.toThrow("SUPPLIER_PAYMENT_HISTORY_IMMUTABLE");
    expect((await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: created.value.id } })).paymentStatus).toBe("PARTIALLY_PAID");
    const finalCommand = { ...partialCommand, reference: "TR-2", allocations: [{ dueDateId: due.id, amount: "81.00" }] };
    const final = await registerSupplierPayment(finalCommand, actor, context("pay-2", "pay", finalCommand)); expect(final.ok).toBe(true);
    expect((await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: created.value.id } })).paymentStatus).toBe("PAID"); expect((await prisma.purchaseDueDate.findUniqueOrThrow({ where: { id: due.id } })).status).toBe("PAID");
    expect(await prisma.accountingJournalEntry.count({ where: { origin: "SUPPLIER_PAYMENT" } })).toBe(2);
    const overpayment = { ...partialCommand, reference: "TR-3", allocations: [{ dueDateId: due.id, amount: "0.01" }] };
    expect(await registerSupplierPayment(overpayment, actor, context("pay-3", "pay", overpayment))).toMatchObject({ ok: false, error: { code: "SUPPLIER_PAYMENT_EXCEEDS_PENDING" } });
    expect(await prisma.supplierPayment.count()).toBe(2);
  });

  it("rejects overpayment, duplicate supplier numbers and idempotency-key reuse", async () => {
    const actor = testActor; const supplier = await supplierFor(actor); const command = { supplierId: supplier.id, supplierInvoiceNumber: " DUP-01 ", issueDate: "2026-07-01", receivedDate: "2026-07-01", operationDate: "2026-07-01", accountingDate: "2026-07-01", notes: null };
    const first = await createPurchase(command, actor, context("same", "create", command)); const replay = await createPurchase(command, actor, context("same", "create", command)); expect(replay).toEqual(first);
    const changed = { ...command, supplierInvoiceNumber: "OTHER" }; const conflict = await createPurchase(changed, actor, context("same", "create", changed)); expect(conflict).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    const duplicate = await createPurchase({ ...command, supplierInvoiceNumber: "dup-01" }, actor, context("duplicate", "create", command)); expect(duplicate).toMatchObject({ ok: false, error: { code: "PURCHASE_NUMBER_ALREADY_USED" } });
    expect(await prisma.purchaseSupplierDocumentIdentity.count()).toBe(1);
  });

  it("voids an unpaid purchase with append-only accounting, VAT and stock reversals", async () => {
    const actor = testActor; const supplier = await supplierFor(actor); const tax = await prisma.catalogTaxRate.findUniqueOrThrow({ where: { code: "IVA_21" } });
    const item = await prisma.catalogItem.create({ data: { code: "VOID-1", kind: "PRODUCT", name: "Producto anulable", unitName: "Unidades", salePrice: "20", costPrice: "8", taxRateId: tax.id, taxRate: tax.rate, purchaseAccountCode: "600000000", stockTracked: true, stockCurrent: "2", stockMinimum: "0", createdById: actor.id } });
    const created = await createPurchase({ supplierId: supplier.id, supplierInvoiceNumber: "F-VOID-01", issueDate: "2026-07-01", receivedDate: "2026-07-02", operationDate: "2026-07-01", accountingDate: "2026-07-02", notes: null }, actor, context("void-create", "create", {})); if (!created.ok) throw new Error(created.error.code);
    const lines = { expectedVersion: created.value.version, lines: [{ catalogItemId: item.id, description: "Producto anulable", quantity: "3", unitPrice: "8", discountPercent: "0", discountAmount: "0", purchaseAccountCode: null, taxRateId: tax.id }] };
    const withLines = await replacePurchaseLines(created.value.id, lines, actor, context("void-lines", "lines", lines)); if (!withLines.ok) throw new Error(withLines.error.code);
    const dues = { expectedVersion: withLines.value.version, dueDates: [{ dueDate: "2026-07-31", amount: withLines.value.total, paymentMethod: "BANK_TRANSFER" as const }] };
    const scheduled = await replacePurchaseDueDates(created.value.id, dues, actor, context("void-dues", "dues", dues)); if (!scheduled.ok) throw new Error(scheduled.error.code);
    const registered = await registerPurchase(created.value.id, { expectedVersion: scheduled.value.version }, actor, context("void-register", "register", {})); if (!registered.ok) throw new Error(registered.error.code);
    const sourceEntry = await prisma.accountingJournalEntry.findUniqueOrThrow({ where: { purchaseInvoiceId: created.value.id }, include: { lines: { orderBy: { position: "asc" } } } });
    const tooEarly = { mode: "VOID" as const, expectedVersion: registered.value.version, accountingDate: "2026-07-01", reasonCode: "DUPLICATE_DOCUMENT" as const, reason: null, confirmation: "VOID_PURCHASE_WITHOUT_FINANCIAL_ACTIVITY" as const };
    expect(await createPurchaseCorrection(created.value.id, tooEarly, actor, context("void-early", `correct:${created.value.id}`, tooEarly))).toMatchObject({ ok: false, error: { code: "PURCHASE_CORRECTION_DATE_INVALID" } });
    const command = { mode: "VOID" as const, expectedVersion: registered.value.version, accountingDate: "2026-07-20", reasonCode: "DUPLICATE_DOCUMENT" as const, reason: "Factura duplicada en la carga", confirmation: "VOID_PURCHASE_WITHOUT_FINANCIAL_ACTIVITY" as const };
    const mutation = context("void", `correct:${created.value.id}`, command); const competingMutation = context("void-race", `correct:${created.value.id}`, command);
    const attempts = await Promise.all([createPurchaseCorrection(created.value.id, command, actor, mutation), createPurchaseCorrection(created.value.id, command, actor, competingMutation)]);
    const result = attempts.find((attempt) => attempt.ok); const rejected = attempts.find((attempt) => !attempt.ok);
    if (!result) throw new Error("Purchase correction race did not produce a winner");
    expect(result).toMatchObject({ ok: true, status: 201, value: { purchaseInvoiceId: created.value.id, mode: "VOID", status: "VOIDED", paymentStatus: "NOT_APPLICABLE", vatAdjustmentCount: 1, stockReversalCount: 1 } });
    expect(rejected).toMatchObject({ ok: false, error: { code: "PURCHASE_VERSION_CONFLICT" } });
    const winningMutation = attempts[0]?.ok ? mutation : competingMutation;
    expect(await createPurchaseCorrection(created.value.id, command, actor, winningMutation)).toEqual(result);
    const source = await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: created.value.id }, include: { dueDates: true, sourceCorrectionOperation: true } });
    expect(source).toMatchObject({ status: "VOIDED", paymentStatus: "NOT_APPLICABLE", version: registered.value.version + 1, sourceCorrectionOperation: { id: result.value.operationId, mode: "VOID" } });
    expect(source.dueDates.every((due) => due.status === "CANCELLED")).toBe(true);
    const reversal = await prisma.accountingJournalEntry.findUniqueOrThrow({ where: { purchaseCorrectionOperationId: result.value.operationId }, include: { lines: { orderBy: { position: "asc" } } } });
    expect(reversal).toMatchObject({ origin: "PURCHASE_CORRECTION_REVERSAL", reversesEntryId: sourceEntry.id });
    expect(reversal.lines.map((line) => [line.accountId, line.debit.toFixed(2), line.credit.toFixed(2)])).toEqual(sourceEntry.lines.map((line) => [line.accountId, line.credit.toFixed(2), line.debit.toFixed(2)]));
    const vat = await prisma.purchaseVatRecord.findMany({ where: { purchaseInvoiceId: created.value.id }, orderBy: { createdAt: "asc" } });
    expect(vat).toHaveLength(2); expect(vat[1]).toMatchObject({ kind: "INTERNAL_CORRECTION_REVERSAL", reversesVatRecordId: vat[0]!.id, correctionOperationId: result.value.operationId });
    expect(vat[1]!.taxableBase.toFixed(2)).toBe(vat[0]!.taxableBase.negated().toFixed(2));
    expect((await prisma.catalogItem.findUniqueOrThrow({ where: { id: item.id } })).stockCurrent.toFixed(3)).toBe("2.000");
    expect(await prisma.catalogStockMovement.findFirstOrThrow({ where: { purchaseCorrectionOperationId: result.value.operationId } })).toMatchObject({ type: "PURCHASE_INTERNAL_REVERSAL" });
    await expect(prisma.purchaseDueDate.create({ data: { purchaseInvoiceId: created.value.id, position: 2, dueDate: new Date("2026-08-31T00:00:00.000Z"), amount: "1.00", paymentMethod: "BANK_TRANSFER" } })).rejects.toThrow("REGISTERED_PURCHASE_DUE_DATE_IMMUTABLE");
    await expect(prisma.purchaseCorrectionOperation.update({ where: { id: result.value.operationId }, data: { reason: "sobrescritura" } })).rejects.toThrow("PURCHASE_CORRECTION_OPERATION_APPEND_ONLY");
    expect(await prisma.auditEvent.count({ where: { eventType: "PURCHASE_CORRECTION_VOIDED", payload: { path: ["operationId"], equals: result.value.operationId } } })).toBe(1);
  });

  it("blocks internal voiding after supplier payment activity", async () => {
    const actor = testActor; const supplier = await supplierFor(actor); const tax = await prisma.catalogTaxRate.findUniqueOrThrow({ where: { code: "IVA_21" } });
    const created = await createPurchase({ supplierId: supplier.id, supplierInvoiceNumber: "F-VOID-PAID", issueDate: "2026-07-01", receivedDate: "2026-07-01", operationDate: "2026-07-01", accountingDate: "2026-07-01", notes: null }, actor, context("void-paid-create", "create", {})); if (!created.ok) throw new Error(created.error.code);
    const lines = { expectedVersion: created.value.version, lines: [{ catalogItemId: null, description: "Servicio", quantity: "1", unitPrice: "100", discountPercent: "0", discountAmount: "0", purchaseAccountCode: "600000000", taxRateId: tax.id }] };
    const withLines = await replacePurchaseLines(created.value.id, lines, actor, context("void-paid-lines", "lines", lines)); if (!withLines.ok) throw new Error(withLines.error.code);
    const dues = { expectedVersion: withLines.value.version, dueDates: [{ dueDate: "2026-07-31", amount: withLines.value.total, paymentMethod: "BANK_TRANSFER" as const }] };
    const scheduled = await replacePurchaseDueDates(created.value.id, dues, actor, context("void-paid-dues", "dues", dues)); if (!scheduled.ok) throw new Error(scheduled.error.code);
    const registered = await registerPurchase(created.value.id, { expectedVersion: scheduled.value.version }, actor, context("void-paid-register", "register", {})); if (!registered.ok) throw new Error(registered.error.code);
    const payment = { supplierId: supplier.id, paymentDate: "2026-07-10", paymentMethod: "BANK_TRANSFER" as const, reference: null, notes: null, allocations: [{ dueDateId: registered.value.dueDates[0]!.id, amount: "1.00" }] };
    expect((await registerSupplierPayment(payment, actor, context("void-paid-payment", "pay", payment))).ok).toBe(true);
    const command = { mode: "VOID" as const, expectedVersion: registered.value.version, accountingDate: "2026-07-20", reasonCode: "DUPLICATE_DOCUMENT" as const, reason: null, confirmation: "VOID_PURCHASE_WITHOUT_FINANCIAL_ACTIVITY" as const };
    expect(await createPurchaseCorrection(created.value.id, command, actor, context("void-paid", `correct:${created.value.id}`, command))).toMatchObject({ ok: false, error: { code: "PURCHASE_CORRECTION_FINANCIAL_ACTIVITY" } });
    expect(await prisma.purchaseCorrectionOperation.count()).toBe(0);
  });

  it("replaces an unpaid purchase with a registered version under the same document identity", async () => {
    const actor = testActor; const supplier = await supplierFor(actor); const tax = await prisma.catalogTaxRate.findUniqueOrThrow({ where: { code: "IVA_21" } });
    const item = await prisma.catalogItem.create({ data: { code: "REPLACE-1", kind: "PRODUCT", name: "Producto sustituible", unitName: "Unidades", salePrice: "20", costPrice: "8", taxRateId: tax.id, taxRate: tax.rate, purchaseAccountCode: "600000000", stockTracked: true, stockCurrent: "2", stockMinimum: "0", createdById: actor.id } });
    const created = await createPurchase({ supplierId: supplier.id, supplierInvoiceNumber: "F-REPLACE-01", issueDate: "2026-07-01", receivedDate: "2026-07-02", operationDate: "2026-07-01", accountingDate: "2026-07-02", notes: null }, actor, context("replace-create", "create", {})); if (!created.ok) throw new Error(created.error.code);
    const lines = { expectedVersion: created.value.version, lines: [{ catalogItemId: item.id, description: "Producto original", quantity: "3", unitPrice: "8", discountPercent: "0", discountAmount: "0", purchaseAccountCode: null, taxRateId: tax.id }] };
    const withLines = await replacePurchaseLines(created.value.id, lines, actor, context("replace-lines", "lines", lines)); if (!withLines.ok) throw new Error(withLines.error.code);
    const dues = { expectedVersion: withLines.value.version, dueDates: [{ dueDate: "2026-07-31", amount: withLines.value.total, paymentMethod: "BANK_TRANSFER" as const }] };
    const scheduled = await replacePurchaseDueDates(created.value.id, dues, actor, context("replace-dues", "dues", dues)); if (!scheduled.ok) throw new Error(scheduled.error.code);
    const registered = await registerPurchase(created.value.id, { expectedVersion: scheduled.value.version }, actor, context("replace-register", "register", {})); if (!registered.ok) throw new Error(registered.error.code);
    const command = { mode: "REPLACE" as const, expectedVersion: registered.value.version, accountingDate: "2026-07-20", reasonCode: "WRONG_AMOUNT" as const, reason: "Cantidad recibida corregida", confirmation: "REPLACE_PURCHASE_WITHOUT_FINANCIAL_ACTIVITY" as const,
      replacement: { issueDate: "2026-07-01", receivedDate: "2026-07-02", operationDate: "2026-07-01", accountingDate: "2026-07-20", notes: "Versión corregida", lines: [{ catalogItemId: item.id, description: "Producto corregido", quantity: "5", unitPrice: "10", discountPercent: "0", discountAmount: "0", purchaseAccountCode: null, taxRateId: tax.id }], dueDates: [{ dueDate: "2026-08-15", amount: "60.50", paymentMethod: "BANK_TRANSFER" as const }] } };
    const result = await createPurchaseCorrection(created.value.id, command, actor, context("replace", `correct:${created.value.id}`, command));
    expect(result).toMatchObject({ ok: true, status: 201, value: { mode: "REPLACE", purchaseInvoiceId: created.value.id, status: "SUPERSEDED", replacementVatRecordCount: 1, replacementStockMovementCount: 1 } });
    if (!result.ok || !result.value.replacementPurchaseInvoiceId || !result.value.replacementEntry) throw new Error("replacement failed");
    const [source, replacement] = await Promise.all([prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: created.value.id }, include: { dueDates: true } }), prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: result.value.replacementPurchaseInvoiceId }, include: { dueDates: true } })]);
    expect(source).toMatchObject({ status: "SUPERSEDED", paymentStatus: "NOT_APPLICABLE", documentIdentityId: replacement.documentIdentityId });
    expect(source.dueDates.every((due) => due.status === "CANCELLED")).toBe(true);
    expect(replacement).toMatchObject({ status: "REGISTERED", paymentStatus: "PENDING", supplierInvoiceNumberNormalized: source.supplierInvoiceNumberNormalized, total: expect.objectContaining({}) });
    expect(replacement.total.toFixed(2)).toBe("60.50"); expect(replacement.dueDates[0]?.amount.toFixed(2)).toBe("60.50");
    expect((await prisma.catalogItem.findUniqueOrThrow({ where: { id: item.id } })).stockCurrent.toFixed(3)).toBe("7.000");
    expect(await prisma.accountingJournalEntry.count({ where: { OR: [{ purchaseCorrectionOperationId: result.value.operationId }, { purchaseInvoiceId: replacement.id }] } })).toBe(2);
    expect(await prisma.purchaseVatRecord.count({ where: { purchaseInvoiceId: replacement.id, kind: "DOCUMENT" } })).toBe(1);
    expect(await prisma.purchaseInvoice.count({ where: { documentIdentityId: source.documentIdentityId, status: { in: ["DRAFT", "REGISTERED"] } } })).toBe(1);
    const secondCommand = { ...command, expectedVersion: replacement.version, accountingDate: "2026-07-21", reasonCode: "WRONG_DATE" as const,
      replacement: { ...command.replacement, accountingDate: "2026-07-21", lines: [{ ...command.replacement.lines[0]!, quantity: "4" }], dueDates: [{ ...command.replacement.dueDates[0]!, amount: "48.40" }] } };
    const second = await createPurchaseCorrection(replacement.id, secondCommand, actor, context("replace-again", `correct:${replacement.id}`, secondCommand));
    expect(second).toMatchObject({ ok: true, value: { mode: "REPLACE", purchaseInvoiceId: replacement.id, status: "SUPERSEDED" } }); if (!second.ok || !second.value.replacementPurchaseInvoiceId) throw new Error("second replacement failed");
    const current = await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: second.value.replacementPurchaseInvoiceId }, include: { dueDates: true } });
    expect(current).toMatchObject({ status: "REGISTERED", documentIdentityId: source.documentIdentityId }); expect((await prisma.catalogItem.findUniqueOrThrow({ where: { id: item.id } })).stockCurrent.toFixed(3)).toBe("6.000");
    const payment = { supplierId: supplier.id, paymentDate: "2026-07-25", paymentMethod: "BANK_TRANSFER" as const, reference: "REPLACE-PAY", notes: null, allocations: [{ dueDateId: current.dueDates[0]!.id, amount: "1.00" }] };
    expect((await registerSupplierPayment(payment, actor, context("replace-pay", "pay", payment))).ok).toBe(true);
    expect((await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: current.id } })).paymentStatus).toBe("PARTIALLY_PAID");
  });

  it("creates an append-only full supplier rectification and reverses accounting, VAT, stock and due dates", async () => {
    const actor = testActor; const supplier = await supplierFor(actor); const tax = await prisma.catalogTaxRate.findUniqueOrThrow({ where: { code: "IVA_21" } });
    const item = await prisma.catalogItem.create({ data: { code: "RECT-1", kind: "PRODUCT", name: "Producto rectificable", unitName: "Unidades", salePrice: "20", costPrice: "8", taxRateId: tax.id, taxRate: tax.rate, purchaseAccountCode: "600000000", stockTracked: true, stockCurrent: "2", stockMinimum: "0", createdById: actor.id } });
    const created = await createPurchase({ supplierId: supplier.id, supplierInvoiceNumber: "F-RECT-01", issueDate: "2026-07-01", receivedDate: "2026-07-02", operationDate: "2026-07-01", accountingDate: "2026-07-02", notes: null }, actor, context("rect-create", "create", {})); if (!created.ok) throw new Error(created.error.code);
    const lines = { expectedVersion: created.value.version, lines: [{ catalogItemId: item.id, description: "Producto rectificable", quantity: "3", unitPrice: "8", discountPercent: "0", discountAmount: "0", purchaseAccountCode: null, taxRateId: tax.id }] };
    const withLines = await replacePurchaseLines(created.value.id, lines, actor, context("rect-lines", "lines", lines)); if (!withLines.ok) throw new Error(withLines.error.code);
    const dues = { expectedVersion: withLines.value.version, dueDates: [{ dueDate: "2026-07-31", amount: withLines.value.total, paymentMethod: "BANK_TRANSFER" as const }] };
    const scheduled = await replacePurchaseDueDates(created.value.id, dues, actor, context("rect-dues", "dues", dues)); if (!scheduled.ok) throw new Error(scheduled.error.code);
    const registered = await registerPurchase(created.value.id, { expectedVersion: scheduled.value.version }, actor, context("rect-register", "register", {})); if (!registered.ok) throw new Error(registered.error.code);
    const originalEntry = await prisma.accountingJournalEntry.findUniqueOrThrow({ where: { purchaseInvoiceId: created.value.id }, include: { lines: { include: { account: true }, orderBy: { position: "asc" } } } });
    const command = { mode: "FULL" as const, expectedVersion: registered.value.version, supplierInvoiceNumber: "R-F-RECT-01", issueDate: "2026-07-20", receivedDate: "2026-07-20", operationDate: "2026-07-20", accountingDate: "2026-07-20", reason: "RETURN" as const, notes: "Devolución completa" };
    const mutation = context("rectify", `rectify:${created.value.id}`, command); const competingMutation = context("rectify-race", `rectify:${created.value.id}`, command);
    const attempts = await Promise.all([createPurchaseRectification(created.value.id, command, actor, mutation), createPurchaseRectification(created.value.id, command, actor, competingMutation)]);
    const result = attempts.find((attempt) => attempt.ok); const rejected = attempts.find((attempt) => !attempt.ok);
    expect(result).toMatchObject({ ok: true, status: 201, value: { documentType: "RECTIFICATION", status: "REGISTERED", paymentStatus: "NOT_APPLICABLE", total: "-29.04", rectifiesPurchaseInvoice: { id: created.value.id } } });
    expect(rejected).toMatchObject({ ok: false, error: { code: "PURCHASE_ALREADY_RECTIFIED" } });
    if (!result) throw new Error("Rectification race did not produce a winner");
    const winningMutation = attempts[0]?.ok ? mutation : competingMutation; expect(await createPurchaseRectification(created.value.id, command, actor, winningMutation)).toEqual(result);
    const original = await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: created.value.id }, include: { dueDates: true, rectificationInvoices: true } });
    expect(original.status).toBe("RECTIFIED"); expect(original.paymentStatus).toBe("NOT_APPLICABLE"); expect(original.dueDates).toHaveLength(1); expect(original.dueDates[0]!.status).toBe("CANCELLED"); expect(original.rectificationInvoices).toHaveLength(1);
    const rectificationEntry = await prisma.accountingJournalEntry.findUniqueOrThrow({ where: { purchaseInvoiceId: result.value.id }, include: { lines: { include: { account: true }, orderBy: { position: "asc" } } } });
    expect(rectificationEntry.origin).toBe("PURCHASE_RECTIFICATION"); expect(rectificationEntry.reversesEntryId).toBe(originalEntry.id);
    expect(rectificationEntry.lines.map((line) => [line.account.code, line.debit.toFixed(2), line.credit.toFixed(2)])).toEqual(originalEntry.lines.map((line) => [line.account.code, line.credit.toFixed(2), line.debit.toFixed(2)]));
    const vat = await prisma.purchaseVatRecord.findFirstOrThrow({ where: { purchaseInvoiceId: result.value.id } }); expect(vat.taxableBase.toFixed(2)).toBe("-24.00"); expect(vat.taxAmount.toFixed(2)).toBe("-5.04");
    const stock = await prisma.catalogItem.findUniqueOrThrow({ where: { id: item.id } }); expect(stock.stockCurrent.toFixed(3)).toBe("2.000");
    const movement = await prisma.catalogStockMovement.findFirstOrThrow({ where: { purchaseInvoiceLine: { purchaseInvoiceId: result.value.id } } }); expect(movement.type).toBe("PURCHASE_RETURN"); expect(movement.quantity.toFixed(3)).toBe("-3.000");
    expect(await prisma.auditEvent.count({ where: { eventType: "PURCHASE_RECTIFICATION_CREATED", payload: { path: ["originalPurchaseInvoiceId"], equals: created.value.id } } })).toBe(1);
  });

  it("blocks partial payment rectification and creates an applicable/refundable credit after full payment", async () => {
    const actor = testActor; const supplier = await supplierFor(actor); const tax = await prisma.catalogTaxRate.findUniqueOrThrow({ where: { code: "IVA_21" } });
    const created = await createPurchase({ supplierId: supplier.id, supplierInvoiceNumber: "F-PAID-01", issueDate: "2026-07-01", receivedDate: "2026-07-01", operationDate: "2026-07-01", accountingDate: "2026-07-01", notes: null }, actor, context("paid-create", "create", {})); if (!created.ok) throw new Error(created.error.code);
    const lines = { expectedVersion: created.value.version, lines: [{ catalogItemId: null, description: "Servicio", quantity: "1", unitPrice: "100", discountPercent: "0", discountAmount: "0", purchaseAccountCode: "600000000", taxRateId: tax.id }] };
    const withLines = await replacePurchaseLines(created.value.id, lines, actor, context("paid-lines", "lines", lines)); if (!withLines.ok) throw new Error(withLines.error.code);
    const dues = { expectedVersion: withLines.value.version, dueDates: [{ dueDate: "2026-07-31", amount: withLines.value.total, paymentMethod: "BANK_TRANSFER" as const }] };
    const scheduled = await replacePurchaseDueDates(created.value.id, dues, actor, context("paid-dues", "dues", dues)); if (!scheduled.ok) throw new Error(scheduled.error.code);
    const registered = await registerPurchase(created.value.id, { expectedVersion: scheduled.value.version }, actor, context("paid-register", "register", {})); if (!registered.ok) throw new Error(registered.error.code);
    const payment = { supplierId: supplier.id, paymentDate: "2026-07-10", paymentMethod: "BANK_TRANSFER" as const, reference: null, notes: null, allocations: [{ dueDateId: registered.value.dueDates[0]!.id, amount: "1.00" }] };
    expect((await registerSupplierPayment(payment, actor, context("paid-payment", "pay", payment))).ok).toBe(true);
    const command = { mode: "FULL" as const, expectedVersion: registered.value.version, supplierInvoiceNumber: "R-F-PAID-01", issueDate: "2026-07-20", receivedDate: "2026-07-20", operationDate: "2026-07-20", accountingDate: "2026-07-20", reason: "RETURN" as const, notes: null };
    expect(await createPurchaseRectification(created.value.id, command, actor, context("paid-rect-partial", "rectify", command))).toMatchObject({ ok: false, error: { code: "PURCHASE_RECTIFICATION_PARTIAL_PAYMENT_UNSUPPORTED" } });
    const remainder = { ...payment, reference: "FINAL", allocations: [{ dueDateId: registered.value.dueDates[0]!.id, amount: "120.00" }] };
    expect((await registerSupplierPayment(remainder, actor, context("paid-payment-final", "pay", remainder))).ok).toBe(true);
    const rectified = await createPurchaseRectification(created.value.id, command, actor, context("paid-rect", "rectify", command));
    expect(rectified).toMatchObject({ ok: true, value: { documentType: "RECTIFICATION", total: "-121.00" } });
    const original = await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: created.value.id }, include: { dueDates: true } });
    expect(original).toMatchObject({ status: "RECTIFIED", paymentStatus: "PAID" }); expect(original.dueDates[0]!.status).toBe("PAID");
    const credit = await prisma.supplierCredit.findFirstOrThrow({ where: { sourceRectificationPurchaseInvoiceId: rectified.ok ? rectified.value.id : randomUUID() } });
    expect(credit.originalAmount.toFixed(2)).toBe("121.00");

    const targetCreated = await createPurchase({ supplierId: supplier.id, supplierInvoiceNumber: "F-FUTURE-01", issueDate: "2026-07-20", receivedDate: "2026-07-20", operationDate: "2026-07-20", accountingDate: "2026-07-20", notes: null }, actor, context("target-create", "create", {})); if (!targetCreated.ok) throw new Error(targetCreated.error.code);
    const targetLines = { expectedVersion: targetCreated.value.version, lines: [{ catalogItemId: null, description: "Compra futura", quantity: "1", unitPrice: "50", discountPercent: "0", discountAmount: "0", purchaseAccountCode: "600000000", taxRateId: tax.id }] };
    const targetWithLines = await replacePurchaseLines(targetCreated.value.id, targetLines, actor, context("target-lines", "lines", targetLines)); if (!targetWithLines.ok) throw new Error(targetWithLines.error.code);
    const targetDues = { expectedVersion: targetWithLines.value.version, dueDates: [{ dueDate: "2026-08-31", amount: targetWithLines.value.total, paymentMethod: "BANK_TRANSFER" as const }] };
    const targetScheduled = await replacePurchaseDueDates(targetCreated.value.id, targetDues, actor, context("target-dues", "dues", targetDues)); if (!targetScheduled.ok) throw new Error(targetScheduled.error.code);
    const targetRegistered = await registerPurchase(targetCreated.value.id, { expectedVersion: targetScheduled.value.version }, actor, context("target-register", "register", {})); if (!targetRegistered.ok) throw new Error(targetRegistered.error.code);
    const application = { targetDueDateId: targetRegistered.value.dueDates[0]!.id, applicationDate: "2026-07-21", amount: "60.50", notes: null };
    const applied = await applySupplierCredit(credit.id, application, actor, { idempotencyKey: `supplier-credit-apply-${randomUUID()}`, requestHash: hashSupplierCreditApplication(credit.id, application), correlationId: "supplier-credit-apply" });
    expect(applied).toMatchObject({ ok: true, status: 201, value: { availableAmount: "60.50", appliedAmount: "60.50" } });
    expect(await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: targetCreated.value.id } })).toMatchObject({ paymentStatus: "SETTLED" });
    expect(await prisma.purchaseDueDate.findUniqueOrThrow({ where: { id: targetRegistered.value.dueDates[0]!.id } })).toMatchObject({ status: "SETTLED" });
    expect(await prisma.accountingJournalEntry.count({ where: { purchaseInvoiceId: targetCreated.value.id } })).toBe(1);

    const otherCompany = await prisma.company.create({ data: { legalName: "Otra empresa", taxId: "B87654321" } });
    const foreignBank = await prisma.bankAccount.create({ data: { companyId: otherCompany.id, name: "Cuenta de otra empresa", iban: "ES9121000418450200051332", createdById: actor.id } });
    const invalidBankRefund = { paymentMethod: "BANK_TRANSFER" as const, bankAccountId: foreignBank.id, requestedDate: "2026-07-21", amount: "1.00", reasonCode: "OTHER" as const, reference: null, notes: null };
    expect(await requestSupplierCreditRefund(credit.id, invalidBankRefund, actor, { idempotencyKey: `supplier-credit-refund-usd-${randomUUID()}`, requestHash: hashSupplierCreditRefundRequest(credit.id, invalidBankRefund) })).toMatchObject({ ok: false, error: { code: "SUPPLIER_CREDIT_REFUND_BANK_ACCOUNT_NOT_AVAILABLE" } });
    expect(await prisma.supplierCreditRefund.count()).toBe(0);

    const refund = { paymentMethod: "CASH" as const, bankAccountId: null, requestedDate: "2026-07-21", amount: "60.50", reasonCode: "OPERATION_CANCELLED" as const, reference: null, notes: null };
    const requested = await requestSupplierCreditRefund(credit.id, refund, actor, { idempotencyKey: `supplier-credit-refund-${randomUUID()}`, requestHash: hashSupplierCreditRefundRequest(credit.id, refund), correlationId: "supplier-credit-refund" });
    expect(requested).toMatchObject({ ok: true, status: 201, value: { availableAmount: "0.00", reservedRefundAmount: "60.50" } });
    if (!requested.ok) throw new Error("Refund request failed"); const refundId = requested.value.refunds[0]!.id;
    expect(await approveSupplierCreditRefund(refundId, actor, { idempotencyKey: `supplier-credit-self-approve-${randomUUID()}`, requestHash: hashSupplierCreditRefundAction(refundId, "approve") })).toMatchObject({ ok: false, error: { code: "SUPPLIER_CREDIT_REFUND_SELF_APPROVAL_FORBIDDEN" } });
    expect(await prisma.auditEvent.count({ where: { eventType: "SUPPLIER_CREDIT_REFUND_APPROVAL_DENIED", payload: { path: ["refundId"], equals: refundId } } })).toBe(1);
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: "Administrador" } });
    const checkerRow = await prisma.user.create({ data: { displayName: "Aprobador", userName: "checker", normalizedUserName: "checker", passwordHash: "test-only", roleId: adminRole.id } });
    const checker: SessionUser = { id: checkerRow.id, displayName: checkerRow.displayName, userName: checkerRow.userName, role: { code: adminRole.code, name: adminRole.name }, permissions: actor.permissions };
    const approved = await approveSupplierCreditRefund(refundId, checker, { idempotencyKey: `supplier-credit-approve-${randomUUID()}`, requestHash: hashSupplierCreditRefundAction(refundId, "approve"), correlationId: "supplier-credit-approve" });
    expect(approved).toMatchObject({ ok: true, value: { refunds: [{ status: "APPROVED" }] } });
    const posting = { postingDate: "2026-07-22" };
    const posted = await postSupplierCreditRefund(refundId, posting, actor, { idempotencyKey: `supplier-credit-post-${randomUUID()}`, requestHash: hashSupplierCreditRefundPost(refundId, posting), correlationId: "supplier-credit-post" });
    expect(posted).toMatchObject({ ok: true, value: { availableAmount: "0.00", reservedRefundAmount: "0.00", postedRefundAmount: "60.50", refunds: [{ status: "POSTED", postingDate: "2026-07-22" }] } });
    const refundEntry = await prisma.accountingJournalEntry.findUniqueOrThrow({ where: { supplierCreditRefundId: refundId }, include: { lines: { include: { account: true }, orderBy: { position: "asc" } } } });
    expect(refundEntry.origin).toBe("SUPPLIER_CREDIT_REFUND"); expect(refundEntry.lines.map((line) => [line.account.code, line.debit.toFixed(2), line.credit.toFixed(2)])).toEqual([["570000000", "60.50", "0.00"], [supplier.accountingCode, "0.00", "60.50"]]);
    const withoutAccounting = await getSupplierCredit(credit.id, { ...actor, permissions: actor.permissions.filter((permission) => permission !== "Accounting.View") });
    expect(withoutAccounting?.refunds[0]?.accountingEntry).toBeNull();
    await expect(prisma.supplierCredit.update({ where: { id: credit.id }, data: { originalAmount: "120.00" } })).rejects.toThrow("SUPPLIER_CREDIT_LEDGER_APPEND_ONLY");
  });
});

function configureSecrets() { process.env.SENSITIVE_DATA_ACTIVE_KEY_ID = "test-key"; process.env.SENSITIVE_DATA_KEYS = JSON.stringify({ "test-key": Buffer.alloc(32, 7).toString("base64") }); process.env.SENSITIVE_DATA_LOOKUP_SECRET = "supplier-lookup-secret-at-least-32-characters"; }
function context(key: string, scope: string, value: unknown) { return { idempotencyKey: key, requestHash: purchaseRequestHash(value), correlationId: `test-${key}`, scope }; }
async function initialize() { const raw = JSON.stringify(initialization); const result = await initializePlatform(initialization, randomUUID(), hashRequestBody(raw)); if (!result.ok) throw new Error(result.error.code); const actor = await admin(); const year = await createInitialAccountingFiscalYear(2026, actor); if (!year.ok) throw new Error(year.error.code); return actor; }
async function admin() { const result = await login({ userName: "admin", password }); if (!result.ok) throw new Error(result.error.code); return result.value.user; }
async function supplierFor(actor: Awaited<ReturnType<typeof admin>>) { const command = { legalName: "Proveedor Demo SL", tradeName: null, taxId: "B12345674", fiscalAddressLine: "Calle Mayor 1", fiscalPostalCode: "28001", fiscalCity: "Madrid", fiscalProvince: "Madrid", fiscalCountry: "ES", contactName: null, email: null, phone: null, bankIban: null, bankBic: null, defaultPaymentMethod: "BANK_TRANSFER" as const, paymentTermsType: "IMMEDIATE" as const, paymentDays: null, paymentFixedDay: null, notes: null }; const result = await createSupplier(command, actor, { idempotencyKey: "supplier", requestHash: supplierRequestHash(command), scope: "create" }); if (!result.ok) throw new Error(result.error.code); return result.value; }
async function reset() { await prisma.$executeRawUnsafe('TRUNCATE TABLE "companies", "roles", "permissions", "reserved_user_names", "idempotency_records" RESTART IDENTITY CASCADE'); }
