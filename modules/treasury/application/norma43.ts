import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";
import { lockOpenFiscalYearForDatedMutation } from "@/modules/accounting/application/fiscalYearMutationBarrier";

const maxFileBytes = 5 * 1024 * 1024;
const maxRecords = 50_000;

export const norma43FileSchema = z.object({
  bankAccountId: z.string().uuid(),
  contentBase64: z.string().min(1).max(Math.ceil(maxFileBytes * 4 / 3) + 16)
});

export type Norma43Movement = { ordinal: number; bookingDate: string; valueDate: string; amount: string; documentNumber: string; reference: string; concept: string };
export type Norma43Parsed = { rawSha256: string; entity: string; office: string; accountNumber: string; dateFrom: string; dateTo: string; openingBalance: string; closingBalance: string; currency: "EUR"; recordCount: number; movements: Norma43Movement[] };
export type Norma43Preview = Norma43Parsed & { bankAccountId: string; maskedIban: string; overlap: boolean; duplicate: boolean };
type Norma43Result<T> = { ok: true; status: 200 | 201; value: T } | { ok: false; status: 404 | 409 | 413 | 422; error: { code: string; message: string } };

export function parseNorma43Bytes(bytes: Uint8Array): Norma43Result<Norma43Parsed> {
  try {
    return parseNorma43BytesUnsafe(bytes);
  } catch (error: unknown) {
    if (error instanceof Norma43FieldError) return failure(422, "N43_RECORD_INVALID", "Un campo numerico del fichero no es valido.");
    throw error;
  }
}

