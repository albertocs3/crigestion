import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";
import { normalizeDateOnlyInput } from "@/modules/billing/application/invoices";

const dateOnlySchema = z.preprocess(
  (value) => (typeof value === "string" ? normalizeDateOnlyInput(value) : value),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidDateOnly, "La fecha no es valida.")
);
const moneySchema = z.string().regex(/^-?\d{1,12}\.\d{2}$/);
const positiveMoneySchema = z.string().regex(/^\d{1,12}\.\d{2}$/).refine((value) => new Prisma.Decimal(value).gt(0));

export const createBankAccountSchema = z.object({
  name: z.string().trim().min(2).max(120),
  iban: z.preprocess(
    (value) => typeof value === "string" ? value.trim().toUpperCase().replace(/\s+/g, "") : value,
    z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/).refine(isValidIban, "El IBAN no es valido.")
  ),
  currency: z.literal("EUR").default("EUR")
});

export const createBankMovementSchema = z.object({
  bankAccountId: z.string().uuid(),
  bookingDate: dateOnlySchema,
  valueDate: dateOnlySchema.optional(),
  amount: moneySchema.refine((value) => !new Prisma.Decimal(value).isZero(), "El importe no puede ser cero."),
  currency: z.literal("EUR").default("EUR"),
  reference: z.string().trim().max(140).optional(),
  counterpartyName: z.string().trim().max(200).optional(),
  externalMovementNumber: z.string().trim().max(120).optional()
});

export const listBankMovementsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().uuid().optional(),
  bankAccountId: z.string().uuid().optional(),
  status: z.enum(["ALL", "PENDING", "PARTIALLY_RECONCILED", "RECONCILED"]).default("ALL"),
  dateFrom: dateOnlySchema.optional(),
  dateTo: dateOnlySchema.optional(),
  search: z.string().trim().min(1).max(120).optional()
}).superRefine((value, context) => {
  if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) context.addIssue({ code: z.ZodIssueCode.custom, path: ["dateTo"], message: "La fecha final no puede ser anterior a la inicial." });
});

export const listReconciliationCandidatesSchema = z.object({
  movementId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().min(1).max(120).optional(),
  paymentDateFrom: dateOnlySchema.optional(),
  paymentDateTo: dateOnlySchema.optional()
});

export const listReconciliationProposalsSchema = z.object({
  movementId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(25).default(10)
});

export const createBankReconciliationSchema = z.object({
  bankMovementId: z.string().uuid(),
  applications: z.array(z.object({
    customerPaymentId: z.string().uuid(),
    amount: positiveMoneySchema
  })).min(1).max(100)
}).superRefine((value, context) => {
  const ids = value.applications.map((application) => application.customerPaymentId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["applications"], message: "No se puede repetir un cobro." });
  }
});

export type BankAccountDto = { id: string; name: string; maskedIban: string; currency: string; status: "ACTIVE" | "INACTIVE" };
export type BankMovementDto = {
  id: string;
  bankAccount: BankAccountDto;
  bookingDate: string;
  valueDate: string | null;
  amount: string;
  reference: string | null;
  counterpartyName: string | null;
  externalMovementNumber: string | null;
  reconciledAmount: string;
  pendingAmount: string;
  status: "PENDING" | "PARTIALLY_RECONCILED" | "RECONCILED";
  activeReconciliations: Array<{ id: string; amount: string }>;
};
export type ReconciliationCandidateDto = {
  paymentId: string;
  paymentDate: string;
  invoiceId: string;
  invoiceNumber: string | null;
  customerCode: string;
  customerName: string;
  amount: string;
  reconciledAmount: string;
  availableAmount: string;
};
export type ReconciliationProposalDto = ReconciliationCandidateDto & {
  score: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  dateDifferenceDays: number;
  suggestedAmount: string;
  reasons: string[];
};

type MutationContext = { correlationId?: string; idempotencyKey: string; requestHash: string; operation: string; resourceId?: string };
type MutationError = { ok: false; status: 404 | 409; error: { code: string; message: string } };

