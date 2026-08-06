import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lockOpenFiscalYearForDatedMutation } from "@/modules/accounting/application/fiscalYearMutationBarrier";
import type { SessionUser } from "@/modules/platform/application/auth";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";
import type { CreateSubscriptionRenewalDraftCommand } from "@/modules/subscriptions/application/renewals";

type AttemptContext = { idempotencyKey: string; requestHash: string; correlationId?: string };
type AttemptFailure = { status: number; error: { code: string; message: string } };
type AttemptMember = {
  subscriptionId: string;
  periodStart: Date;
  subscriptionVersionSnapshot: number;
  exclusionId: string | null;
  reservationId: string | null;
};

export async function recordSuccessfulPreparationAttempt(
  tx: Prisma.TransactionClient,
  command: { companyId: string; invoiceId: string; reservationIds: string[] },
  actor: SessionUser,
  context: AttemptContext
): Promise<void> {
  const reservations = await tx.subscriptionRenewalReservation.findMany({
    where: { companyId: command.companyId, invoiceId: command.invoiceId, id: { in: command.reservationIds }, status: "RESERVED" },
    orderBy: { subscriptionId: "asc" },
    select: { id: true, subscriptionId: true, periodStart: true, subscriptionVersionSnapshot: true }
  });
  if (reservations.length !== command.reservationIds.length) throw new Error("SUBSCRIPTION_RENEWAL_ATTEMPT_RESERVATION_SET_INVALID");
  const exclusions = await tx.subscriptionRenewalExclusion.findMany({
    where: { companyId: command.companyId, subscriptionId: { in: reservations.map((reservation) => reservation.subscriptionId) }, status: "OPEN" },
    select: { id: true, subscriptionId: true, periodStart: true }
  });
  const exclusionBySource = new Map(exclusions.map((exclusion) => [`${exclusion.subscriptionId}:${formatDateOnly(exclusion.periodStart)}`, exclusion.id]));
  const attemptedAt = await databaseClock(tx);
  const members = reservations.map((reservation) => ({
    subscriptionId: reservation.subscriptionId,
    periodStart: reservation.periodStart,
    subscriptionVersionSnapshot: reservation.subscriptionVersionSnapshot,
    exclusionId: exclusionBySource.get(`${reservation.subscriptionId}:${formatDateOnly(reservation.periodStart)}`) ?? null,
    reservationId: reservation.id
  }));
  await createAttempt(tx, {
    companyId: command.companyId, phase: "PREPARE", outcome: "SUCCEEDED", errorCode: null,
    invoiceId: command.invoiceId, actorId: actor.id, attemptedAt, context, members
  });
  for (const exclusionId of members.flatMap((member) => member.exclusionId ? [member.exclusionId] : [])) {
    await tx.subscriptionRenewalExclusion.update({
      where: { id: exclusionId },
      data: { attemptCount: { increment: 1 }, lastAttemptAt: attemptedAt, lastErrorCode: null }
    });
  }
}

export async function recordConfirmationAttempt(
  tx: Prisma.TransactionClient,
  command: { companyId: string; invoiceId: string; outcome: "SUCCEEDED" | "FAILED"; errorCode: string | null },
  actor: SessionUser,
  context: AttemptContext
): Promise<void> {
  const expectedStatus = command.outcome === "SUCCEEDED" ? "BILLED" : "RESERVED";
  const reservations = await tx.subscriptionRenewalReservation.findMany({
    where: { companyId: command.companyId, invoiceId: command.invoiceId, status: expectedStatus },
    orderBy: { subscriptionId: "asc" },
    select: { id: true, subscriptionId: true, periodStart: true, subscriptionVersionSnapshot: true }
  });
  if (reservations.length === 0) throw new Error("SUBSCRIPTION_RENEWAL_ATTEMPT_RESERVATIONS_MISSING");
  const exclusions = await tx.subscriptionRenewalExclusion.findMany({
    where: { companyId: command.companyId, subscriptionId: { in: reservations.map((reservation) => reservation.subscriptionId) } },
    orderBy: { openedAt: "desc" },
    select: { id: true, subscriptionId: true, periodStart: true }
  });
  const exclusionBySource = new Map(exclusions.map((exclusion) => [`${exclusion.subscriptionId}:${formatDateOnly(exclusion.periodStart)}`, exclusion.id]));
  const attemptedAt = await databaseClock(tx);
  const members = reservations.map((reservation) => ({
    subscriptionId: reservation.subscriptionId,
    periodStart: reservation.periodStart,
    subscriptionVersionSnapshot: reservation.subscriptionVersionSnapshot,
    exclusionId: exclusionBySource.get(`${reservation.subscriptionId}:${formatDateOnly(reservation.periodStart)}`) ?? null,
    reservationId: reservation.id
  }));
  await createAttempt(tx, {
    companyId: command.companyId, phase: "CONFIRM", outcome: command.outcome,
    errorCode: command.errorCode, invoiceId: command.invoiceId, actorId: actor.id,
    attemptedAt, context, members
  });
  if (command.outcome === "FAILED" && command.errorCode) {
    for (const exclusionId of members.flatMap((member) => member.exclusionId ? [member.exclusionId] : [])) {
      await tx.subscriptionRenewalExclusion.updateMany({
        where: { id: exclusionId, status: "OPEN" }, data: { lastErrorCode: command.errorCode }
      });
    }
  }
}