function parseNorma43BytesUnsafe(bytes: Uint8Array): Norma43Result<Norma43Parsed> {
  if (bytes.byteLength > maxFileBytes) return failure(413, "N43_FILE_TOO_LARGE", "El fichero supera 5 MiB.");
  if (bytes.some((byte) => byte === 0)) return failure(422, "N43_ENCODING_UNSUPPORTED", "El fichero contiene datos binarios no admitidos.");
  if (bytes.some((byte) => byte !== 10 && byte !== 13 && byte !== 165 && (byte < 32 || byte > 126))) return failure(422, "N43_ENCODING_UNSUPPORTED", "El fichero contiene caracteres fuera del perfil ASCII admitido.");
  const rawSha256 = createHash("sha256").update(bytes).digest("hex");
  const text = Buffer.from(bytes).toString("latin1");
  const lines = text.split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ""));
  if (lines.length < 4 || lines.length > maxRecords || lines.some((line) => line.length !== 80)) return failure(422, "N43_RECORD_INVALID", "Todos los registros deben tener exactamente 80 bytes.");
  if (lines[0]!.slice(0, 2) !== "11" || lines.at(-1)!.slice(0, 2) !== "88") return failure(422, "N43_STRUCTURE_INVALID", "El fichero debe comenzar por 11 y finalizar por 88.");
  if (lines.filter((line) => line.startsWith("11")).length !== 1 || lines.filter((line) => line.startsWith("33")).length !== 1) return failure(422, "N43_PROFILE_NOT_SUPPORTED", "Este corte admite exactamente una cuenta por fichero.");

  const header = lines[0]!;
  const entity = numeric(header, 2, 6); const office = numeric(header, 6, 10); const accountNumber = numeric(header, 10, 20);
  const dateFrom = parseShortDate(numeric(header, 20, 26)); const dateTo = parseShortDate(numeric(header, 26, 32));
  if (!dateFrom || !dateTo || dateFrom > dateTo) return failure(422, "N43_DATE_RANGE_INVALID", "El rango de fechas de cabecera no es valido.");
  if (header.slice(47, 50) !== "978") return failure(422, "N43_CURRENCY_UNSUPPORTED", "Solo se admiten extractos en euros (978).");
  const openingBalance = signedAmount(header.slice(32, 33), numeric(header, 33, 47), true);
  const modality = numeric(header, 50, 51);
  if (!/^[123]$/.test(modality)) return failure(422, "N43_RECORD_INVALID", "La modalidad debe ser 1, 2 o 3.");
  if (!openingBalance) return failure(422, "N43_RECORD_INVALID", "El saldo inicial no es valido.");

  const movements: Norma43Movement[] = [];
  let current: Norma43Movement | null = null;
  let complementCount = 0;
  let endRecord: string | null = null;
  for (let index = 1; index < lines.length - 1; index += 1) {
    const line = lines[index]!; const code = line.slice(0, 2);
    if (code === "22") {
      if (endRecord) return failure(422, "N43_STRUCTURE_INVALID", "Hay movimientos despues del cierre de cuenta.");
      if (line.slice(2, 6) !== " ".repeat(4)) return failure(422, "N43_RECORD_INVALID", "Las posiciones libres del registro 22 deben estar en blanco.");
      const originOffice = line.slice(6, 10);
      if ((modality === "1" && originOffice !== " ".repeat(4)) || (modality !== "1" && !/^\d{4}$/.test(originOffice))) return failure(422, "N43_RECORD_INVALID", "La oficina de origen no corresponde a la modalidad del extracto.");
      const bookingDate = parseShortDate(numeric(line, 10, 16)); const valueDate = parseShortDate(numeric(line, 16, 22));
      const amount = signedAmount(line.slice(27, 28), numeric(line, 28, 42), false);
      if (!bookingDate || !valueDate || !amount || bookingDate < dateFrom || bookingDate > dateTo) return failure(422, "N43_RECORD_INVALID", `Movimiento no valido en el registro ${index + 1}.`);
      current = { ordinal: movements.length + 1, bookingDate, valueDate, amount: amount.toFixed(2), documentNumber: numeric(line, 42, 52), reference: `${numeric(line, 52, 64)} ${line.slice(64, 80).trim()}`.trim(), concept: "" };
      movements.push(current);
      complementCount = 0;
    } else if (code === "23") {
      if (!current || endRecord) return failure(422, "N43_STRUCTURE_INVALID", "Registro 23 sin movimiento principal anterior.");
      complementCount += 1;
      if (complementCount > 5) return failure(422, "N43_STRUCTURE_INVALID", "Un movimiento no puede tener mas de cinco registros 23.");
      const sequence = numeric(line, 2, 4);
      if (!/^(0[1-5])$/.test(sequence)) return failure(422, "N43_RECORD_INVALID", "La secuencia complementaria debe estar entre 01 y 05.");
      current.concept = `${current.concept} ${line.slice(4, 42).trim()} ${line.slice(42, 80).trim()}`.trim().slice(0, 500);
    } else if (code === "33") {
      if (endRecord || movements.length === 0) return failure(422, "N43_STRUCTURE_INVALID", "Cierre de cuenta duplicado o sin movimientos.");
      endRecord = line;
    } else return failure(422, "N43_STRUCTURE_INVALID", `Tipo de registro ${code} no admitido.`);
  }
  if (!endRecord) return failure(422, "N43_STRUCTURE_INVALID", "Falta el registro 33 de cierre de cuenta.");
  if (endRecord.slice(2, 20) !== `${entity}${office}${accountNumber}`) return failure(422, "N43_ACCOUNT_MISMATCH", "La cuenta de cierre no coincide con la cabecera.");
  const debitCount = Number(numeric(endRecord, 20, 25)); const debitTotal = decimalFromDigits(numeric(endRecord, 25, 39));
  const creditCount = Number(numeric(endRecord, 39, 44)); const creditTotal = decimalFromDigits(numeric(endRecord, 44, 58));
  const closingBalance = signedAmount(endRecord.slice(58, 59), numeric(endRecord, 59, 73), true);
  if (!closingBalance || endRecord.slice(73, 76) !== "978") return failure(422, "N43_RECORD_INVALID", "El cierre de cuenta no es valido.");
  const debits = movements.filter((movement) => new Prisma.Decimal(movement.amount).lt(0)); const credits = movements.filter((movement) => new Prisma.Decimal(movement.amount).gt(0));
  const actualDebit = debits.reduce((total, movement) => total.plus(new Prisma.Decimal(movement.amount).abs()), new Prisma.Decimal(0));
  const actualCredit = credits.reduce((total, movement) => total.plus(movement.amount), new Prisma.Decimal(0));
  if (debitCount !== debits.length || creditCount !== credits.length || !debitTotal.eq(actualDebit) || !creditTotal.eq(actualCredit)) return failure(422, "N43_CONTROL_TOTAL_MISMATCH", "Los conteos o totales del registro 33 no cuadran.");
  if (!openingBalance.plus(actualCredit).minus(actualDebit).eq(closingBalance)) return failure(422, "N43_BALANCE_MISMATCH", "El saldo final no coincide con el inicial y los movimientos.");
  const fileEnd = lines.at(-1)!;
  if (fileEnd.slice(2, 20) !== "9".repeat(18) || Number(numeric(fileEnd, 20, 26)) !== lines.length - 1) return failure(422, "N43_CONTROL_TOTAL_MISMATCH", "El total de registros del 88 no coincide.");
  return { ok: true, status: 200, value: { rawSha256, entity, office, accountNumber, dateFrom, dateTo, openingBalance: openingBalance.toFixed(2), closingBalance: closingBalance.toFixed(2), currency: "EUR", recordCount: lines.length, movements } };
}