export async function listBankAccounts(actor: SessionUser): Promise<{ bankAccounts: BankAccountDto[] }> {
  const installation = await prisma.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } });
  const records = installation?.companyId ? await prisma.bankAccount.findMany({ where: { companyId: installation.companyId }, orderBy: [{ status: "asc" }, { name: "asc" }], select: { id: true, name: true, iban: true, currency: true, status: true } }) : [];
  await audit("BANK_ACCOUNTS_VIEWED", actor, { count: records.length });
  return { bankAccounts: records.map(mapBankAccount) };
}

export async function createBankAccount(command: z.infer<typeof createBankAccountSchema>, actor: SessionUser, context: MutationContext): Promise<{ ok: true; status: 200 | 201; value: BankAccountDto } | MutationError> {
  return executeMutation(actor, context, async (tx) => {
    const replay = await replayMutation<BankAccountDto>(tx, actor, context);
    if (replay) return replay;
    const installation = await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } });
    if (!installation?.companyId) return conflict("BANK_ACCOUNT_COMPANY_NOT_AVAILABLE", "No hay empresa configurada.");
    const existing = await tx.bankAccount.findUnique({ where: { companyId_iban: { companyId: installation.companyId, iban: command.iban } } });
    if (existing) return conflict("BANK_ACCOUNT_ALREADY_EXISTS", "La cuenta bancaria ya existe.");
    const account = await tx.bankAccount.create({ data: { companyId: installation.companyId, name: command.name, iban: command.iban, currency: command.currency, createdById: actor.id }, select: { id: true, name: true, iban: true, currency: true, status: true } });
    const value = mapBankAccount(account);
    await persistMutation(tx, actor, context, 201, value);
    await auditTx(tx, "BANK_ACCOUNT_CREATED", actor, { bankAccountId: account.id, currency: account.currency, correlationId: context.correlationId });
    return { ok: true as const, status: 201 as const, value };
  }, undefined, () => conflict("BANK_ACCOUNT_ALREADY_EXISTS", "La cuenta bancaria ya existe."));
}

export async function createBankMovement(command: z.infer<typeof createBankMovementSchema>, actor: SessionUser, context: MutationContext): Promise<{ ok: true; status: 200 | 201; value: BankMovementDto } | MutationError> {
  return executeMutation(actor, context, async (tx) => {
    const replay = await replayMutation<BankMovementDto>(tx, actor, context);
    if (replay) return replay;
    const companyId = await currentCompanyId(tx);
    if (!companyId) return conflict("BANK_ACCOUNT_COMPANY_NOT_AVAILABLE", "No hay empresa configurada.");
    const account = await tx.bankAccount.findFirst({ where: { id: command.bankAccountId, companyId, status: "ACTIVE" }, select: { id: true, companyId: true, currency: true } });
    if (!account) return notFound("BANK_ACCOUNT_NOT_FOUND", "La cuenta bancaria no existe o esta inactiva.");
    if (account.currency !== command.currency) return conflict("BANK_MOVEMENT_CURRENCY_MISMATCH", "La moneda no coincide con la cuenta.");
    if (command.externalMovementNumber) {
      const duplicate = await tx.bankMovement.findFirst({ where: { bankAccountId: account.id, externalMovementNumber: command.externalMovementNumber }, select: { id: true } });
      if (duplicate) return conflict("BANK_MOVEMENT_ALREADY_EXISTS", "El numero de movimiento ya existe para la cuenta.");
    }
    const movement = await tx.bankMovement.create({ data: { bankAccountId: account.id, bookingDate: parseDate(command.bookingDate), valueDate: command.valueDate ? parseDate(command.valueDate) : null, amount: new Prisma.Decimal(command.amount), currency: command.currency, reference: command.reference || null, counterpartyName: command.counterpartyName || null, externalMovementNumber: command.externalMovementNumber || null, createdById: actor.id }, select: movementSelect });
    const value = mapBankMovement(movement);
    await persistMutation(tx, actor, context, 201, value);
    await auditTx(tx, "BANK_MOVEMENT_CREATED", actor, { bankMovementId: movement.id, bankAccountId: account.id, bookingDate: command.bookingDate, amount: command.amount, currency: command.currency, correlationId: context.correlationId });
    return { ok: true as const, status: 201 as const, value };
  }, undefined, () => conflict("BANK_MOVEMENT_ALREADY_EXISTS", "El numero de movimiento ya existe para la cuenta."));
}