export async function recordFailedConfirmationAfterRollback(
  companyId: string,
  invoiceId: string,
  errorCode: string,
  actor: SessionUser,
  context: AttemptContext
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`;
    const sources = await tx.subscriptionRenewalReservation.findMany({
      where: { companyId, invoiceId }, orderBy: { subscriptionId: "asc" },
      select: { subscriptionId: true, periodStart: true, subscriptionVersionSnapshot: true, status: true }
    });
    if (sources.length === 0) return;
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "subscriptions" WHERE "companyId" = ${companyId}::uuid
        AND "id" IN (${Prisma.join(sources.map((source) => Prisma.sql`${source.subscriptionId}::uuid`))})
      ORDER BY "id" FOR UPDATE
    `);
    await tx.$queryRaw`SELECT "id" FROM "invoices" WHERE "id" = ${invoiceId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "subscription_renewal_reservations" WHERE "invoiceId" = ${invoiceId}::uuid AND "companyId" = ${companyId}::uuid ORDER BY "subscriptionId" FOR UPDATE`;
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, companyId }, select: { origin: true, status: true } });
    if (!invoice || invoice.origin !== "SUBSCRIPTION" || invoice.status !== "DRAFT") return;
    const subscriptions = await tx.subscription.findMany({
      where: { companyId, id: { in: sources.map((source) => source.subscriptionId) } },
      select: { id: true, status: true, version: true, nextRenewalDate: true }
    });
    const subscriptionById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
    if (subscriptions.length !== sources.length || sources.some((source) => {
      const subscription = subscriptionById.get(source.subscriptionId);
      return source.status !== "RESERVED" || !subscription
        || (subscription.status !== "ACTIVE" && subscription.status !== "RENEWAL_PENDING")
        || subscription.version !== source.subscriptionVersionSnapshot
        || subscription.nextRenewalDate.getTime() !== source.periodStart.getTime();
    })) return;
    const pendingSources = sources.filter((source) => subscriptionById.get(source.subscriptionId)?.status === "RENEWAL_PENDING");
    if (pendingSources.length > 0) {
      const matchingExclusions = await tx.subscriptionRenewalExclusion.count({
        where: {
          companyId, status: "OPEN",
          OR: pendingSources.map((source) => ({ subscriptionId: source.subscriptionId, periodStart: source.periodStart }))
        }
      });
      if (matchingExclusions !== pendingSources.length) return;
    }
    await recordConfirmationAttempt(tx, { companyId, invoiceId, outcome: "FAILED", errorCode }, actor, context);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function materializePreparationFailure(
  command: CreateSubscriptionRenewalDraftCommand,
  failure: AttemptFailure,
  actor: SessionUser,
  context: AttemptContext
): Promise<boolean> {
  if (!isAutomaticPendingFailure(failure.error.code) || !command.expectedVersions) return false;
  const subscriptionIds = [...command.subscriptionIds].sort();
  if (subscriptionIds.some((id) => command.expectedVersions?.[id] === undefined)) return false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`;
        const stored = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
        if (stored) return stored.requestHash === context.requestHash;
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "subscriptions" WHERE "companyId" = ${command.companyId}::uuid
            AND "id" IN (${Prisma.join(subscriptionIds.map((id) => Prisma.sql`${id}::uuid`))})
          ORDER BY "id" FOR UPDATE
        `);
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "subscription_cancellation_schedules"
          WHERE "companyId" = ${command.companyId}::uuid
            AND "subscriptionId" IN (${Prisma.join(subscriptionIds.map((id) => Prisma.sql`${id}::uuid`))})
            AND "status" = 'PENDING' ORDER BY "subscriptionId", "id" FOR UPDATE
        `);
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "subscription_renewal_exclusions"
          WHERE "companyId" = ${command.companyId}::uuid
            AND "subscriptionId" IN (${Prisma.join(subscriptionIds.map((id) => Prisma.sql`${id}::uuid`))})
            AND "status" = 'OPEN' ORDER BY "subscriptionId", "id" FOR UPDATE
        `);
        const subscriptions = await tx.subscription.findMany({
          where: { companyId: command.companyId, id: { in: subscriptionIds } }, orderBy: { id: "asc" },
          select: { id: true, customerId: true, status: true, version: true, periodicity: true, nextRenewalDate: true, endDate: true }
        });
        if (subscriptions.length !== subscriptionIds.length || subscriptions.some((subscription) =>
          (subscription.status !== "ACTIVE" && subscription.status !== "RENEWAL_PENDING")
          || subscription.version !== command.expectedVersions?.[subscription.id]
          || formatDateOnly(subscription.nextRenewalDate) > command.issueDate
          || (subscription.endDate !== null && subscription.nextRenewalDate > subscription.endDate)
        )) return false;
        if (failure.error.code === "CUSTOMER_NOT_ACTIVE") {
          const customerIds = [...new Set(subscriptions.map((subscription) => subscription.customerId))].sort();
          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "customers"
            WHERE "id" IN (${Prisma.join(customerIds.map((id) => Prisma.sql`${id}::uuid`))})
            ORDER BY "id" FOR KEY SHARE
          `);
          const customers = await tx.customer.findMany({
            where: { id: { in: customerIds } },
            select: { id: true, status: true }
          });
          if (customers.length !== customerIds.length || customers.some((customer) => customer.status === "ACTIVE")) return false;
        }
        if (failure.error.code === "INVOICE_ACCOUNTING_FISCAL_YEAR_NOT_OPEN"
          && await lockOpenFiscalYearForDatedMutation(tx, command.companyId, parseDateOnly(command.issueDate))) return false;
        const periodDates = subscriptions.map((subscription) => subscription.nextRenewalDate);
        if (await tx.subscriptionRenewalReservation.count({
          where: { companyId: command.companyId, subscriptionId: { in: subscriptionIds }, periodStart: { in: periodDates }, status: { in: ["RESERVED", "BILLED"] } }
        })) return false;
        if (await tx.subscriptionCancellationSchedule.count({
          where: {
            companyId: command.companyId, subscriptionId: { in: subscriptionIds }, status: "PENDING",
            effectiveDate: { lte: parseDateOnly(command.issueDate) }
          }
        })) return false;
        const openExclusions = await tx.subscriptionRenewalExclusion.findMany({
          where: { companyId: command.companyId, subscriptionId: { in: subscriptionIds }, status: "OPEN" },
          select: { id: true, subscriptionId: true, periodStart: true }
        });
        const openBySubscription = new Map(openExclusions.map((exclusion) => [exclusion.subscriptionId, exclusion]));
        if (subscriptions.some((subscription) => {
          const exclusion = openBySubscription.get(subscription.id);
          const expectedId = command.pendingExclusionIds?.[subscription.id];
          return subscription.status === "RENEWAL_PENDING"
            ? !exclusion || exclusion.id !== expectedId || exclusion.periodStart.getTime() !== subscription.nextRenewalDate.getTime()
            : Boolean(expectedId || exclusion);
        })) return false;

        const attemptedAt = await databaseClock(tx);
        const members: AttemptMember[] = [];
        for (const subscription of subscriptions) {
          let exclusionId = openBySubscription.get(subscription.id)?.id ?? null;
          if (subscription.status === "ACTIVE") {
            const periodRows = await tx.$queryRaw<Array<{ periodEndExclusive: Date }>>(Prisma.sql`
              SELECT "subscription_next_renewal_date"(${subscription.nextRenewalDate}::date, ${subscription.periodicity}::"SubscriptionPeriodicity") AS "periodEndExclusive"
            `);
            const periodEndExclusive = periodRows[0]?.periodEndExclusive;
            if (!periodEndExclusive) throw new Error("SUBSCRIPTION_RENEWAL_PERIOD_UNAVAILABLE");
            const exclusion = await tx.subscriptionRenewalExclusion.create({ data: {
              companyId: command.companyId, subscriptionId: subscription.id,
              periodStart: subscription.nextRenewalDate, periodEndExclusive,
              reasonCode: "PREPARATION_FAILED", openedAgainstVersion: subscription.version,
              attemptCount: 1, lastAttemptAt: attemptedAt, lastErrorCode: failure.error.code,
              openedById: actor.id, openedAt: attemptedAt
            } });
            exclusionId = exclusion.id;
            await tx.subscription.update({
              where: { id: subscription.id },
              data: { status: "RENEWAL_PENDING", version: { increment: 1 }, updatedById: actor.id }
            });
          } else if (exclusionId) {
            await tx.subscriptionRenewalExclusion.update({
              where: { id: exclusionId },
              data: { attemptCount: { increment: 1 }, lastAttemptAt: attemptedAt, lastErrorCode: failure.error.code }
            });
          }
          members.push({
            subscriptionId: subscription.id, periodStart: subscription.nextRenewalDate,
            subscriptionVersionSnapshot: subscription.version, exclusionId, reservationId: null
          });
        }
        await createAttempt(tx, {
          companyId: command.companyId, phase: "PREPARE", outcome: "BLOCKED", errorCode: failure.error.code,
          invoiceId: null, actorId: actor.id, attemptedAt, context, members
        });
        await tx.auditEvent.create({ data: {
          eventType: "SUBSCRIPTION_RENEWAL_PREPARATION_BLOCKED", actorType: "USER",
          payload: {
            actorUserId: actor.id, companyId: command.companyId, subscriptionIds,
            exclusionIds: members.flatMap((member) => member.exclusionId ? [member.exclusionId] : []),
            errorCode: failure.error.code,
            ...(context.correlationId ? { correlationId: context.correlationId } : {})
          }
        } });
        await tx.idempotencyRecord.create({ data: {
          key: context.idempotencyKey, requestHash: context.requestHash,
          responseStatus: failure.status, responseBody: failure.error
        } });
        return true;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isRetryableTransactionError(error) && attempt < 2) continue;
      if (isRetryableTransactionError(error)) return false;
      throw error;
    }
  }
  return false;
}

async function createAttempt(
  tx: Prisma.TransactionClient,
  input: {
    companyId: string; phase: "PREPARE" | "CONFIRM"; outcome: "SUCCEEDED" | "BLOCKED" | "FAILED";
    errorCode: string | null; invoiceId: string | null; actorId: string | null; attemptedAt: Date;
    context: AttemptContext; members: AttemptMember[];
  }
): Promise<void> {
  const deduplicationKey = hashIdempotencyPayload("subscription-renewal-attempt:v1", {
    idempotencyKey: input.context.idempotencyKey,
    phase: input.phase,
    outcome: input.outcome,
    errorCode: input.errorCode
  });
  if (await tx.subscriptionRenewalAttempt.findUnique({ where: { deduplicationKey }, select: { id: true } })) return;
  const attempt = await tx.subscriptionRenewalAttempt.create({ data: {
    companyId: input.companyId, phase: input.phase, outcome: input.outcome,
    deduplicationKey, errorCode: input.errorCode, actorId: input.actorId,
    attemptedAt: input.attemptedAt, correlationId: input.context.correlationId,
    invoiceId: input.invoiceId
  } });
  await tx.subscriptionRenewalAttemptMember.createMany({
    data: input.members.map((member) => ({ attemptId: attempt.id, companyId: input.companyId, ...member }))
  });
}

function isAutomaticPendingFailure(code: string): boolean {
  return code === "CUSTOMER_NOT_ACTIVE" || code === "INVOICE_ACCOUNTING_FISCAL_YEAR_NOT_OPEN";
}

async function databaseClock(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  const now = rows[0]?.now;
  if (!now) throw new Error("SUBSCRIPTION_RENEWAL_DATABASE_CLOCK_UNAVAILABLE");
  return now;
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function isRetryableTransactionError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001");
}