export async function previewNorma43(command: z.infer<typeof norma43FileSchema>, actor: SessionUser): Promise<Norma43Result<Norma43Preview>> {
  const decoded = decode(command.contentBase64); if (!decoded.ok) return decoded;
  const parsed = parseNorma43Bytes(decoded.value); if (!parsed.ok) return parsed;
  const installation = await prisma.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } });
  const account = installation?.companyId ? await prisma.bankAccount.findFirst({ where: { id: command.bankAccountId, companyId: installation.companyId, status: "ACTIVE" }, select: { id: true, companyId: true, iban: true, currency: true } }) : null;
  if (!account) return failure(404, "BANK_ACCOUNT_NOT_FOUND", "La cuenta bancaria no existe o esta inactiva.");
  if (!matchesSpanishIban(account.iban, parsed.value)) return failure(422, "N43_ACCOUNT_MISMATCH", "La cuenta del fichero no coincide con la seleccionada.");
  const [duplicate, overlap] = await Promise.all([
    prisma.bankStatement.findFirst({ where: { companyId: account.companyId, rawSha256: parsed.value.rawSha256 }, select: { id: true } }),
    prisma.bankStatement.findFirst({ where: { bankAccountId: account.id, dateFrom: { lte: parseDate(parsed.value.dateTo) }, dateTo: { gte: parseDate(parsed.value.dateFrom) } }, select: { id: true } })
  ]);
  await prisma.auditEvent.create({ data: { eventType: "BANK_STATEMENT_PREVIEWED", actorType: "USER", payload: { actorUserId: actor.id, bankAccountId: account.id, rawSha256: parsed.value.rawSha256, recordCount: parsed.value.recordCount, movementCount: parsed.value.movements.length, duplicate: Boolean(duplicate), overlap: Boolean(overlap) } } });
  return { ok: true, status: 200, value: { ...parsed.value, bankAccountId: account.id, maskedIban: `${account.iban.slice(0, 4)} **** **** ${account.iban.slice(-4)}`, duplicate: Boolean(duplicate), overlap: Boolean(overlap) } };
}