export async function listBankMovements(command: z.infer<typeof listBankMovementsSchema>, actor: SessionUser): Promise<{ bankMovements: BankMovementDto[]; nextCursor: string | null }> {
  const companyId = await currentCompanyId(prisma);
  if (!companyId) return { bankMovements: [], nextCursor: null };
  const matches: BankMovementDto[] = [];
  let cursor = command.cursor;
  let exhausted = false;
  while (matches.length <= command.limit && !exhausted) {
    const records = await prisma.bankMovement.findMany({ where: { bankAccount: { companyId }, ...(command.bankAccountId ? { bankAccountId: command.bankAccountId } : {}), ...(command.dateFrom || command.dateTo ? { bookingDate: { ...(command.dateFrom ? { gte: parseDate(command.dateFrom) } : {}), ...(command.dateTo ? { lte: parseDate(command.dateTo) } : {}) } } : {}), ...(command.search ? { OR: [{ reference: { contains: command.search, mode: "insensitive" } }, { counterpartyName: { contains: command.search, mode: "insensitive" } }, { externalMovementNumber: { contains: command.search, mode: "insensitive" } }] } : {}) }, orderBy: [{ bookingDate: "desc" }, { id: "desc" }], take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: movementSelect });
    exhausted = records.length < 100;
    for (const record of records) {
      cursor = record.id;
      const movement = mapBankMovement(record);
      if (command.status === "ALL" || movement.status === command.status) matches.push(movement);
      if (matches.length > command.limit) break;
    }
  }
  const hasMore = matches.length > command.limit;
  const bankMovements = matches.slice(0, command.limit);
  await audit("BANK_MOVEMENTS_VIEWED", actor, { count: bankMovements.length, status: command.status });
  return { bankMovements, nextCursor: hasMore ? bankMovements.at(-1)?.id ?? null : null };
}

export async function listReconciliationCandidates(command: z.infer<typeof listReconciliationCandidatesSchema>, actor: SessionUser, options: { audit?: boolean } = {}): Promise<{ movement: BankMovementDto | null; candidates: ReconciliationCandidateDto[] }> {
  const companyId = await currentCompanyId(prisma);
  const movement = companyId ? await prisma.bankMovement.findFirst({ where: { id: command.movementId, bankAccount: { companyId } }, select: movementSelect }) : null;
  if (!movement || movement.amount.lt(0)) return { movement: movement ? mapBankMovement(movement) : null, candidates: [] };
  const candidates: ReconciliationCandidateDto[] = [];
  let paymentCursor: string | undefined;
  let exhausted = false;
  while (candidates.length < command.limit && !exhausted) {
    const payments = await prisma.customerPayment.findMany({ where: { invoice: { status: { in: ["ISSUED", "RECTIFIED"] } }, ...(command.paymentDateFrom || command.paymentDateTo ? { paymentDate: { ...(command.paymentDateFrom ? { gte: parseDate(command.paymentDateFrom) } : {}), ...(command.paymentDateTo ? { lte: parseDate(command.paymentDateTo) } : {}) } } : {}), ...(command.search ? { OR: [{ invoice: { number: { contains: command.search, mode: "insensitive" } } }, { invoice: { customerLegalNameSnapshot: { contains: command.search, mode: "insensitive" } } }, { invoice: { customerCodeSnapshot: { contains: command.search, mode: "insensitive" } } }] } : {}) }, orderBy: [{ paymentDate: "desc" }, { id: "desc" }], take: 100, ...(paymentCursor ? { cursor: { id: paymentCursor }, skip: 1 } : {}), select: { id: true, paymentDate: true, amount: true, invoiceId: true, invoice: { select: { number: true, customerCodeSnapshot: true, customerLegalNameSnapshot: true } }, returns: { select: { amount: true } }, reconciliationApplications: { where: { reconciliation: { status: "ACTIVE" } }, select: { amount: true } } } });
    exhausted = payments.length < 100;
    for (const payment of payments) {
      paymentCursor = payment.id;
      const net = Prisma.Decimal.max(0, payment.amount.minus(sum(payment.returns)));
      const reconciled = sum(payment.reconciliationApplications);
      const available = Prisma.Decimal.max(0, net.minus(reconciled));
      if (available.gt(0)) candidates.push({ paymentId: payment.id, paymentDate: formatDate(payment.paymentDate), invoiceId: payment.invoiceId, invoiceNumber: payment.invoice.number, customerCode: payment.invoice.customerCodeSnapshot, customerName: payment.invoice.customerLegalNameSnapshot, amount: net.toFixed(2), reconciledAmount: reconciled.toFixed(2), availableAmount: available.toFixed(2) });
      if (candidates.length === command.limit) break;
    }
  }
  if (options.audit !== false) await audit("BANK_RECONCILIATION_CANDIDATES_VIEWED", actor, { bankMovementId: command.movementId, count: candidates.length });
  return { movement: mapBankMovement(movement), candidates };
}

export async function listReconciliationProposals(command: z.infer<typeof listReconciliationProposalsSchema>, actor: SessionUser): Promise<{ movement: BankMovementDto | null; proposals: ReconciliationProposalDto[] }> {
  const companyId = await currentCompanyId(prisma);
  const movementRecord = companyId ? await prisma.bankMovement.findFirst({ where: { id: command.movementId, bankAccount: { companyId } }, select: { bookingDate: true } }) : null;
  if (!movementRecord) return { movement: null, proposals: [] };
  const from = new Date(movementRecord.bookingDate); from.setUTCDate(from.getUTCDate() - 30);
  const to = new Date(movementRecord.bookingDate); to.setUTCDate(to.getUTCDate() + 30);
  const result = await listReconciliationCandidates({ movementId: command.movementId, limit: 500, paymentDateFrom: formatDate(from), paymentDateTo: formatDate(to) }, actor, { audit: false });
  if (!result.movement) return { movement: null, proposals: [] };
  const proposals = result.candidates
    .map((candidate) => scoreReconciliationProposal(result.movement!, candidate))
    .filter((proposal): proposal is ReconciliationProposalDto => proposal !== null)
    .sort((left, right) => right.score - left.score || left.dateDifferenceDays - right.dateDifferenceDays || new Prisma.Decimal(right.availableAmount).cmp(left.availableAmount) || left.paymentId.localeCompare(right.paymentId))
    .slice(0, command.limit);
  await audit("BANK_RECONCILIATION_PROPOSALS_VIEWED", actor, { bankMovementId: command.movementId, proposalCount: proposals.length, topScore: proposals[0]?.score ?? null });
  return { movement: result.movement, proposals };
}