export async function importNorma43(command: z.infer<typeof norma43FileSchema>, actor: SessionUser, context: { correlationId?: string; idempotencyKey: string; requestHash: string }): Promise<Norma43Result<{ statementId: string; movementCount: number }>> {
  const key = norma43IdempotencyKey(actor.id, command.bankAccountId, context.idempotencyKey);
  const replay = await prisma.idempotencyRecord.findUnique({ where: { key } });
  if (replay) return replay.requestHash === context.requestHash ? { ok: true, status: 201, value: replay.responseBody as { statementId: string; movementCount: number } } : failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave ya se uso con otro fichero.");
  const preview = await previewNorma43(command, actor); if (!preview.ok) return preview;
  if (preview.value.duplicate) return failure(409, "BANK_STATEMENT_DUPLICATE", "El extracto ya fue importado.");
  if (preview.value.overlap) return failure(409, "BANK_STATEMENT_OVERLAP", "El periodo se solapa con otro extracto de la cuenta.");
  try {
    return await runSerializable(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "bank_accounts" WHERE "id" = ${command.bankAccountId}::uuid FOR UPDATE`);
    const account = await tx.bankAccount.findUnique({ where: { id: command.bankAccountId }, select: { companyId: true, status: true, iban: true, currency: true } });
    if (!account || account.status !== "ACTIVE") return failure(404, "BANK_ACCOUNT_NOT_FOUND", "La cuenta bancaria no existe o esta inactiva.");
    if (account.currency !== preview.value.currency || !matchesSpanishIban(account.iban, preview.value)) return failure(422, "N43_ACCOUNT_MISMATCH", "La cuenta del fichero ya no coincide con la seleccionada.");
    const bookingDates = [...new Set(preview.value.movements.map((movement) => movement.bookingDate))].sort();
    for (const bookingDate of bookingDates) {
      if (!await lockOpenFiscalYearForDatedMutation(tx, account.companyId, parseDate(bookingDate))) {
        return failure(409, "BANK_STATEMENT_FISCAL_YEAR_NOT_OPEN", "Todos los movimientos deben pertenecer a ejercicios contables abiertos.");
      }
    }
    const existingKey = await tx.idempotencyRecord.findUnique({ where: { key } });
    if (existingKey) return existingKey.requestHash === context.requestHash ? { ok: true as const, status: 201 as const, value: existingKey.responseBody as { statementId: string; movementCount: number } } : failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave ya se uso con otro fichero.");
    const duplicate = await tx.bankStatement.findFirst({ where: { companyId: account.companyId, rawSha256: preview.value.rawSha256 }, select: { id: true } });
    if (duplicate) return failure(409, "BANK_STATEMENT_DUPLICATE", "El extracto ya fue importado.");
    const overlap = await tx.bankStatement.findFirst({ where: { bankAccountId: command.bankAccountId, dateFrom: { lte: parseDate(preview.value.dateTo) }, dateTo: { gte: parseDate(preview.value.dateFrom) } }, select: { id: true } });
    if (overlap) return failure(409, "BANK_STATEMENT_OVERLAP", "El periodo se solapa con otro extracto de la cuenta.");
    const statement = await tx.bankStatement.create({ data: { companyId: account.companyId, bankAccountId: command.bankAccountId, dateFrom: parseDate(preview.value.dateFrom), dateTo: parseDate(preview.value.dateTo), openingBalance: new Prisma.Decimal(preview.value.openingBalance), closingBalance: new Prisma.Decimal(preview.value.closingBalance), rawSha256: preview.value.rawSha256, recordCount: preview.value.recordCount, movementCount: preview.value.movements.length, importedById: actor.id }, select: { id: true } });
    await tx.bankMovement.createMany({ data: preview.value.movements.map((movement) => ({ bankAccountId: command.bankAccountId, bankStatementId: statement.id, statementOrdinal: movement.ordinal, statementDocumentNumber: movement.documentNumber, bookingDate: parseDate(movement.bookingDate), valueDate: parseDate(movement.valueDate), amount: new Prisma.Decimal(movement.amount), reference: movement.reference || null, counterpartyName: movement.concept || null, source: "NORMA43", createdById: actor.id })) });
    const value = { statementId: statement.id, movementCount: preview.value.movements.length };
    await tx.idempotencyRecord.create({ data: { key, requestHash: context.requestHash, responseStatus: 201, responseBody: value } });
    await tx.auditEvent.create({ data: { eventType: "BANK_STATEMENT_IMPORTED", actorType: "USER", payload: { actorUserId: actor.id, bankStatementId: statement.id, bankAccountId: command.bankAccountId, rawSha256: preview.value.rawSha256, dateFrom: preview.value.dateFrom, dateTo: preview.value.dateTo, movementCount: value.movementCount, correlationId: context.correlationId } } });
    return { ok: true as const, status: 201 as const, value };
    });
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return failure(409, "BANK_STATEMENT_DUPLICATE", "El extracto ya fue importado.");
    }
    throw error;
  }
}

function decode(content: string): Norma43Result<Uint8Array> { try { const bytes = Buffer.from(content, "base64"); if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== content.replace(/=+$/, "")) return failure(422, "N43_FILE_INVALID", "El contenido base64 no es valido."); return { ok: true, status: 200, value: bytes }; } catch { return failure(422, "N43_FILE_INVALID", "El contenido base64 no es valido."); } }
function numeric(line: string, start: number, end: number): string { const value = line.slice(start, end); if (!/^\d+$/.test(value)) throw new Norma43FieldError(); return value; }
function parseShortDate(value: string): string | null { const full = `20${value.slice(0, 2)}-${value.slice(2, 4)}-${value.slice(4, 6)}`; const date = parseDate(full); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === full ? full : null; }
function decimalFromDigits(value: string): Prisma.Decimal { return new Prisma.Decimal(value).div(100); }
function signedAmount(sign: string, digits: string, balance: boolean): Prisma.Decimal | null { const amount = decimalFromDigits(digits); if (sign === "1" || (balance && sign === "D")) return amount.negated(); if (sign === "2" || (balance && sign === "H")) return amount; return null; }
function parseDate(value: string): Date { return new Date(`${value}T00:00:00.000Z`); }
function matchesSpanishIban(iban: string, parsed: Norma43Parsed): boolean { return iban.startsWith("ES") && iban.slice(4, 8) === parsed.entity && iban.slice(8, 12) === parsed.office && iban.slice(-10) === parsed.accountNumber; }
function norma43IdempotencyKey(actorId: string, bankAccountId: string, idempotencyKey: string): string { return `v1:n43:${createHash("sha256").update(`${actorId}:${bankAccountId}:${idempotencyKey}`).digest("hex")}`; }
function failure(status: 404 | 409 | 413 | 422, code: string, message: string): { ok: false; status: 404 | 409 | 413 | 422; error: { code: string; message: string } } { return { ok: false, status, error: { code, message } }; }
class Norma43FieldError extends Error {}
async function runSerializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> { for (let attempt = 0; attempt < 3; attempt += 1) { try { return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); } catch (error: unknown) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 2) continue; throw error; } } throw new Error("No se pudo importar el extracto tras varios reintentos."); }