export function scoreReconciliationProposal(movement: BankMovementDto, candidate: ReconciliationCandidateDto): ReconciliationProposalDto | null {
  const movementDate = Date.parse(`${movement.bookingDate}T00:00:00.000Z`);
  const paymentDate = Date.parse(`${candidate.paymentDate}T00:00:00.000Z`);
  const dateDifferenceDays = Math.abs(Math.round((movementDate - paymentDate) / 86_400_000));
  if (dateDifferenceDays > 30) return null;
  const pending = new Prisma.Decimal(movement.pendingAmount);
  const available = new Prisma.Decimal(candidate.availableAmount);
  const reasons: string[] = [];
  let score = 0;
  if (!available.eq(pending)) return null;
  score += 60; reasons.push("Importe exacto");
  const dateScore = Math.max(0, 20 - Math.floor(dateDifferenceDays / 2));
  score += dateScore;
  reasons.push(dateDifferenceDays === 0 ? "Misma fecha" : `Fechas separadas ${dateDifferenceDays} dias`);
  const haystack = normalizeProposalText(`${movement.reference ?? ""} ${movement.counterpartyName ?? ""}`);
  const invoiceNumber = normalizeProposalText(candidate.invoiceNumber ?? "");
  const customerCode = normalizeProposalText(candidate.customerCode);
  const customerName = normalizeProposalText(candidate.customerName);
  const invoiceCompact = invoiceNumber.replace(/\s+/g, "");
  if (invoiceCompact.length >= 4 && haystack.replace(/\s+/g, "").includes(invoiceCompact)) { score += 15; reasons.push("Numero de factura en la referencia"); }
  const haystackTokens = new Set(haystack.split(" "));
  const nameTokens = customerName.split(" ").filter((token) => token.length >= 5 && !["SOCIEDAD", "LIMITADA", "ANONIMA", "EMPRESA"].includes(token));
  if ((customerCode.length >= 3 && haystackTokens.has(customerCode)) || (nameTokens.length >= 2 && nameTokens.every((token) => haystackTokens.has(token)))) { score += 5; reasons.push("Identidad del cliente coincidente"); }
  score = Math.min(100, score);
  const hasIdentitySignal = reasons.includes("Numero de factura en la referencia") || reasons.includes("Identidad del cliente coincidente");
  return { ...candidate, score, confidence: score >= 80 && hasIdentitySignal ? "HIGH" : score >= 65 ? "MEDIUM" : "LOW", dateDifferenceDays, suggestedAmount: Prisma.Decimal.min(pending, available).toFixed(2), reasons };
}

export async function createBankReconciliation(command: z.infer<typeof createBankReconciliationSchema>, actor: SessionUser, context: MutationContext): Promise<{ ok: true; status: 200 | 201; value: BankMovementDto } | MutationError> {
  return executeMutation(actor, context, async (tx) => {
    const replay = await replayMutation<BankMovementDto>(tx, actor, context);
    if (replay) return replay;
    const companyId = await currentCompanyId(tx);
    if (!companyId) return notFound("BANK_MOVEMENT_NOT_FOUND", "El movimiento bancario no existe.");
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "bank_movements" WHERE "id" = ${command.bankMovementId}::uuid FOR UPDATE`);
    const paymentIds = [...command.applications.map((application) => application.customerPaymentId)].sort();
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "customer_payments" WHERE "id" IN (${Prisma.join(paymentIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR UPDATE`);
    const movement = await tx.bankMovement.findFirst({ where: { id: command.bankMovementId, bankAccount: { companyId } }, select: movementSelect });
    if (!movement) return notFound("BANK_MOVEMENT_NOT_FOUND", "El movimiento bancario no existe.");
    if (movement.amount.lte(0)) return conflict("BANK_MOVEMENT_NOT_RECONCILABLE", "Solo se concilian entradas bancarias con cobros de clientes.");
    const movementPending = movement.amount.abs().minus(activeApplications(movement));
    const requested = command.applications.reduce((total, application) => total.plus(application.amount), new Prisma.Decimal(0));
    if (requested.gt(movementPending)) return conflict("BANK_MOVEMENT_AMOUNT_EXCEEDED", "La conciliacion supera el saldo pendiente del movimiento.");
    const payments = await tx.customerPayment.findMany({ where: { id: { in: paymentIds } }, select: { id: true, amount: true, returns: { select: { amount: true } }, reconciliationApplications: { where: { reconciliation: { status: "ACTIVE" } }, select: { amount: true } } } });
    if (payments.length !== paymentIds.length) return notFound("RECONCILIATION_TARGET_NOT_FOUND", "Alguno de los cobros no existe.");
    const paymentById = new Map(payments.map((payment) => [payment.id, payment]));
    for (const application of command.applications) {
      const payment = paymentById.get(application.customerPaymentId)!;
      const available = payment.amount.minus(sum(payment.returns)).minus(sum(payment.reconciliationApplications));
      if (new Prisma.Decimal(application.amount).gt(available)) return conflict("RECONCILIATION_TARGET_AMOUNT_EXCEEDED", "La conciliacion supera el saldo disponible de un cobro.");
    }
    await tx.bankReconciliation.create({ data: { bankMovementId: movement.id, createdById: actor.id, correlationId: context.correlationId, applications: { create: command.applications.map((application) => ({ customerPaymentId: application.customerPaymentId, amount: new Prisma.Decimal(application.amount) })) } } });
    const updated = await tx.bankMovement.findUniqueOrThrow({ where: { id: movement.id }, select: movementSelect });
    const value = mapBankMovement(updated);
    await persistMutation(tx, actor, context, 201, value);
    await auditTx(tx, "BANK_RECONCILIATION_CREATED", actor, { bankMovementId: movement.id, applicationCount: command.applications.length, amount: requested.toFixed(2), correlationId: context.correlationId });
    return { ok: true as const, status: 201 as const, value };
  }, Prisma.TransactionIsolationLevel.Serializable);
}

export async function undoBankReconciliation(reconciliationId: string, actor: SessionUser, context: MutationContext): Promise<{ ok: true; status: 200 | 201; value: BankMovementDto } | MutationError> {
  return executeMutation(actor, context, async (tx) => {
    const replay = await replayMutation<BankMovementDto>(tx, actor, context);
    if (replay) return replay;
    const companyId = await currentCompanyId(tx);
    if (!companyId) return notFound("BANK_RECONCILIATION_NOT_FOUND", "La conciliacion no existe.");
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "bank_reconciliations" WHERE "id" = ${reconciliationId}::uuid FOR UPDATE`);
    const reconciliation = await tx.bankReconciliation.findFirst({ where: { id: reconciliationId, bankMovement: { bankAccount: { companyId } } }, select: { id: true, status: true, bankMovementId: true } });
    if (!reconciliation) return notFound("BANK_RECONCILIATION_NOT_FOUND", "La conciliacion no existe.");
    if (reconciliation.status === "UNDONE") return conflict("BANK_RECONCILIATION_ALREADY_UNDONE", "La conciliacion ya esta deshecha.");
    await tx.bankReconciliation.update({ where: { id: reconciliation.id }, data: { status: "UNDONE", undoneById: actor.id, undoneAt: new Date() } });
    const movement = await tx.bankMovement.findUniqueOrThrow({ where: { id: reconciliation.bankMovementId }, select: movementSelect });
    const value = mapBankMovement(movement);
    await persistMutation(tx, actor, context, 200, value);
    await auditTx(tx, "BANK_RECONCILIATION_UNDONE", actor, { bankReconciliationId: reconciliation.id, bankMovementId: reconciliation.bankMovementId, correlationId: context.correlationId });
    return { ok: true as const, status: 200 as const, value };
  }, Prisma.TransactionIsolationLevel.Serializable);
}

const movementSelect = { id: true, bookingDate: true, valueDate: true, amount: true, reference: true, counterpartyName: true, externalMovementNumber: true, bankAccount: { select: { id: true, name: true, iban: true, currency: true, status: true } }, reconciliations: { where: { status: "ACTIVE" }, select: { id: true, applications: { select: { amount: true } } } } } satisfies Prisma.BankMovementSelect;
type MovementRecord = Prisma.BankMovementGetPayload<{ select: typeof movementSelect }>;

function mapBankAccount(account: { id: string; name: string; iban: string; currency: string; status: "ACTIVE" | "INACTIVE" }): BankAccountDto { return { id: account.id, name: account.name, maskedIban: `${account.iban.slice(0, 4)} **** **** ${account.iban.slice(-4)}`, currency: account.currency, status: account.status }; }
function activeApplications(movement: MovementRecord): Prisma.Decimal { return movement.reconciliations.flatMap((reconciliation) => reconciliation.applications).reduce((total, application) => total.plus(application.amount), new Prisma.Decimal(0)); }
function mapBankMovement(movement: MovementRecord): BankMovementDto { const reconciled = activeApplications(movement); const total = movement.amount.abs(); const pending = Prisma.Decimal.max(0, total.minus(reconciled)); const status = reconciled.isZero() ? "PENDING" : pending.isZero() ? "RECONCILED" : "PARTIALLY_RECONCILED"; return { id: movement.id, bankAccount: mapBankAccount(movement.bankAccount), bookingDate: formatDate(movement.bookingDate), valueDate: movement.valueDate ? formatDate(movement.valueDate) : null, amount: movement.amount.toFixed(2), reference: movement.reference, counterpartyName: movement.counterpartyName, externalMovementNumber: movement.externalMovementNumber, reconciledAmount: reconciled.toFixed(2), pendingAmount: pending.toFixed(2), status, activeReconciliations: movement.reconciliations.map((reconciliation) => ({ id: reconciliation.id, amount: sum(reconciliation.applications).toFixed(2) })) }; }
function sum(records: Array<{ amount: Prisma.Decimal }>): Prisma.Decimal { return records.reduce((total, record) => total.plus(record.amount), new Prisma.Decimal(0)); }
function parseDate(value: string): Date { return new Date(`${value}T00:00:00.000Z`); }
function formatDate(value: Date): string { return value.toISOString().slice(0, 10); }
function isValidDateOnly(value: string): boolean { const date = parseDate(value); return !Number.isNaN(date.getTime()) && formatDate(date) === value; }
function isValidIban(value: string): boolean {
  const rearranged = `${value.slice(4)}${value.slice(0, 4)}`;
  const numeric = [...rearranged].map((character) => /\d/.test(character) ? character : String(character.charCodeAt(0) - 55)).join("");
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}
function normalizeProposalText(value: string): string { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim(); }
function scopedKey(actor: SessionUser, context: MutationContext): string { return `v1:banking:${createHash("sha256").update(`${actor.id}:${context.operation}:${context.resourceId ?? "collection"}:${context.idempotencyKey}`).digest("hex")}`; }
async function currentCompanyId(client: Pick<Prisma.TransactionClient, "installation">): Promise<string | null> { const installation = await client.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }); return installation?.companyId ?? null; }
function notFound(code: string, message: string): MutationError { return { ok: false, status: 404, error: { code, message } }; }
function conflict(code: string, message: string): MutationError { return { ok: false, status: 409, error: { code, message } }; }
async function replayMutation<T>(tx: Prisma.TransactionClient, actor: SessionUser, context: MutationContext): Promise<{ ok: true; status: 200 | 201; value: T } | MutationError | null> { const record = await tx.idempotencyRecord.findUnique({ where: { key: scopedKey(actor, context) } }); if (!record) return null; if (record.requestHash !== context.requestHash) return conflict("IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion."); return { ok: true, status: record.responseStatus as 200 | 201, value: record.responseBody as unknown as T }; }
async function persistMutation<T>(tx: Prisma.TransactionClient, actor: SessionUser, context: MutationContext, status: number, value: T): Promise<void> { await tx.idempotencyRecord.create({ data: { key: scopedKey(actor, context), requestHash: context.requestHash, responseStatus: status, responseBody: value as unknown as Prisma.InputJsonValue } }); }
async function executeMutation<T>(actor: SessionUser, context: MutationContext, work: (tx: Prisma.TransactionClient) => Promise<T>, isolationLevel?: Prisma.TransactionIsolationLevel, uniqueConflict?: () => T): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(work, isolationLevel ? { isolationLevel } : undefined);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 2) continue;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const record = await prisma.idempotencyRecord.findUnique({ where: { key: scopedKey(actor, context) } });
        if (record) {
          if (record.requestHash !== context.requestHash) return conflict("IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.") as T;
          return { ok: true, status: record.responseStatus as 200 | 201, value: record.responseBody as unknown } as T;
        }
        if (uniqueConflict) return uniqueConflict();
      }
      throw error;
    }
  }
  throw new Error("No se pudo completar la transaccion bancaria tras varios reintentos.");
}
async function audit(eventType: string, actor: SessionUser, payload: Record<string, unknown>): Promise<void> { await prisma.auditEvent.create({ data: { eventType, actorType: "USER", payload: { actorUserId: actor.id, ...payload } as Prisma.InputJsonValue } }); }
async function auditTx(tx: Prisma.TransactionClient, eventType: string, actor: SessionUser, payload: Record<string, unknown>): Promise<void> { await tx.auditEvent.create({ data: { eventType, actorType: "USER", payload: { actorUserId: actor.id, ...payload } as Prisma.InputJsonValue } }); }
