import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { login } from "@/modules/platform/application/auth";
import { hashRequestBody, initializePlatform, type InitializeCommand } from "@/modules/platform/application/installation";
import { hashPassword } from "@/modules/platform/application/passwords";
import { activateSubscription, cancelScheduledSubscriptionCancellation, cancelSubscription, createSubscription, createSubscriptionSchema, getSubscription, hashSubscriptionRequest, listSubscriptions, reactivateSubscription, resolveScheduledCancellationBeforeRenewal, scheduleSubscriptionCancellation, updateSubscription } from "@/modules/subscriptions/application/subscriptions";
import { confirmSubscriptionRenewal, createSubscriptionRenewalDraft, hashSubscriptionRenewalConfirmationRequest, hashSubscriptionRenewalDraftRequest, hashSubscriptionRenewalReleaseRequest, listSubscriptionRenewalPreview, releaseSubscriptionRenewal } from "@/modules/subscriptions/application/renewals";
import { excludeSubscriptionRenewal, hashSubscriptionRenewalExclusionRequest, hashSubscriptionRenewalWaiverRequest, listSubscriptionRenewalExclusions, listSubscriptionRenewalExclusionsSchema, waiveSubscriptionRenewal } from "@/modules/subscriptions/application/renewalExclusions";
import { listSubscriptionRenewalWaivers } from "@/modules/subscriptions/application/renewalWaiverReports";
import { completeRenewalWaiverFiscalReview, decideRenewalWaiverFiscalReview, hashCompleteRenewalWaiverFiscalReview, hashDecideRenewalWaiverFiscalReview, hashStartRenewalWaiverFiscalReview, startRenewalWaiverFiscalReview } from "@/modules/subscriptions/application/renewalWaiverFiscalReviews";
import { applySubscriptionReactivationSchedule, createSubscriptionReactivationSchedule, hashSubscriptionReactivationScheduleRequest, processNextDueSubscriptionReactivationSchedule, revokeSubscriptionReactivationSchedule } from "@/modules/subscriptions/application/reactivationSchedules";
import { createSubscriptionChangeSchedule, hashSubscriptionChangeScheduleRequest, revokeSubscriptionChangeSchedule } from "@/modules/subscriptions/application/subscriptionChanges";
import { issueInvoice } from "@/modules/billing/application/invoices";
import { createManualJournalEntry } from "@/modules/accounting/application/journal";
import { approveWaiverEvidenceReversal, hashWaiverEvidenceReversalApproval, hashWaiverEvidenceReversalRequest, requestWaiverEvidenceReversal } from "@/modules/accounting/application/waiverEvidenceReversals";
import { approveWaiverEvidenceReplacement, cancelWaiverEvidenceReplacement, getWaiverEvidenceReplacementDetail, hashWaiverEvidenceReplacementApproval, hashWaiverEvidenceReplacementCancellation, hashWaiverEvidenceReplacementRejection, hashWaiverEvidenceReplacementRequest, listWaiverEvidenceReplacementProposals, listWaiverEvidenceReplacementProposalsSchema, rejectWaiverEvidenceReplacement, requestWaiverEvidenceReplacement, requestWaiverEvidenceReplacementSchema } from "@/modules/accounting/application/waiverEvidenceReplacements";

const password = "Cambiar-esta-clave-2026";
const initialization: InitializeCommand = { company: { legalName: "CriGestion Test SL", taxId: "B12345678", email: "admin@example.test" }, administrator: { displayName: "Administrador", userName: "admin", password } };

describe("subscriptions application service", () => {
  beforeEach(async () => { await reset(); await initialize(); }, 30_000);
  afterAll(async () => { await reset(); await prisma.$disconnect(); }, 30_000);

  it("creates an idempotent draft with catalog snapshots and annual numbering", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id);
    const command = payload(customerId, itemId); const first = await createSubscription(command, actor, context("create", command)); const replay = await createSubscription(command, actor, context("create", command));
    expect(first).toMatchObject({ ok: true, status: 201, value: { number: "SUS-2026-00001", status: "DRAFT", nextRenewalDate: "2026-09-01", estimatedTotal: "60.38", lines: [{ quantity: "1.000", unitPrice: "49.90", taxRate: "21.00" }] } });
    expect(replay).toEqual(first); expect(await prisma.subscription.count()).toBe(1);
    await prisma.catalogItem.update({ where: { id: itemId }, data: { name: "Nombre cambiado", salePrice: "99.00", status: "INACTIVE" } });
    const stored = await prisma.subscriptionLine.findFirstOrThrow(); expect(stored.description).toMatch(/^Servicio recurrente /); expect(stored.unitPrice.toFixed(2)).toBe("49.90");
    const audit = JSON.stringify((await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUBSCRIPTION_CREATED" } })).payload); expect(audit).not.toContain("49.90"); expect(audit).not.toContain("Nota privada");
  });

  it("reserves distinct numbers for concurrent creations", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id);
    const commands = [payload(customerId, itemId, { name: "Uno" }), payload(customerId, itemId, { name: "Dos" })];
    const results = await Promise.all(commands.map((command, index) => createSubscription(command, actor, context(`parallel-${index}`, command))));
    expect(results.every((result) => result.ok)).toBe(true); expect((await prisma.subscription.findMany({ orderBy: { number: "asc" }, select: { number: true } })).map((row) => row.number)).toEqual(["SUS-2026-00001", "SUS-2026-00002"]);
  });

  it("requires the economics permission for price overrides", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const command = payload(customerId, itemId, { lines: [{ catalogItemId: itemId, quantity: "1.000", unitPrice: "10.00", discountPercent: "0.00", discountAmount: "0.00" }] });
    const restricted = { ...actor, permissions: actor.permissions.filter((permission) => permission !== "Subscriptions.ManageEconomics") };
    expect(await createSubscription(command, restricted, context("restricted", command))).toMatchObject({ ok: false, status: 403, error: { code: "SUBSCRIPTION_ECONOMICS_PERMISSION_REQUIRED" } });
    expect(await prisma.auditEvent.count({ where: { eventType: "ACCESS_DENIED", payload: { path: ["permission"], equals: "Subscriptions.ManageEconomics" } } })).toBeGreaterThan(0);
  });

  it("activates once with optimistic concurrency and keeps database invariants", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const command = payload(customerId, itemId); const created = await createSubscription(command, actor, context("create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("activate", { version: 1 })); expect(activated).toMatchObject({ ok: true, value: { status: "ACTIVE", version: 2 } });
    expect(await activateSubscription(created.value.id, { version: 1 }, actor, context("stale", { version: 1 }))).toMatchObject({ ok: false, error: { code: "SUBSCRIPTION_VERSION_CONFLICT" } });
    await expect(prisma.subscriptionLine.update({ where: { id: created.value.lines[0]!.id }, data: { quantity: "0" } })).rejects.toThrow();
    await expect(prisma.subscriptionLine.update({ where: { id: created.value.lines[0]!.id }, data: { description: "Cambio posterior" } })).rejects.toThrow();
    const list = await listSubscriptions({ limit: 25, status: "ACTIVE" }, actor); expect(list.subscriptions).toHaveLength(1);
    expect(await prisma.auditEvent.count({ where: { eventType: "SUBSCRIPTIONS_VIEWED" } })).toBeGreaterThan(0);
    expect(createSubscriptionSchema.safeParse(payload(customerId, itemId, { startDate: "1999-12-31" })).success).toBe(false);
    await expect(prisma.subscription.update({ where: { id: created.value.id }, data: { number: "SUS-2026-99999" } })).rejects.toThrow();
  });

  it("keeps list, detail and activation inside the installed company", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const command = payload(customerId, itemId);
    const created = await createSubscription(command, actor, context("company-scope", command)); if (!created.ok) throw new Error(created.error.code);
    await prisma.subscriptionLine.update({ where: { id: created.value.lines[0]!.id }, data: { quantity: "2" } });
    expect(await activateSubscription(created.value.id, { version: 1 }, actor, context("invalid-fixed", { version: 1 }))).toMatchObject({ ok: false, status: 422, error: { code: "SUBSCRIPTION_CONFIGURATION_INVALID" } });
    await prisma.subscriptionLine.update({ where: { id: created.value.lines[0]!.id }, data: { quantity: "1" } });
    const foreignCompany = await prisma.company.create({ data: { legalName: "Empresa ajena SL", taxId: `B${Date.now()}` } });
    const foreign = await prisma.subscription.create({ data: { companyId: foreignCompany.id, year: 2026, numberSequence: 99999, number: "SUS-2026-99999", customerId, name: "Suscripcion ajena", periodicity: "MONTHLY", pricingMode: "FIXED", paymentMethod: "BANK_TRANSFER", startDate: new Date("2026-09-01T00:00:00.000Z"), nextRenewalDate: new Date("2026-09-01T00:00:00.000Z"), createdById: actor.id } });
    expect((await listSubscriptions({ limit: 25 }, actor)).subscriptions.map((item) => item.id)).not.toContain(foreign.id);
    expect(await getSubscription(foreign.id, actor)).toBeNull();
    expect(await activateSubscription(foreign.id, { version: 1 }, actor, context("foreign-activate", { version: 1 }))).toMatchObject({ ok: false, status: 404, error: { code: "SUBSCRIPTION_NOT_FOUND" } });
    const foreignReactivation = { expectedVersion: 1, nextRenewalDate: "2026-10-01", reason: "Intento sobre otra empresa" };
    expect(await reactivateSubscription(foreign.id, foreignReactivation, actor, context("foreign-reactivate", foreignReactivation))).toMatchObject({ ok: false, status: 404, error: { code: "SUBSCRIPTION_NOT_FOUND" } });
    const foreignSchedule = { expectedVersion: 1, effectiveDate: futureDate(), reason: "Orden ajena" };
    expect(await scheduleSubscriptionCancellation(foreign.id, foreignSchedule, actor, context("foreign-schedule", foreignSchedule))).toMatchObject({ ok: false, status: 404, error: { code: "SUBSCRIPTION_NOT_FOUND" } });
  });

  it("edits only drafts, preserves economics for header changes and detects concurrent versions", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const command = payload(customerId, itemId);
    const created = await createSubscription(command, actor, context("edit-create", command)); if (!created.ok) throw new Error(created.error.code);
    const restricted = { ...actor, permissions: actor.permissions.filter((permission) => permission !== "Subscriptions.ManageEconomics") };
    const headerUpdate = updatePayload(created.value, { name: "Soporte actualizado", startDate: "2026-10-01" });
    const updated = await updateSubscription(created.value.id, headerUpdate, restricted, context("edit-header", headerUpdate));
    expect(updated).toMatchObject({ ok: true, value: { name: "Soporte actualizado", startDate: "2026-10-01", nextRenewalDate: "2026-10-01", version: 2, lines: [{ unitPrice: "49.90" }] } });
    if (!updated.ok) throw new Error(updated.error.code);
    const commands = [updatePayload(updated.value, { name: "Cambio A" }), updatePayload(updated.value, { name: "Cambio B" })];
    const results = await Promise.all(commands.map((value, index) => updateSubscription(updated.value.id, value, actor, context(`edit-race-${index}`, value))));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)[0]).toMatchObject({ ok: false, error: { code: "SUBSCRIPTION_VERSION_CONFLICT" } });
    const current = await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: { version: true } });
    expect(current.version).toBe(3);
    const wrongYear = updatePayload(updated.value, { startDate: "2027-01-01", expectedVersion: 3 });
    expect(await updateSubscription(updated.value.id, wrongYear, actor, context("edit-year", wrongYear))).toMatchObject({ ok: false, status: 422, error: { code: "SUBSCRIPTION_START_YEAR_IMMUTABLE" } });
  });

  it("cancels an active subscription idempotently and keeps contract data immutable", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const command = payload(customerId, itemId, { startDate: "2026-01-01" });
    const created = await createSubscription(command, actor, context("cancel-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("cancel-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    expect(await updateSubscription(created.value.id, updatePayload(activated.value), actor, context("edit-active", activated.value))).toMatchObject({ ok: false, status: 409, error: { code: "SUBSCRIPTION_NOT_EDITABLE" } });
    await expect(prisma.subscription.update({ where: { id: created.value.id }, data: { status: "CANCELLED" } })).rejects.toThrow();
    const cancellation = { expectedVersion: 2, reason: "Baja solicitada por el cliente" };
    const first = await cancelSubscription(created.value.id, cancellation, actor, context("cancel", cancellation));
    const replay = await cancelSubscription(created.value.id, cancellation, actor, context("cancel", cancellation));
    expect(first).toMatchObject({ ok: true, value: { status: "CANCELLED", version: 3, cancellation: { reason: cancellation.reason, mode: "IMMEDIATE" } } });
    expect(replay).toEqual(first);
    expect(JSON.stringify(await listSubscriptions({ limit: 25, status: "CANCELLED" }, actor))).not.toContain(cancellation.reason);
    const changedCancellation = { ...cancellation, reason: "Otro motivo" };
    expect(await cancelSubscription(created.value.id, changedCancellation, actor, context("cancel", changedCancellation))).toMatchObject({ ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    await expect(prisma.subscription.update({ where: { id: created.value.id }, data: { name: "Cambio prohibido" } })).rejects.toThrow();
    await expect(prisma.subscription.update({ where: { id: created.value.id }, data: { cancellationReason: "Cambio de evidencia" } })).rejects.toThrow();
    await expect(prisma.subscription.update({ where: { id: created.value.id }, data: { cancellationMode: "SCHEDULED" } })).rejects.toThrow();
    await expect(prisma.subscription.update({ where: { id: created.value.id }, data: { status: "ACTIVE", cancelledAt: null, cancelledById: null, cancellationEffectiveDate: null, cancellationReason: null } })).rejects.toThrow();
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUBSCRIPTION_CANCELLED" } });
    expect(JSON.stringify(audit.payload)).not.toContain(cancellation.reason);
  });

  it("reactivates a cancelled subscription idempotently and archives the cancellation cycle", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id);
    const created = await createSubscription(payload(customerId, itemId, { startDate: "2026-01-01" }), actor, context("reactivate-create", {}));
    if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("reactivate-activate", { version: 1 }));
    if (!activated.ok) throw new Error(activated.error.code);
    const cancellation = { expectedVersion: 2, reason: "Baja previa conservada en el historial" };
    const cancelled = await cancelSubscription(created.value.id, cancellation, actor, context("reactivate-cancel", cancellation));
    if (!cancelled.ok) throw new Error(cancelled.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow()).companyId!;
    await expect(prisma.subscriptionReactivation.create({ data: {
      companyId, subscriptionId: created.value.id, reactivatedById: actor.id,
      reactivatedAt: new Date("2030-09-01T10:00:00.000Z"), reason: "Marca temporal SQL manipulada",
      effectiveDate: new Date("2030-09-01T00:00:00.000Z"), nextRenewalDate: new Date("2030-10-01T00:00:00.000Z"),
      previousNextRenewalDate: new Date(`${cancelled.value.nextRenewalDate}T00:00:00.000Z`),
      createdAgainstVersion: cancelled.value.version, reactivatedSubscriptionVersion: cancelled.value.version + 1,
      cancelledByIdSnapshot: actor.id, cancelledAtSnapshot: new Date(cancelled.value.cancellation!.cancelledAt),
      cancellationEffectiveDateSnapshot: new Date(`${cancelled.value.cancellation!.effectiveDate}T00:00:00.000Z`),
      cancellationReasonSnapshot: cancelled.value.cancellation!.reason, cancellationModeSnapshot: cancelled.value.cancellation!.mode
    } })).rejects.toThrow("Subscription reactivation timestamp must be immediate.");
    const command = { expectedVersion: cancelled.value.version, nextRenewalDate: "2026-09-01", reason: "El cliente solicita reanudar el servicio" };
    const first = await reactivateSubscription(created.value.id, command, actor, context("reactivate", command));
    const replay = await reactivateSubscription(created.value.id, command, actor, context("reactivate", command));
    expect(first).toMatchObject({ ok: true, value: {
      status: "ACTIVE", version: 4, nextRenewalDate: "2026-09-01", cancellation: null,
      reactivations: [{ reason: command.reason, cancellation: { reason: cancellation.reason, mode: "IMMEDIATE" } }]
    } });
    expect(replay).toEqual(first);
    expect(await prisma.subscriptionReactivation.count({ where: { subscriptionId: created.value.id } })).toBe(1);
    const stored = await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: {
      status: true, version: true, cancelledAt: true, cancelledById: true, cancellationEffectiveDate: true,
      cancellationReason: true, cancellationMode: true
    } });
    expect(stored).toEqual({ status: "ACTIVE", version: 4, cancelledAt: null, cancelledById: null,
      cancellationEffectiveDate: null, cancellationReason: null, cancellationMode: null });
    const changed = { ...command, reason: "Una justificacion diferente" };
    expect(await reactivateSubscription(created.value.id, changed, actor, context("reactivate", changed))).toMatchObject({
      ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED" }
    });
    expect(await reactivateSubscription(created.value.id, command, actor, context("reactivate-stale", command))).toMatchObject({
      ok: false, status: 409, error: { code: "SUBSCRIPTION_VERSION_CONFLICT" }
    });
    const history = await prisma.subscriptionReactivation.findFirstOrThrow({ where: { subscriptionId: created.value.id } });
    await expect(prisma.subscriptionReactivation.update({ where: { id: history.id }, data: { reason: "Alteracion" } })).rejects.toThrow();
    await expect(prisma.subscriptionReactivation.delete({ where: { id: history.id } })).rejects.toThrow();
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUBSCRIPTION_REACTIVATED" } });
    const serializedAudit = JSON.stringify(audit.payload);
    expect(serializedAudit).not.toContain(command.reason);
    expect(serializedAudit).not.toContain("subscriptions-test:reactivate");
    await prisma.idempotencyRecord.update({ where: { key: "subscriptions-test:reactivate" }, data: { responseBody: { id: created.value.id } } });
    expect(await reactivateSubscription(created.value.id, command, actor, context("reactivate", command))).toMatchObject({
      ok: false, status: 409, error: { code: "IDEMPOTENCY_REPLAY_INVALID" }
    });
  });

  it("validates reactivation eligibility and serializes concurrent requests", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id);
    const creation = payload(customerId, itemId, { startDate: "2026-01-01" });
    const created = await createSubscription(creation, actor, context("reactivation-race-create", creation));
    if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("reactivation-race-activate", { version: 1 }));
    if (!activated.ok) throw new Error(activated.error.code);
    const cancellation = { expectedVersion: 2, reason: "Baja antes de comprobar la carrera" };
    const cancelled = await cancelSubscription(created.value.id, cancellation, actor, context("reactivation-race-cancel", cancellation));
    if (!cancelled.ok) throw new Error(cancelled.error.code);
    const past = { expectedVersion: 3, nextRenewalDate: "2026-01-02", reason: "Fecha no elegible" };
    expect(await reactivateSubscription(created.value.id, past, actor, context("reactivation-past", past))).toMatchObject({
      ok: false, status: 422, error: { code: "SUBSCRIPTION_REACTIVATION_DATE_INVALID" }
    });
    await prisma.customer.update({ where: { id: customerId }, data: { status: "INACTIVE" } });
    const command = { expectedVersion: 3, nextRenewalDate: "2026-10-01", reason: "Reanudacion concurrente solicitada" };
    expect(await reactivateSubscription(created.value.id, command, actor, context("reactivation-inactive", command))).toMatchObject({
      ok: false, status: 422, error: { code: "CUSTOMER_NOT_ACTIVE" }
    });
    await prisma.customer.update({ where: { id: customerId }, data: { status: "ACTIVE" } });
    const results = await Promise.all([
      reactivateSubscription(created.value.id, command, actor, context("reactivation-race-a", command)),
      reactivateSubscription(created.value.id, command, actor, context("reactivation-race-b", command))
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)[0]).toMatchObject({ ok: false, status: 409, error: { code: "SUBSCRIPTION_VERSION_CONFLICT" } });
    expect(await prisma.subscriptionReactivation.count({ where: { subscriptionId: created.value.id } })).toBe(1);
  });

  it("schedules and revokes a supervised reactivation without activating the subscription", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id);
    const creation = payload(customerId, itemId, { startDate: "2026-01-01" });
    const created = await createSubscription(creation, actor, context("scheduled-reactivation-create", creation)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("scheduled-reactivation-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const cancellation = { expectedVersion: 2, reason: "Baja antes de una reanudacion futura" };
    const cancelled = await cancelSubscription(created.value.id, cancellation, actor, context("scheduled-reactivation-cancel", cancellation)); if (!cancelled.ok) throw new Error(cancelled.error.code);
    const scheduleCommand = { expectedVersion: 3, effectiveDate: futureDate(), nextRenewalDate: futureDate(), reason: "Reanudacion supervisada acordada" };
    const scheduled = await createSubscriptionReactivationSchedule(created.value.id, scheduleCommand, actor,
      reactivationScheduleContext("create", "scheduled-create", created.value.id, null, scheduleCommand));
    const replay = await createSubscriptionReactivationSchedule(created.value.id, scheduleCommand, actor,
      reactivationScheduleContext("create", "scheduled-create", created.value.id, null, scheduleCommand));
    expect(scheduled).toMatchObject({ ok: true, status: 201, value: { subscriptionVersion: 4, schedule: { status: "PENDING", version: 1 } } });
    expect(replay).toEqual(scheduled); if (!scheduled.ok) throw new Error(scheduled.error.code);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: { status: true, version: true } })).toEqual({ status: "CANCELLED", version: 4 });
    expect(await applySubscriptionReactivationSchedule(created.value.id, scheduled.value.schedule.id,
      { expectedSubscriptionVersion: 4, expectedScheduleVersion: 1 }, actor,
      reactivationScheduleContext("apply", "scheduled-not-due", created.value.id, scheduled.value.schedule.id,
        { expectedSubscriptionVersion: 4, expectedScheduleVersion: 1 }))).toMatchObject({
      ok: false, status: 422, error: { code: "SUBSCRIPTION_REACTIVATION_SCHEDULE_NOT_DUE" }
    });
    expect(await reactivateSubscription(created.value.id, { expectedVersion: 4, nextRenewalDate: futureDate(), reason: "Intento inmediato incompatible" }, actor,
      context("scheduled-reactivation-immediate-blocked", { expectedVersion: 4, nextRenewalDate: futureDate(), reason: "Intento inmediato incompatible" }))).toMatchObject({
      ok: false, status: 409, error: { code: "SUBSCRIPTION_PENDING_REACTIVATION_EXISTS" }
    });
    const revokeCommand = { expectedSubscriptionVersion: 4, expectedScheduleVersion: 1, reason: "El cliente aplaza la reanudacion" };
    const revoked = await revokeSubscriptionReactivationSchedule(created.value.id, scheduled.value.schedule.id, revokeCommand, actor,
      reactivationScheduleContext("revoke", "scheduled-revoke", created.value.id, scheduled.value.schedule.id, revokeCommand));
    expect(revoked).toMatchObject({ ok: true, value: { subscriptionVersion: 5, schedule: { status: "REVOKED", version: 2, revocationReason: revokeCommand.reason } } });
    await expect(prisma.subscriptionReactivationSchedule.update({ where: { id: scheduled.value.schedule.id }, data: { reason: "Alteracion" } })).rejects.toThrow();
    await expect(prisma.subscriptionReactivationSchedule.delete({ where: { id: scheduled.value.schedule.id } })).rejects.toThrow();
    const audit = JSON.stringify(await prisma.auditEvent.findMany({ where: { eventType: { in: ["SUBSCRIPTION_REACTIVATION_SCHEDULED", "SUBSCRIPTION_REACTIVATION_SCHEDULE_REVOKED"] } }, select: { payload: true } }));
    expect(audit).not.toContain(scheduleCommand.reason); expect(audit).not.toContain(revokeCommand.reason);
  });

  it("applies a due supervised reactivation atomically and preserves both histories", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id);
    const creation = payload(customerId, itemId, { startDate: "2026-01-01" });
    const created = await createSubscription(creation, actor, context("scheduled-apply-create", creation)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("scheduled-apply-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const cancellation = { expectedVersion: 2, reason: "Baja para aplicar una orden vencida" };
    const cancelled = await cancelSubscription(created.value.id, cancellation, actor, context("scheduled-apply-cancel", cancellation)); if (!cancelled.ok) throw new Error(cancelled.error.code);
    const scheduleCommand = { expectedVersion: 3, effectiveDate: futureDate(), nextRenewalDate: futureDate(), reason: "Reanudacion que llegara a vencimiento" };
    const scheduled = await createSubscriptionReactivationSchedule(created.value.id, scheduleCommand, actor,
      reactivationScheduleContext("create", "scheduled-apply-schedule", created.value.id, null, scheduleCommand));
    if (!scheduled.ok) throw new Error(scheduled.error.code);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yesterdayDate = new Date(`${yesterday.toISOString().slice(0, 10)}T00:00:00.000Z`);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "subscriptions" DISABLE TRIGGER "subscription_header_lifecycle_trigger"');
      await tx.$executeRawUnsafe('ALTER TABLE "subscription_reactivation_schedules" DISABLE TRIGGER "subscription_reactivation_schedule_history_trigger"');
      await tx.subscription.update({
        where: { id: created.value.id },
        data: { cancelledAt: yesterday, cancellationEffectiveDate: yesterdayDate }
      });
      await tx.subscriptionReactivationSchedule.update({
        where: { id: scheduled.value.schedule.id },
        data: {
          requestedAt: yesterday,
          effectiveDate: new Date(`${todayDate()}T00:00:00.000Z`),
          cancelledAtSnapshot: yesterday,
          cancellationEffectiveDateSnapshot: yesterdayDate
        }
      });
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      await tx.$executeRawUnsafe('ALTER TABLE "subscription_reactivation_schedules" ENABLE TRIGGER "subscription_reactivation_schedule_history_trigger"');
      await tx.$executeRawUnsafe('ALTER TABLE "subscriptions" ENABLE TRIGGER "subscription_header_lifecycle_trigger"');
    });
    const applyCommand = { expectedSubscriptionVersion: 4, expectedScheduleVersion: 1 };
    const applied = await applySubscriptionReactivationSchedule(created.value.id, scheduled.value.schedule.id, applyCommand, actor,
      reactivationScheduleContext("apply", "scheduled-apply", created.value.id, scheduled.value.schedule.id, applyCommand));
    const replay = await applySubscriptionReactivationSchedule(created.value.id, scheduled.value.schedule.id, applyCommand, actor,
      reactivationScheduleContext("apply", "scheduled-apply", created.value.id, scheduled.value.schedule.id, applyCommand));
    expect(applied).toMatchObject({ ok: true, value: { subscriptionVersion: 5, status: "ACTIVE", nextRenewalDate: scheduleCommand.nextRenewalDate, schedule: { status: "APPLIED", version: 2 } } });
    expect(replay).toEqual(applied);
    const stored = await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, include: { reactivations: true, reactivationSchedules: true } });
    expect(stored).toMatchObject({ status: "ACTIVE", version: 5, cancellationReason: null, reactivations: [{ reason: scheduleCommand.reason }], reactivationSchedules: [{ status: "APPLIED", reactivationId: applied.ok ? applied.value.reactivationId : null }] });
  });

  it("automatically applies a due reactivation once and records append-only monitoring", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id);
    const creation = payload(customerId, itemId, { startDate: "2026-01-01" });
    const created = await createSubscription(creation, actor, context("automation-create", creation)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("automation-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const cancellation = { expectedVersion: 2, reason: "Baja previa a automatizacion" };
    const cancelled = await cancelSubscription(created.value.id, cancellation, actor, context("automation-cancel", cancellation)); if (!cancelled.ok) throw new Error(cancelled.error.code);
    const scheduleCommand = { expectedVersion: 3, effectiveDate: futureDate(), nextRenewalDate: futureDate(), reason: "Reanudacion automatica monitorizada" };
    const scheduled = await createSubscriptionReactivationSchedule(created.value.id, scheduleCommand, actor,
      reactivationScheduleContext("create", "automation-schedule", created.value.id, null, scheduleCommand));
    if (!scheduled.ok) throw new Error(scheduled.error.code);
    await makeReactivationScheduleDue(created.value.id, scheduled.value.schedule.id);

    const [first, concurrent] = await Promise.all([
      processNextDueSubscriptionReactivationSchedule("automation-worker-a"),
      processNextDueSubscriptionReactivationSchedule("automation-worker-b")
    ]);
    expect([first.outcome, concurrent.outcome].filter((outcome) => outcome === "APPLIED")).toHaveLength(1);
    expect(await processNextDueSubscriptionReactivationSchedule("automation-worker-c")).toEqual({ outcome: "IDLE" });
    const stored = await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: { status: true, version: true } });
    expect(stored).toEqual({ status: "ACTIVE", version: 5 });
    const attempts = await prisma.subscriptionReactivationAutomationAttempt.findMany({ where: { scheduleId: scheduled.value.schedule.id } });
    expect(attempts).toMatchObject([{ attemptNumber: 1, outcome: "APPLIED", stableCode: null }]);
    await expect(prisma.subscriptionReactivationAutomationAttempt.create({
      data: {
        companyId: attempts[0]!.companyId,
        subscriptionId: attempts[0]!.subscriptionId,
        scheduleId: attempts[0]!.scheduleId,
        attemptNumber: 2,
        workerId: "automation-worker-outside-transition",
        startedAt: new Date(),
        completedAt: new Date(),
        outcome: "APPLIED"
      }
    })).rejects.toThrow("Invalid subscription reactivation automation attempt.");
    await expect(prisma.subscriptionReactivationAutomationAttempt.update({ where: { id: attempts[0]!.id }, data: { workerId: "altered" } })).rejects.toThrow();
    await expect(prisma.subscriptionReactivationAutomationAttempt.delete({ where: { id: attempts[0]!.id } })).rejects.toThrow();
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUBSCRIPTION_REACTIVATION_SCHEDULE_APPLIED", actorType: "SYSTEM" } });
    expect(JSON.stringify(audit.payload)).not.toContain(scheduleCommand.reason);
  });

  it("schedules and revokes a per-license quantity change without mutating the active contract", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id);
    const creation = payload(customerId, itemId, {
      pricingMode: "PER_LICENSE",
      lines: [{ catalogItemId: itemId, quantity: "2.000", discountPercent: "0.00", discountAmount: "0.00" }]
    });
    const created = await createSubscription(creation, actor, context("change-create", creation)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("change-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const command = {
      expectedVersion: 2,
      reason: "Ampliacion de licencias en la siguiente renovacion",
      lines: [{ subscriptionLineId: created.value.lines[0]!.id, quantity: "3.000" }]
    };
    const scheduled = await createSubscriptionChangeSchedule(created.value.id, command, actor,
      changeScheduleContext("create", "change-schedule", created.value.id, null, command));
    const replay = await createSubscriptionChangeSchedule(created.value.id, command, actor,
      changeScheduleContext("create", "change-schedule", created.value.id, null, command));
    expect(scheduled).toMatchObject({ ok: true, status: 201, value: {
      subscriptionVersion: 3,
      schedule: { status: "PENDING", version: 1, lines: [{ previousQuantity: "2.000", newQuantity: "3.000" }] }
    } });
    expect(replay).toEqual(scheduled); if (!scheduled.ok) throw new Error(scheduled.error.code);
    expect((await prisma.subscriptionLine.findUniqueOrThrow({ where: { id: created.value.lines[0]!.id }, select: { quantity: true } })).quantity.toFixed(3))
      .toBe("2.000");
    await expect(prisma.subscriptionLine.update({ where: { id: created.value.lines[0]!.id }, data: { quantity: "3.000" } })).rejects.toThrow();

    const duplicate = { ...command, expectedVersion: 3 };
    expect(await createSubscriptionChangeSchedule(created.value.id, duplicate, actor,
      changeScheduleContext("create", "change-duplicate", created.value.id, null, duplicate))).toMatchObject({
      ok: false, status: 409, error: { code: "SUBSCRIPTION_PENDING_CHANGE_EXISTS" }
    });
    expect(await cancelSubscription(created.value.id, { expectedVersion: 3, reason: "Baja incompatible" }, actor,
      context("change-cancel-blocked", { expectedVersion: 3, reason: "Baja incompatible" }))).toMatchObject({
      ok: false, status: 409, error: { code: "SUBSCRIPTION_PENDING_CHANGE_EXISTS" }
    });
    expect(await scheduleSubscriptionCancellation(created.value.id, { expectedVersion: 3, effectiveDate: created.value.nextRenewalDate, reason: "Baja futura incompatible" }, actor,
      context("change-future-cancel-blocked", { expectedVersion: 3, effectiveDate: created.value.nextRenewalDate, reason: "Baja futura incompatible" }))).toMatchObject({
      ok: false, status: 409, error: { code: "SUBSCRIPTION_PENDING_CHANGE_EXISTS" }
    });
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    await expect(prisma.$executeRaw`
      INSERT INTO "subscription_cancellation_schedules"
        ("companyId", "subscriptionId", "effectiveDate", "reason", "createdAgainstVersion", "requestedById", "updatedAt")
      VALUES (${companyId}::uuid, ${created.value.id}::uuid, ${created.value.nextRenewalDate}::date,
        'Intento SQL incompatible', 3, ${actor.id}::uuid, clock_timestamp())
    `).rejects.toThrow(/pending subscription change schedule/i);
    const revoke = { expectedSubscriptionVersion: 3, expectedScheduleVersion: 1, reason: "El cliente aplaza la ampliacion" };
    const revoked = await revokeSubscriptionChangeSchedule(created.value.id, scheduled.value.schedule.id, revoke, actor,
      changeScheduleContext("revoke", "change-revoke", created.value.id, scheduled.value.schedule.id, revoke));
    expect(revoked).toMatchObject({ ok: true, value: { subscriptionVersion: 4, schedule: { status: "REVOKED", version: 2 } } });
    await expect(prisma.subscriptionChangeSchedule.update({ where: { id: scheduled.value.schedule.id }, data: { reason: "Alteracion" } })).rejects.toThrow();
    await expect(prisma.subscriptionChangeScheduleLine.deleteMany({ where: { scheduleId: scheduled.value.schedule.id } })).rejects.toThrow();
    const audit = JSON.stringify(await prisma.auditEvent.findMany({ where: { eventType: { in: ["SUBSCRIPTION_CHANGE_SCHEDULED", "SUBSCRIPTION_CHANGE_SCHEDULE_REVOKED"] } }, select: { payload: true } }));
    expect(audit).not.toContain(command.reason);
    expect(audit).not.toContain(revoke.reason);
    expect(audit).not.toContain("3.000");
  });

  it("previews and applies a due quantity change in the renewal reservation transaction", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id);
    const renewalDate = todayDate();
    const createCommand = payload(customerId, itemId, {
      pricingMode: "PER_LICENSE", startDate: renewalDate,
      lines: [{ catalogItemId: itemId, quantity: "2.000", discountPercent: "0.00", discountAmount: "0.00" }]
    });
    const created = await createSubscription(createCommand, actor, context("change-apply-create", createCommand));
    if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("change-apply-activate", { version: 1 }));
    if (!activated.ok) throw new Error(activated.error.code);
    const scheduleCommand = {
      expectedVersion: 2, reason: "Ampliacion acordada para la siguiente renovacion",
      lines: [{ subscriptionLineId: created.value.lines[0]!.id, quantity: "3.000" }]
    };
    const scheduled = await createSubscriptionChangeSchedule(created.value.id, scheduleCommand, actor,
      changeScheduleContext("create", "change-apply-schedule", created.value.id, null, scheduleCommand));
    if (!scheduled.ok) throw new Error(scheduled.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;

    const preview = await listSubscriptionRenewalPreview({ processDate: renewalDate, includePending: false }, actor);
    expect(preview).toMatchObject({ ok: true, value: { groups: [{ estimatedTotal: "181.14", subscriptions: [{
      id: created.value.id, version: 3, estimatedTotal: "181.14",
      pendingChange: { scheduleId: scheduled.value.schedule.id, effectiveDate: renewalDate, lineCount: 1 }
    }] }] } });
    expect((await prisma.subscriptionLine.findUniqueOrThrow({ where: { id: created.value.lines[0]!.id } })).quantity.toFixed(3)).toBe("2.000");

    const renewal = { companyId, subscriptionIds: [created.value.id], expectedVersions: { [created.value.id]: 3 }, issueDate: renewalDate };
    await prisma.customer.update({ where: { id: customerId }, data: { status: "INACTIVE" } });
    expect(await createSubscriptionRenewalDraft(renewal, actor, renewalContext("change-apply-rollback", renewal))).toMatchObject({
      ok: false, status: 422, error: { code: "CUSTOMER_NOT_ACTIVE" }
    });
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: { version: true } })).toEqual({ version: 3 });
    expect((await prisma.subscriptionLine.findUniqueOrThrow({ where: { id: created.value.lines[0]!.id } })).quantity.toFixed(3)).toBe("2.000");
    expect(await prisma.subscriptionChangeSchedule.findUniqueOrThrow({ where: { id: scheduled.value.schedule.id }, select: { status: true, version: true } })).toEqual({ status: "PENDING", version: 1 });
    expect(await prisma.invoice.count({ where: { origin: "SUBSCRIPTION" } })).toBe(0);
    await prisma.customer.update({ where: { id: customerId }, data: { status: "ACTIVE" } });
    const result = await createSubscriptionRenewalDraft(renewal, actor, renewalContext("change-apply-renewal", renewal));
    expect(result).toMatchObject({ ok: true, status: 201, value: { lineCount: 1, total: "181.14" } });
    if (!result.ok || !result.value.invoiceId) throw new Error("CHANGE_RENEWAL_DRAFT_EXPECTED");
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: { version: true } })).toEqual({ version: 4 });
    expect((await prisma.subscriptionLine.findUniqueOrThrow({ where: { id: created.value.lines[0]!.id } })).quantity.toFixed(3)).toBe("3.000");
    expect(await prisma.subscriptionChangeSchedule.findUniqueOrThrow({ where: { id: scheduled.value.schedule.id }, select: {
      status: true, version: true, appliedAgainstVersion: true, appliedSubscriptionVersion: true
    } })).toEqual({ status: "APPLIED", version: 2, appliedAgainstVersion: 3, appliedSubscriptionVersion: 4 });
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: result.value.invoiceId }, include: {
      lines: true, subscriptionRenewalReservations: true
    } });
    expect(invoice.lines[0]!.quantity.toFixed(3)).toBe("3.000");
    expect(invoice.subscriptionRenewalReservations[0]).toMatchObject({ subscriptionVersionSnapshot: 4 });
    expect(await prisma.auditEvent.count({ where: { eventType: "SUBSCRIPTION_CHANGE_SCHEDULE_APPLIED", payload: {
      path: ["subscriptionId"], equals: created.value.id
    } } })).toBe(1);
  });

  it("blocks automatic application when the requester loses authority without retrying immediately", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id);
    const creation = payload(customerId, itemId, { startDate: "2026-01-01" });
    const created = await createSubscription(creation, actor, context("automation-auth-create", creation)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("automation-auth-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const cancellation = { expectedVersion: 2, reason: "Baja con autoridad diferida" };
    const cancelled = await cancelSubscription(created.value.id, cancellation, actor, context("automation-auth-cancel", cancellation)); if (!cancelled.ok) throw new Error(cancelled.error.code);
    const scheduleCommand = { expectedVersion: 3, effectiveDate: futureDate(), nextRenewalDate: futureDate(), reason: "Orden cuyo permiso sera retirado" };
    const scheduled = await createSubscriptionReactivationSchedule(created.value.id, scheduleCommand, actor,
      reactivationScheduleContext("create", "automation-auth-schedule", created.value.id, null, scheduleCommand));
    if (!scheduled.ok) throw new Error(scheduled.error.code);
    await makeReactivationScheduleDue(created.value.id, scheduled.value.schedule.id);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { roleId: true } });
    const permission = await prisma.permission.findUniqueOrThrow({ where: { code: "Subscriptions.ScheduleReactivations" }, select: { id: true } });
    await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: user.roleId, permissionId: permission.id } } });

    expect(await processNextDueSubscriptionReactivationSchedule("automation-worker-auth")).toMatchObject({
      outcome: "BLOCKED", stableCode: "SUBSCRIPTION_REACTIVATION_SCHEDULE_REQUESTER_NOT_AUTHORIZED"
    });
    expect(await processNextDueSubscriptionReactivationSchedule("automation-worker-auth-retry")).toEqual({ outcome: "IDLE" });
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: { status: true, version: true } })).toEqual({ status: "CANCELLED", version: 4 });
    const detail = await getSubscription(created.value.id, actor);
    expect(detail?.reactivationSchedules[0]?.lastAutomationAttempt).toMatchObject({
      attemptNumber: 1, outcome: "BLOCKED", stableCode: "SUBSCRIPTION_REACTIVATION_SCHEDULE_REQUESTER_NOT_AUTHORIZED"
    });
    const audits = await prisma.auditEvent.findMany({ where: {
      eventType: "SUBSCRIPTION_REACTIVATION_AUTOMATION_BLOCKED",
      payload: { path: ["subscriptionId"], equals: created.value.id }
    } });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]?.payload)).not.toContain(scheduleCommand.reason);
  });

  it("records and revokes a future cancellation without deleting its history", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const effectiveDate = futureDate(); const command = payload(customerId, itemId, { startDate: effectiveDate });
    const created = await createSubscription(command, actor, context("schedule-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("schedule-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const scheduleCommand = { expectedVersion: 2, effectiveDate, reason: "Baja al finalizar el periodo" };
    const scheduled = await scheduleSubscriptionCancellation(created.value.id, scheduleCommand, actor, context("schedule", scheduleCommand));
    const replay = await scheduleSubscriptionCancellation(created.value.id, scheduleCommand, actor, context("schedule", scheduleCommand));
    expect(scheduled).toMatchObject({ ok: true, status: 201, value: { subscriptionVersion: 3, schedule: { status: "PENDING", effectiveDate, version: 1 } } });
    expect(replay).toEqual(scheduled); if (!scheduled.ok) throw new Error(scheduled.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    expect(await prisma.$transaction((tx) => resolveScheduledCancellationBeforeRenewal(tx, { companyId, subscriptionId: created.value.id }))).toEqual({ outcome: "NOT_DUE", renewalDate: effectiveDate });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: { version: true } })).version).toBe(3);
    expect(await scheduleSubscriptionCancellation(created.value.id, { ...scheduleCommand, expectedVersion: 3 }, actor, context("schedule-second", scheduleCommand))).toMatchObject({ ok: false, status: 409, error: { code: "SUBSCRIPTION_PENDING_CANCELLATION_EXISTS" } });
    expect(await scheduleSubscriptionCancellation(created.value.id, { ...scheduleCommand, expectedVersion: 3, effectiveDate: nextDay(effectiveDate) }, actor, context("schedule-wrong-date", scheduleCommand))).toMatchObject({ ok: false, status: 422, error: { code: "SUBSCRIPTION_CANCELLATION_NOT_ON_RENEWAL" } });
    const detail = await getSubscription(created.value.id, actor); expect(detail?.cancellationSchedules).toMatchObject([{ id: scheduled.value.schedule.id, reason: scheduleCommand.reason, status: "PENDING" }]);
    expect(JSON.stringify(await listSubscriptions({ limit: 25 }, actor))).not.toContain(scheduleCommand.reason);
    const revokeCommand = { expectedSubscriptionVersion: 3, expectedScheduleVersion: 1, reason: "El cliente continua" };
    const revoked = await cancelScheduledSubscriptionCancellation(created.value.id, scheduled.value.schedule.id, revokeCommand, actor, context("schedule-revoke", revokeCommand));
    expect(revoked).toMatchObject({ ok: true, value: { subscriptionVersion: 4, schedule: { status: "REVOKED", version: 2, revocationReason: revokeCommand.reason } } });
    await expect(prisma.subscriptionCancellationSchedule.delete({ where: { id: scheduled.value.schedule.id } })).rejects.toThrow();
    await expect(prisma.subscriptionCancellationSchedule.update({ where: { id: scheduled.value.schedule.id }, data: { reason: "Alteracion" } })).rejects.toThrow();
    const auditText = JSON.stringify(await prisma.auditEvent.findMany({ where: { eventType: { in: ["SUBSCRIPTION_CANCELLATION_SCHEDULED", "SUBSCRIPTION_CANCELLATION_SCHEDULE_REVOKED"] } }, select: { payload: true } }));
    expect(auditText).not.toContain(scheduleCommand.reason); expect(auditText).not.toContain(revokeCommand.reason);
  });

  it("applies a due cancellation, preserves its schedule and allows a later reactivation", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const effectiveDate = todayDate(); const command = payload(customerId, itemId, { startDate: effectiveDate });
    const created = await createSubscription(command, actor, context("apply-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("apply-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    const reason = "Baja al llegar la renovacion";
    const scheduled = await seedDueCancellation(companyId, created.value.id, actor.id, reason);
    const applied = await prisma.$transaction((tx) => resolveScheduledCancellationBeforeRenewal(tx, { companyId, subscriptionId: created.value.id, initiatedByUserId: actor.id, correlationId: "apply-due" }));
    expect(applied).toMatchObject({ outcome: "CANCELLED", scheduleId: scheduled.id, subscriptionVersion: 4, applied: true });
    const replay = await prisma.$transaction((tx) => resolveScheduledCancellationBeforeRenewal(tx, { companyId, subscriptionId: created.value.id }));
    expect(replay).toMatchObject({ outcome: "CANCELLED", scheduleId: scheduled.id, subscriptionVersion: 4, applied: false });

    const stored = await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, include: { cancellationSchedules: true } });
    expect(stored).toMatchObject({ status: "CANCELLED", version: 4, cancellationMode: "SCHEDULED", cancelledById: actor.id, cancellationReason: reason });
    expect(stored.cancellationSchedules).toMatchObject([{ status: "APPLIED", version: 2, appliedAgainstVersion: 3, appliedSubscriptionVersion: 4 }]);
    await expect(prisma.subscriptionCancellationSchedule.update({ where: { id: scheduled.id }, data: { reason: "Alteracion" } })).rejects.toThrow();
    await expect(prisma.subscriptionCancellationSchedule.delete({ where: { id: scheduled.id } })).rejects.toThrow();
    const audit = await prisma.auditEvent.findMany({ where: { eventType: "SUBSCRIPTION_CANCELLATION_SCHEDULE_APPLIED", payload: { path: ["subscriptionId"], equals: created.value.id } }, select: { actorType: true, payload: true } });
    expect(audit).toHaveLength(1); expect(audit[0]?.actorType).toBe("SYSTEM"); expect(JSON.stringify(audit[0]?.payload)).not.toContain(reason);
    const reactivation = { expectedVersion: 4, nextRenewalDate: futureDate(), reason: "Reanudacion tras una baja programada" };
    expect(await reactivateSubscription(created.value.id, reactivation, actor, context("scheduled-reactivation", reactivation))).toMatchObject({
      ok: true, value: { status: "ACTIVE", version: 5, reactivations: [{ cancellation: { mode: "SCHEDULED", reason } }] }
    });
    expect(await prisma.subscriptionCancellationSchedule.findUniqueOrThrow({ where: { id: scheduled.id }, select: { status: true, version: true } })).toEqual({ status: "APPLIED", version: 2 });
  });

  it("rejects incomplete SQL application evidence and keeps foreign companies isolated", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const effectiveDate = todayDate(); const command = payload(customerId, itemId, { startDate: effectiveDate });
    const created = await createSubscription(command, actor, context("apply-db-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("apply-db-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    const reason = "Baja protegida";
    const scheduled = await seedDueCancellation(companyId, created.value.id, actor.id, reason);
    await expect(prisma.subscriptionCancellationSchedule.update({ where: { id: scheduled.id }, data: { status: "APPLIED", version: 2 } })).rejects.toThrow();
    const appliedAt = new Date();
    await expect(prisma.subscriptionCancellationSchedule.update({
      where: { id: scheduled.id },
      data: { status: "APPLIED", version: 2, appliedAt, appliedBusinessDate: new Date(`${effectiveDate}T00:00:00.000Z`), appliedAgainstVersion: null, appliedSubscriptionVersion: 4 }
    })).rejects.toThrow();
    await expect(prisma.$transaction(async (tx) => {
      await tx.subscriptionCancellationSchedule.update({
        where: { id: scheduled.id },
        data: {
          status: "APPLIED", version: 2, appliedAt,
          appliedBusinessDate: new Date(`${effectiveDate}T00:00:00.000Z`),
          appliedAgainstVersion: 3, appliedSubscriptionVersion: 4
        }
      });
    })).rejects.toThrow();
    const revokeCommand = { expectedSubscriptionVersion: 3, expectedScheduleVersion: 1, reason: "Retirada para prueba bilateral" };
    expect(await cancelScheduledSubscriptionCancellation(created.value.id, scheduled.id, revokeCommand, actor, context("apply-db-revoke", revokeCommand))).toMatchObject({ ok: true, value: { subscriptionVersion: 4 } });
    await expect(prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: created.value.id },
        data: {
          status: "CANCELLED", version: { increment: 1 }, cancellationMode: "SCHEDULED",
          cancelledById: actor.id, cancelledAt: new Date(),
          cancellationEffectiveDate: new Date(`${effectiveDate}T00:00:00.000Z`), cancellationReason: reason
        }
      });
    })).rejects.toThrow();
    const foreignCompany = await prisma.company.create({ data: { legalName: "Empresa renovacion ajena", taxId: `B${Date.now()}` } });
    expect(await prisma.$transaction((tx) => resolveScheduledCancellationBeforeRenewal(tx, { companyId: foreignCompany.id, subscriptionId: created.value.id }))).toEqual({ outcome: "NOT_FOUND" });
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: { status: true, version: true } })).toEqual({ status: "ACTIVE", version: 4 });
  });

  it("serializes application against revocation without leaving a pending or incoherent state", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const effectiveDate = todayDate(); const command = payload(customerId, itemId, { startDate: effectiveDate });
    const created = await createSubscription(command, actor, context("apply-race-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("apply-race-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    const scheduled = await seedDueCancellation(companyId, created.value.id, actor.id, "Baja en carrera");
    const revokeCommand = { expectedSubscriptionVersion: 3, expectedScheduleVersion: 1, reason: "Retirada concurrente" };
    await Promise.allSettled([
      prisma.$transaction((tx) => resolveScheduledCancellationBeforeRenewal(tx, { companyId, subscriptionId: created.value.id }), { isolationLevel: "Serializable" }),
      cancelScheduledSubscriptionCancellation(created.value.id, scheduled.id, revokeCommand, actor, context("apply-race-revoke", revokeCommand))
    ]);
    const stored = await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, include: { cancellationSchedules: true } });
    expect(stored.cancellationSchedules).toHaveLength(1);
    const schedule = stored.cancellationSchedules[0]!;
    expect(["APPLIED", "REVOKED"]).toContain(schedule.status);
    expect(await prisma.subscriptionCancellationSchedule.count({ where: { subscriptionId: created.value.id, status: "PENDING" } })).toBe(0);
    if (schedule.status === "APPLIED") expect(stored).toMatchObject({ status: "CANCELLED", cancellationMode: "SCHEDULED" });
    else expect(stored).toMatchObject({ status: "ACTIVE", cancellationMode: null });
  });

  it("converges two cancellation resolvers to one application and one audit event", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const effectiveDate = todayDate(); const command = payload(customerId, itemId, { startDate: effectiveDate });
    const created = await createSubscription(command, actor, context("apply-double-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("apply-double-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    await seedDueCancellation(companyId, created.value.id, actor.id, "Baja aplicada una sola vez");
    const results = await Promise.all([
      resolveCancellationWithRetry(companyId, created.value.id),
      resolveCancellationWithRetry(companyId, created.value.id)
    ]);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "CANCELLED", applied: true, subscriptionVersion: 4 }),
      expect.objectContaining({ outcome: "CANCELLED", applied: false, subscriptionVersion: 4 })
    ]));
    expect(await prisma.auditEvent.count({ where: { eventType: "SUBSCRIPTION_CANCELLATION_SCHEDULE_APPLIED", payload: { path: ["subscriptionId"], equals: created.value.id } } })).toBe(1);
  });

  it("serializes competing future cancellation requests and immediate cancellation revokes the winner", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const effectiveDate = futureDate(); const command = payload(customerId, itemId, { startDate: effectiveDate });
    const created = await createSubscription(command, actor, context("schedule-race-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("schedule-race-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const commands = ["Primera solicitud", "Segunda solicitud"].map((reason) => ({ expectedVersion: 2, effectiveDate, reason }));
    const results = await Promise.all(commands.map((value, index) => scheduleSubscriptionCancellation(created.value.id, value, actor, context(`schedule-race-${index}`, value))));
    expect(results.filter((result) => result.ok)).toHaveLength(1); expect(results.filter((result) => !result.ok)[0]).toMatchObject({ ok: false, status: 409 });
    await expect(prisma.subscription.update({ where: { id: created.value.id }, data: { status: "CANCELLED", cancelledById: actor.id, cancelledAt: new Date(), cancellationEffectiveDate: new Date(), cancellationReason: "Intento directo" } })).rejects.toThrow();
    const cancellation = { expectedVersion: 3, reason: "Baja inmediata" };
    expect(await cancelSubscription(created.value.id, cancellation, actor, context("schedule-race-immediate", cancellation))).toMatchObject({ ok: true, value: { status: "CANCELLED", version: 4 } });
    expect(await prisma.subscriptionCancellationSchedule.count({ where: { subscriptionId: created.value.id, status: "PENDING" } })).toBe(0);
    expect(await prisma.subscriptionCancellationSchedule.count({ where: { subscriptionId: created.value.id, status: "REVOKED" } })).toBe(1);
  });

  it("creates a complete reserved renewal draft from subscription snapshots without advancing the period", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const renewalDate = todayDate();
    const command = payload(customerId, itemId, { startDate: renewalDate });
    const created = await createSubscription(command, actor, context("renewal-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("renewal-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    await prisma.catalogItem.update({ where: { id: itemId }, data: { status: "INACTIVE", salePrice: "999.00" } });
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    const renewal = { companyId, subscriptionIds: [created.value.id], issueDate: renewalDate };
    const result = await createSubscriptionRenewalDraft(renewal, actor, renewalContext("renewal-draft", renewal));
    expect(result).toMatchObject({ ok: true, status: 201, value: { lineCount: 1, total: "60.38", cancelledSubscriptionIds: [] } });
    if (!result.ok || !result.value.invoiceId) throw new Error("RENEWAL_DRAFT_EXPECTED");
    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: result.value.invoiceId },
      include: { lines: true, taxSummaries: true, dueDates: true, subscriptionRenewalReservations: { include: { lines: true } } }
    });
    expect(invoice).toMatchObject({ origin: "SUBSCRIPTION", status: "DRAFT", total: expect.objectContaining({}), lines: [{ unitPrice: expect.objectContaining({}) }] });
    expect(invoice.total.toFixed(2)).toBe("60.38"); expect(invoice.lines[0]?.unitPrice.toFixed(2)).toBe("49.90");
    expect(invoice.taxSummaries).toHaveLength(1); expect(invoice.dueDates).toHaveLength(1);
    expect(invoice.dueDates[0]?.amount.toFixed(2)).toBe("60.38");
    expect(invoice.subscriptionRenewalReservations).toHaveLength(1);
    expect(invoice.subscriptionRenewalReservations[0]).toMatchObject({ status: "RESERVED", subscriptionVersionSnapshot: 2 });
    expect(invoice.subscriptionRenewalReservations[0]?.lines).toHaveLength(1);
    const unchanged = await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: { nextRenewalDate: true, version: true } });
    expect(unchanged.nextRenewalDate.toISOString().slice(0, 10)).toBe(renewalDate); expect(unchanged.version).toBe(2);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUBSCRIPTION_RENEWAL_DRAFT_RESERVED", payload: { path: ["invoiceId"], equals: invoice.id } } });
    expect(JSON.stringify(audit.payload)).not.toContain("49.90"); expect(JSON.stringify(audit.payload)).not.toContain(invoice.customerTaxIdSnapshot);
  });

  it("replays the same renewal and rejects competing reservations for the same period", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const renewalDate = todayDate();
    const command = payload(customerId, itemId, { startDate: renewalDate });
    const created = await createSubscription(command, actor, context("renewal-idem-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("renewal-idem-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    const renewal = { companyId, subscriptionIds: [created.value.id], issueDate: renewalDate };
    const competing = await Promise.all([
      createSubscriptionRenewalDraft(renewal, actor, renewalContext("renewal-idem-a", renewal)),
      createSubscriptionRenewalDraft(renewal, actor, renewalContext("renewal-idem-b", renewal))
    ]);
    expect(competing.filter((result) => result.ok)).toHaveLength(1);
    expect(competing.find((result) => !result.ok)).toMatchObject({ ok: false, status: 409, error: { code: "SUBSCRIPTION_RENEWAL_ALREADY_RESERVED" } });
    const successfulIndex = competing.findIndex((result) => result.ok);
    const first = competing[successfulIndex]!;
    const replay = await createSubscriptionRenewalDraft(renewal, actor, renewalContext(successfulIndex === 0 ? "renewal-idem-a" : "renewal-idem-b", renewal));
    expect(replay).toEqual(first); expect(await prisma.invoice.count({ where: { origin: "SUBSCRIPTION" } })).toBe(1);
    expect(await prisma.subscriptionRenewalReservation.count()).toBe(1);
  });

  it("applies a due scheduled cancellation before drafting and emits no invoice when every source is cancelled", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const renewalDate = todayDate();
    const command = payload(customerId, itemId, { startDate: renewalDate });
    const created = await createSubscription(command, actor, context("renewal-cancel-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("renewal-cancel-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    await seedDueCancellation(companyId, created.value.id, actor.id, "Baja previa a facturacion");
    const renewal = { companyId, subscriptionIds: [created.value.id], issueDate: renewalDate };
    expect(await createSubscriptionRenewalDraft(renewal, actor, renewalContext("renewal-cancel", renewal))).toMatchObject({
      ok: true, status: 200, value: { invoiceId: null, reservationIds: [], cancelledSubscriptionIds: [created.value.id] }
    });
    expect(await prisma.invoice.count({ where: { origin: "SUBSCRIPTION" } })).toBe(0);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: { status: true } })).toEqual({ status: "CANCELLED" });
  });

  it("blocks cancellation and direct economic edits while a renewal reservation is active", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const renewalDate = todayDate();
    const command = payload(customerId, itemId, { startDate: renewalDate });
    const created = await createSubscription(command, actor, context("renewal-lock-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("renewal-lock-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    const renewal = { companyId, subscriptionIds: [created.value.id], issueDate: renewalDate };
    const draft = await createSubscriptionRenewalDraft(renewal, actor, renewalContext("renewal-lock", renewal)); if (!draft.ok || !draft.value.invoiceId) throw new Error("RENEWAL_DRAFT_EXPECTED");
    expect(await issueInvoice(draft.value.invoiceId, { issueDate: renewalDate }, actor)).toMatchObject({ ok: false, status: 409, error: { code: "INVOICE_NOT_ISSUABLE" } });
    expect(await cancelSubscription(created.value.id, { expectedVersion: 2, reason: "Intento con reserva activa" }, actor, context("renewal-lock-cancel", { expectedVersion: 2 }))).toMatchObject({ ok: false, status: 409, error: { code: "SUBSCRIPTION_RENEWAL_RESERVED" } });
    const line = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: draft.value.invoiceId } });
    await expect(prisma.invoiceLine.update({ where: { id: line.id }, data: { description: "Edicion prohibida" } })).rejects.toThrow();
    await expect(prisma.invoiceDueDate.deleteMany({ where: { invoiceId: draft.value.invoiceId } })).rejects.toThrow();
    await expect(prisma.subscriptionRenewalReservation.deleteMany({ where: { invoiceId: draft.value.invoiceId } })).rejects.toThrow();
  });

  it("previews due groups and releases a reserved draft idempotently", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const renewalDate = todayDate();
    const command = payload(customerId, itemId, { startDate: renewalDate });
    const created = await createSubscription(command, actor, context("release-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("release-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const before = await listSubscriptionRenewalPreview({ processDate: renewalDate, includePending: false }, actor);
    expect(before).toMatchObject({ ok: true, value: { groups: [{ subscriptions: [{ id: created.value.id, version: 2, action: "INVOICE" }] }], reservedInvoices: [] } });
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    const renewal = { companyId, subscriptionIds: [created.value.id], expectedVersions: { [created.value.id]: 2 }, issueDate: renewalDate };
    const draft = await createSubscriptionRenewalDraft(renewal, actor, renewalContext("release-draft", renewal)); if (!draft.ok || !draft.value.invoiceId) throw new Error("RENEWAL_DRAFT_EXPECTED");
    expect(await listSubscriptionRenewalPreview({ processDate: renewalDate, includePending: false }, actor)).toMatchObject({ ok: true, value: { groups: [], reservedInvoices: [{ invoiceId: draft.value.invoiceId, subscriptionCount: 1 }] } });
    const release = { companyId, invoiceId: draft.value.invoiceId, reason: "Correccion operativa de la seleccion" };
    const first = await releaseSubscriptionRenewal(release, actor, releaseContext("release", release));
    const replay = await releaseSubscriptionRenewal(release, actor, releaseContext("release", release));
    expect(first).toMatchObject({ ok: true, status: 200, value: { invoiceId: draft.value.invoiceId, subscriptionIds: [created.value.id] } });
    expect(replay).toEqual(first);
    expect(await prisma.subscriptionRenewalReservation.findFirstOrThrow({ where: { invoiceId: draft.value.invoiceId }, select: { status: true, releaseReason: true } })).toEqual({ status: "RELEASED", releaseReason: release.reason });
    await expect(prisma.invoice.update({ where: { id: draft.value.invoiceId }, data: { notes: "Cambio prohibido" } })).rejects.toThrow();
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUBSCRIPTION_RENEWAL_RELEASED", payload: { path: ["invoiceId"], equals: draft.value.invoiceId } } });
    expect(JSON.stringify(audit.payload)).not.toContain(release.reason);
    expect(await listSubscriptionRenewalPreview({ processDate: renewalDate, includePending: false }, actor)).toMatchObject({ ok: true, value: { groups: [{ subscriptions: [{ id: created.value.id }] }], reservedInvoices: [] } });
  });

  it("serializes release against confirmation to one coherent terminal outcome", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); await prisma.customer.update({ where: { id: customerId }, data: { code: "5" } });
    const itemId = await catalogItem(actor.id); const renewalDate = todayDate(); const command = payload(customerId, itemId, { startDate: renewalDate });
    const created = await createSubscription(command, actor, context("release-race-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("release-race-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!; await seedInvoiceAccounts(actor.id, "5");
    const renewal = { companyId, subscriptionIds: [created.value.id], issueDate: renewalDate };
    const draft = await createSubscriptionRenewalDraft(renewal, actor, renewalContext("release-race-draft", renewal)); if (!draft.ok || !draft.value.invoiceId) throw new Error("RENEWAL_DRAFT_EXPECTED");
    const confirmation = { companyId, invoiceId: draft.value.invoiceId }; const release = { ...confirmation, reason: "Liberacion concurrente" };
    const outcomes = await Promise.all([
      confirmSubscriptionRenewal(confirmation, actor, confirmationContext("release-race-confirm", confirmation), { verifactuEnabled: false }),
      releaseSubscriptionRenewal(release, actor, releaseContext("release-race-release", release))
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    const reservation = await prisma.subscriptionRenewalReservation.findFirstOrThrow({ where: { invoiceId: draft.value.invoiceId }, select: { status: true } });
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.value.invoiceId }, select: { status: true } });
    expect([["BILLED", "ISSUED"], ["RELEASED", "DRAFT"]]).toContainEqual([reservation.status, invoice.status]);
  });

  it("confirms a grouped renewal atomically and replays without duplicating fiscal effects", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); await prisma.customer.update({ where: { id: customerId }, data: { code: "1" } });
    const itemId = await catalogItem(actor.id); const renewalDate = todayDate();
    const commands = ["Renovacion agrupada A", "Renovacion agrupada B"].map((name) => payload(customerId, itemId, { name, startDate: renewalDate }));
    const created = [];
    for (const [index, command] of commands.entries()) {
      const draft = await createSubscription(command, actor, context(`confirm-create-${index}`, command)); if (!draft.ok) throw new Error(draft.error.code);
      const active = await activateSubscription(draft.value.id, { version: 1 }, actor, context(`confirm-activate-${index}`, { version: 1 })); if (!active.ok) throw new Error(active.error.code);
      created.push(active.value);
    }
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    await seedInvoiceAccounts(actor.id, "1");
    const draftCommand = { companyId, subscriptionIds: created.map((subscription) => subscription.id), issueDate: renewalDate };
    const reserved = await createSubscriptionRenewalDraft(draftCommand, actor, renewalContext("confirm-draft", draftCommand));
    if (!reserved.ok || !reserved.value.invoiceId) throw new Error("RENEWAL_DRAFT_EXPECTED");
    const confirmation = { companyId, invoiceId: reserved.value.invoiceId };
    const first = await confirmSubscriptionRenewal(confirmation, actor, confirmationContext("confirm", confirmation), { verifactuEnabled: false });
    const replay = await confirmSubscriptionRenewal(confirmation, actor, confirmationContext("confirm", confirmation), { verifactuEnabled: false });
    expect(first).toMatchObject({ ok: true, status: 200, value: { invoiceId: reserved.value.invoiceId, subscriptions: [{ version: 3 }, { version: 3 }] } });
    expect(replay).toEqual(first); if (!first.ok) throw new Error(first.error.code);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: reserved.value.invoiceId }, include: { accountingEntry: true, subscriptionRenewalReservations: true } });
    expect(invoice.status).toBe("ISSUED"); expect(invoice.number).toBe(first.value.number); expect(invoice.accountingEntry).not.toBeNull();
    expect(invoice.subscriptionRenewalReservations).toHaveLength(2);
    expect(invoice.subscriptionRenewalReservations.every((reservation) => reservation.status === "BILLED" && reservation.billedAt?.getTime() === invoice.issuedAt?.getTime())).toBe(true);
    const storedSubscriptions = await prisma.subscription.findMany({ where: { id: { in: created.map((subscription) => subscription.id) } }, orderBy: { id: "asc" }, select: { status: true, version: true, nextRenewalDate: true } });
    expect(storedSubscriptions.every((subscription) => subscription.status === "ACTIVE" && subscription.version === 3 && subscription.nextRenewalDate > new Date(`${renewalDate}T00:00:00.000Z`))).toBe(true);
    expect(await prisma.accountingJournalEntry.count({ where: { invoiceId: invoice.id } })).toBe(1);
    const renewalAudit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUBSCRIPTION_RENEWAL_BILLED", payload: { path: ["invoiceId"], equals: invoice.id } } });
    const accountingEntry = await prisma.accountingJournalEntry.findUniqueOrThrow({ where: { invoiceId: invoice.id }, include: { lines: { take: 1 } } });
    await expect(prisma.accountingJournalEntry.update({ where: { id: accountingEntry.id }, data: { status: "VOIDED" } })).rejects.toThrow();
    await expect(prisma.accountingJournalLine.delete({ where: { id: accountingEntry.lines[0]!.id } })).rejects.toThrow();
    await expect(prisma.auditEvent.delete({ where: { id: renewalAudit.id } })).rejects.toThrow();
    const replayEvidence = await prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: confirmationContext("confirm", confirmation).idempotencyKey } });
    await expect(prisma.idempotencyRecord.delete({ where: { id: replayEvidence.id } })).rejects.toThrow();
    await expect(prisma.invoiceVerifactuRecord.delete({ where: { invoiceId: invoice.id } })).rejects.toThrow();
    const dueDate = await prisma.invoiceDueDate.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(await prisma.invoiceDueDate.update({ where: { id: dueDate.id }, data: { status: "PAID" }, select: { status: true } })).toEqual({ status: "PAID" });
    await expect(prisma.invoiceDueDate.update({ where: { id: dueDate.id }, data: { amount: "1.00" } })).rejects.toThrow();
    expect(await prisma.auditEvent.count({ where: { eventType: "SUBSCRIPTION_RENEWAL_BILLED", payload: { path: ["invoiceId"], equals: invoice.id } } })).toBe(1);
    expect(JSON.stringify(renewalAudit.payload)).not.toContain("49.90"); expect(JSON.stringify(renewalAudit.payload)).not.toContain(invoice.customerTaxIdSnapshot);
  });

  it("rolls back confirmation when accounting prerequisites are missing", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); await prisma.customer.update({ where: { id: customerId }, data: { code: "2" } });
    const itemId = await catalogItem(actor.id); const renewalDate = todayDate(); const command = payload(customerId, itemId, { startDate: renewalDate });
    const created = await createSubscription(command, actor, context("confirm-rollback-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("confirm-rollback-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    const draftCommand = { companyId, subscriptionIds: [created.value.id], issueDate: renewalDate };
    const reserved = await createSubscriptionRenewalDraft(draftCommand, actor, renewalContext("confirm-rollback-draft", draftCommand)); if (!reserved.ok || !reserved.value.invoiceId) throw new Error("RENEWAL_DRAFT_EXPECTED");
    const confirmation = { companyId, invoiceId: reserved.value.invoiceId };
    expect(await confirmSubscriptionRenewal(confirmation, actor, confirmationContext("confirm-rollback", confirmation), { verifactuEnabled: false })).toMatchObject({ ok: false, status: 409, error: { code: "INVOICE_ACCOUNTING_ACCOUNT_NOT_AVAILABLE" } });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: reserved.value.invoiceId }, select: { status: true, number: true } })).toEqual({ status: "DRAFT", number: null });
    expect(await prisma.subscriptionRenewalReservation.findFirstOrThrow({ where: { invoiceId: reserved.value.invoiceId }, select: { status: true } })).toEqual({ status: "RESERVED" });
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: { status: true, version: true, nextRenewalDate: true } })).toMatchObject({ status: "ACTIVE", version: 2, nextRenewalDate: new Date(`${renewalDate}T00:00:00.000Z`) });
    expect(await prisma.accountingJournalEntry.count({ where: { invoiceId: reserved.value.invoiceId } })).toBe(0);
    expect(await prisma.subscriptionRenewalAttempt.findMany({ where: { invoiceId: reserved.value.invoiceId }, orderBy: { attemptedAt: "asc" }, select: { phase: true, outcome: true, errorCode: true } })).toEqual([
      { phase: "PREPARE", outcome: "SUCCEEDED", errorCode: null },
      { phase: "CONFIRM", outcome: "FAILED", errorCode: "INVOICE_ACCOUNTING_ACCOUNT_NOT_AVAILABLE" }
    ]);
  });

  it("returns a stable 503 and rolls back all late effects when VeriFactu preparation is unavailable", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); await prisma.customer.update({ where: { id: customerId }, data: { code: "4" } });
    const itemId = await catalogItem(actor.id); const renewalDate = todayDate(); const command = payload(customerId, itemId, { startDate: renewalDate });
    const created = await createSubscription(command, actor, context("confirm-vf-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("confirm-vf-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!; await seedInvoiceAccounts(actor.id, "4");
    const draftCommand = { companyId, subscriptionIds: [created.value.id], issueDate: renewalDate };
    const reserved = await createSubscriptionRenewalDraft(draftCommand, actor, renewalContext("confirm-vf-draft", draftCommand)); if (!reserved.ok || !reserved.value.invoiceId) throw new Error("RENEWAL_DRAFT_EXPECTED");
    const sequenceBefore = await prisma.invoiceNumberSequence.findUnique({ where: { series_year: { series: "F", year: 2026 } }, select: { nextNumber: true } });
    await prisma.verifactuSifInstallation.create({ data: testSifInstallation(companyId) });
    const confirmation = { companyId, invoiceId: reserved.value.invoiceId };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(await confirmSubscriptionRenewal(confirmation, actor, confirmationContext(`confirm-vf-${attempt}`, confirmation), { verifactuEnabled: true, verifactuEnvironment: "TEST", prepareVerifactuAlta: () => ({ ok: false, error: { code: "TEST_PREPARATION_FAILURE" } }) })).toMatchObject({ ok: false, status: 503, error: { code: "INVOICE_VERIFACTU_PREPARATION_UNAVAILABLE" } });
    }
    expect(await confirmSubscriptionRenewal(confirmation, actor, confirmationContext("confirm-vf-limited", confirmation), { verifactuEnabled: true, verifactuEnvironment: "TEST", prepareVerifactuAlta: () => ({ ok: false, error: { code: "TEST_PREPARATION_FAILURE" } }) })).toMatchObject({ ok: false, status: 429, error: { code: "SUBSCRIPTION_RENEWAL_RATE_LIMITED" } });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: reserved.value.invoiceId }, select: { status: true, number: true, verifactuStatus: true } })).toEqual({ status: "DRAFT", number: null, verifactuStatus: "NOT_APPLICABLE" });
    expect(await prisma.subscriptionRenewalReservation.findFirstOrThrow({ where: { invoiceId: reserved.value.invoiceId }, select: { status: true, billedAt: true } })).toEqual({ status: "RESERVED", billedAt: null });
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: { version: true, nextRenewalDate: true } })).toMatchObject({ version: 2, nextRenewalDate: new Date(`${renewalDate}T00:00:00.000Z`) });
    expect(await prisma.accountingJournalEntry.count({ where: { invoiceId: reserved.value.invoiceId } })).toBe(0);
    expect(await prisma.verifactuFiscalRecord.count({ where: { invoiceId: reserved.value.invoiceId } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { eventType: { in: ["INVOICE_ISSUED", "VERIFACTU_RECORD_PREPARED", "SUBSCRIPTION_RENEWAL_BILLED"] }, payload: { path: ["invoiceId"], equals: reserved.value.invoiceId } } })).toBe(0);
    expect(await prisma.idempotencyRecord.count({ where: { key: { startsWith: "subscription-renewal-confirmations-test:confirm-vf" } } })).toBe(0);
    expect(await prisma.invoiceNumberSequence.findUnique({ where: { series_year: { series: "F", year: 2026 } }, select: { nextNumber: true } })).toEqual(sequenceBefore);
    expect(await prisma.subscriptionRenewalAttempt.count({ where: { invoiceId: reserved.value.invoiceId, phase: "CONFIRM", outcome: "FAILED" } })).toBe(10);
  });

  it("serializes competing confirmations to one invoice number and one advancement", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); await prisma.customer.update({ where: { id: customerId }, data: { code: "3" } });
    const itemId = await catalogItem(actor.id); const renewalDate = todayDate(); const command = payload(customerId, itemId, { startDate: renewalDate });
    const created = await createSubscription(command, actor, context("confirm-race-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("confirm-race-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!; await seedInvoiceAccounts(actor.id, "3");
    const draftCommand = { companyId, subscriptionIds: [created.value.id], issueDate: renewalDate };
    const reserved = await createSubscriptionRenewalDraft(draftCommand, actor, renewalContext("confirm-race-draft", draftCommand)); if (!reserved.ok || !reserved.value.invoiceId) throw new Error("RENEWAL_DRAFT_EXPECTED");
    const confirmation = { companyId, invoiceId: reserved.value.invoiceId };
    const results = await Promise.all([
      confirmSubscriptionRenewal(confirmation, actor, confirmationContext("confirm-race-a", confirmation), { verifactuEnabled: false }),
      confirmSubscriptionRenewal(confirmation, actor, confirmationContext("confirm-race-b", confirmation), { verifactuEnabled: false })
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ ok: false, status: 409, error: { code: "SUBSCRIPTION_RENEWAL_INVOICE_NOT_CONFIRMABLE" } });
    expect(await prisma.accountingJournalEntry.count({ where: { invoiceId: reserved.value.invoiceId } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { eventType: "SUBSCRIPTION_RENEWAL_BILLED", payload: { path: ["invoiceId"], equals: reserved.value.invoiceId } } })).toBe(1);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: { version: true } })).toEqual({ version: 3 });
  });

  it("rejects advancing a renewal period without billed invoice evidence", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const renewalDate = todayDate();
    const command = payload(customerId, itemId, { startDate: renewalDate });
    const created = await createSubscription(command, actor, context("advance-db-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("advance-db-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const nextRenewalDate = new Date(new Date(`${renewalDate}T00:00:00.000Z`).setUTCMonth(new Date(`${renewalDate}T00:00:00.000Z`).getUTCMonth() + 1));
    await expect(prisma.subscription.update({ where: { id: created.value.id }, data: { nextRenewalDate, version: { increment: 1 } } })).rejects.toThrow();
  });

  it("opens, explicitly retries and bills a manual renewal exclusion", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const renewalDate = todayDate();
    await prisma.customer.update({ where: { id: customerId }, data: { code: "8" } });
    await seedInvoiceAccounts(actor.id, "8");
    const command = payload(customerId, itemId, { startDate: renewalDate });
    const created = await createSubscription(command, actor, context("exclude-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("exclude-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow()).companyId!;
    const exclusionCommand = {
      companyId, subscriptionId: created.value.id, expectedVersion: 2,
      periodStart: renewalDate, processDate: renewalDate, reason: "Pendiente de validacion comercial"
    };
    const excluded = await excludeSubscriptionRenewal(exclusionCommand, actor, exclusionContext("manual", exclusionCommand));
    expect(excluded).toMatchObject({ ok: true, status: 201, value: { subscriptionId: created.value.id, status: "RENEWAL_PENDING", version: 3 } });
    if (!excluded.ok) throw new Error(excluded.error.code);
    expect(JSON.stringify((await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUBSCRIPTION_RENEWAL_EXCLUDED" } })).payload)).not.toContain(exclusionCommand.reason);
    expect(await excludeSubscriptionRenewal(exclusionCommand, actor, exclusionContext("manual", exclusionCommand))).toEqual(excluded);
    expect(await listSubscriptionRenewalPreview({ processDate: renewalDate, includePending: false }, actor)).toMatchObject({ ok: true, value: { groups: [] } });
    expect(await listSubscriptionRenewalPreview({ processDate: renewalDate, includePending: true }, actor)).toMatchObject({
      ok: true, value: { groups: [{ subscriptions: [{ id: created.value.id, status: "RENEWAL_PENDING", pending: { exclusionId: excluded.value.exclusionId, attemptCount: 0 } }] }] }
    });
    const missingEvidence = { companyId, subscriptionIds: [created.value.id], expectedVersions: { [created.value.id]: 3 }, issueDate: renewalDate };
    expect(await createSubscriptionRenewalDraft(missingEvidence, actor, renewalContext("pending-missing", missingEvidence))).toMatchObject({
      ok: false, status: 409, error: { code: "SUBSCRIPTION_RENEWAL_PENDING_SELECTION_REQUIRED" }
    });
    const retry = {
      ...missingEvidence,
      pendingExclusionIds: { [created.value.id]: excluded.value.exclusionId }
    };
    const draft = await createSubscriptionRenewalDraft(retry, actor, renewalContext("pending-retry", retry));
    expect(draft).toMatchObject({ ok: true, status: 201 }); if (!draft.ok || !draft.value.invoiceId) throw new Error("RENEWAL_DRAFT_EXPECTED");
    const reservedQueue = await listSubscriptionRenewalExclusions({ limit: 25, workState: "RESERVED" }, actor);
    expect(reservedQueue).toMatchObject({ ok: true, value: { exclusions: [{ id: excluded.value.exclusionId, work: { state: "RESERVED", action: null, reservation: { invoiceId: draft.value.invoiceId } } }] } });
    if (!reservedQueue.ok) throw new Error(reservedQueue.error.code);
    expect(reservedQueue.value.exclusions[0]).not.toHaveProperty("retrySelection");
    const blockedWaiver = { companyId, subscriptionId: created.value.id, exclusionId: excluded.value.exclusionId, expectedVersion: 3, reasonCode: "COMMERCIAL_WAIVER" as const, reasonDetail: "Condonacion bloqueada por reserva activa" };
    expect(await waiveSubscriptionRenewal(blockedWaiver, actor, waiverContext("reserved", blockedWaiver))).toMatchObject({ ok: false, status: 409, error: { code: "SUBSCRIPTION_RENEWAL_ALREADY_RESERVED" } });
    expect(await prisma.subscriptionRenewalExclusion.findUniqueOrThrow({ where: { id: excluded.value.exclusionId }, select: { attemptCount: true, status: true } })).toEqual({ attemptCount: 1, status: "OPEN" });
    const release = { companyId, invoiceId: draft.value.invoiceId, reason: "Revisar antes de emitir" };
    expect(await releaseSubscriptionRenewal(release, actor, releaseContext("pending-release", release))).toMatchObject({ ok: true, status: 200 });
    expect(await prisma.subscriptionRenewalExclusion.findUniqueOrThrow({ where: { id: excluded.value.exclusionId }, select: { attemptCount: true, status: true } })).toEqual({ attemptCount: 1, status: "OPEN" });
    const secondDraft = await createSubscriptionRenewalDraft(retry, actor, renewalContext("pending-retry-after-release", retry));
    expect(secondDraft).toMatchObject({ ok: true, status: 201 }); if (!secondDraft.ok || !secondDraft.value.invoiceId) throw new Error("RENEWAL_DRAFT_EXPECTED");
    const confirmation = { companyId, invoiceId: secondDraft.value.invoiceId };
    expect(await confirmSubscriptionRenewal(confirmation, actor, confirmationContext("pending-confirm", confirmation))).toMatchObject({ ok: true, status: 200 });
    expect(await prisma.subscriptionRenewalExclusion.findUniqueOrThrow({ where: { id: excluded.value.exclusionId }, select: { status: true, resolution: true, resolvedInvoiceId: true } })).toEqual({
      status: "RESOLVED", resolution: "BILLED", resolvedInvoiceId: secondDraft.value.invoiceId
    });
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: { status: true, version: true } })).toEqual({ status: "ACTIVE", version: 4 });
    const cancellation = { expectedVersion: 4, reason: "Fin temporal tras una incidencia ya facturada" };
    expect(await cancelSubscription(created.value.id, cancellation, actor, context("exclude-billed-cancel", cancellation))).toMatchObject({
      ok: true, value: { status: "CANCELLED", version: 5 }
    });
    const stored = await prisma.subscription.findUniqueOrThrow({ where: { id: created.value.id }, select: { nextRenewalDate: true } });
    const reactivation = {
      expectedVersion: 5,
      nextRenewalDate: stored.nextRenewalDate.toISOString().slice(0, 10),
      reason: "Reanudacion sin alterar la evidencia ya facturada"
    };
    expect(await reactivateSubscription(created.value.id, reactivation, actor, context("exclude-billed-reactivate", reactivation))).toMatchObject({
      ok: true, value: { status: "ACTIVE", version: 6 }
    });
    expect(await prisma.subscriptionRenewalExclusion.findUniqueOrThrow({ where: { id: excluded.value.exclusionId }, select: { status: true, resolution: true, resolvedInvoiceId: true } })).toEqual({
      status: "RESOLVED", resolution: "BILLED", resolvedInvoiceId: secondDraft.value.invoiceId
    });
  });

  it("requires database evidence for pending and closes it on cancellation", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const renewalDate = todayDate();
    const command = payload(customerId, itemId, { startDate: renewalDate });
    const created = await createSubscription(command, actor, context("exclude-cancel-create", command)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("exclude-cancel-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    await expect(prisma.subscription.update({ where: { id: created.value.id }, data: { status: "RENEWAL_PENDING", version: { increment: 1 } } })).rejects.toThrow();
    const companyId = (await prisma.installation.findFirstOrThrow()).companyId!;
    const exclusionCommand = { companyId, subscriptionId: created.value.id, expectedVersion: 2, periodStart: renewalDate, processDate: renewalDate, reason: "Exclusion previa a baja" };
    const excluded = await excludeSubscriptionRenewal(exclusionCommand, actor, exclusionContext("cancel", exclusionCommand)); if (!excluded.ok) throw new Error(excluded.error.code);
    const cancelCommand = { expectedVersion: 3, reason: "Baja definitiva" };
    expect(await cancelSubscription(created.value.id, cancelCommand, actor, context("exclude-cancel", cancelCommand))).toMatchObject({ ok: true, value: { status: "CANCELLED" } });
    expect(await prisma.subscriptionRenewalExclusion.findUniqueOrThrow({ where: { id: excluded.value.exclusionId }, select: { status: true, resolution: true } })).toEqual({ status: "RESOLVED", resolution: "CANCELLED" });
  });

  it("lists pending renewal cases with stable cursor, redaction and safe audit", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const renewalDate = todayDate();
    const queueCorrelationId = randomUUID();
    const companyId = (await prisma.installation.findFirstOrThrow()).companyId!;
    for (let index = 0; index < 2; index += 1) {
      const createCommand = payload(customerId, itemId, { name: `Pendiente cola ${index}`, startDate: renewalDate });
      const created = await createSubscription(createCommand, actor, context(`queue-create-${index}`, createCommand)); if (!created.ok) throw new Error(created.error.code);
      const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context(`queue-activate-${index}`, { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
      const exclusionCommand = { companyId, subscriptionId: created.value.id, expectedVersion: 2, periodStart: renewalDate, processDate: renewalDate, reason: `Motivo privado cola ${index}` };
      const excluded = await excludeSubscriptionRenewal(exclusionCommand, actor, exclusionContext(`queue-exclude-${index}`, exclusionCommand)); if (!excluded.ok) throw new Error(excluded.error.code);
    }
    expect(listSubscriptionRenewalExclusionsSchema.safeParse({ limit: "1e2" }).success).toBe(false);
    const first = await listSubscriptionRenewalExclusions({ limit: 1 }, actor, { correlationId: `${queueCorrelationId}:one` });
    expect(first).toMatchObject({ ok: true, value: { exclusions: [{ reasonCode: "MANUAL_EXCLUSION", hasReason: true, work: { state: "READY", action: "INVOICE" } }] } });
    if (!first.ok || !first.value.nextCursor) throw new Error("QUEUE_CURSOR_MISSING");
    expect(listSubscriptionRenewalExclusionsSchema.safeParse({ limit: 1, cursor: first.value.nextCursor }).success).toBe(true);
    expect(first.value.exclusions[0]!.reason).toMatch(/^Motivo privado cola [01]$/);
    const tamperedCursor = `${first.value.nextCursor.slice(0, -1)}${first.value.nextCursor.endsWith("A") ? "B" : "A"}`;
    expect(await listSubscriptionRenewalExclusions({ limit: 1, cursor: tamperedCursor }, actor)).toMatchObject({ ok: false, status: 422, error: { code: "SUBSCRIPTION_RENEWAL_PENDING_CURSOR_INVALID" } });
    const anchorCancellation = { expectedVersion: first.value.exclusions[0]!.subscription.version, reason: "Cerrar ancla paginada" };
    expect(await cancelSubscription(first.value.exclusions[0]!.subscription.id, anchorCancellation, actor, context("queue-close-anchor", anchorCancellation))).toMatchObject({ ok: true, value: { status: "CANCELLED" } });
    const restricted = { ...actor, permissions: actor.permissions.filter((permission) => permission !== "Subscriptions.ManageRenewalExclusions") };
    const second = await listSubscriptionRenewalExclusions({ limit: 1, cursor: first.value.nextCursor }, restricted, { correlationId: `${queueCorrelationId}:two` });
    expect(second).toMatchObject({ ok: true, value: { exclusions: [{ hasReason: true, work: { state: "READY" } }], nextCursor: null } });
    if (!second.ok) throw new Error(second.error.code);
    expect(second.value.exclusions[0]).not.toHaveProperty("reason");
    expect(await listSubscriptionRenewalExclusions({ limit: 1, cursor: first.value.nextCursor, reasonCode: "PREPARATION_FAILED" }, actor)).toMatchObject({ ok: false, status: 422, error: { code: "SUBSCRIPTION_RENEWAL_PENDING_CURSOR_INVALID" } });
    const audits = await prisma.auditEvent.findMany({ where: {
      eventType: "SUBSCRIPTION_RENEWAL_PENDING_VIEWED",
      OR: [
        { payload: { path: ["correlationId"], equals: `${queueCorrelationId}:one` } },
        { payload: { path: ["correlationId"], equals: `${queueCorrelationId}:two` } }
      ]
    }, orderBy: { createdAt: "asc" }, select: { payload: true } });
    expect(audits).toHaveLength(2);
    const serializedAudit = JSON.stringify(audits);
    expect(serializedAudit).not.toContain("Motivo privado");
    expect(serializedAudit).not.toContain(first.value.nextCursor);
    expect(audits[1]!.payload).toMatchObject({ reasonDetailAuthorized: false, reasonDetailDisclosedCount: 0 });
  });

  it("waives one pending period without billing and preserves terminal evidence", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const renewalDate = todayDate();
    const createCommand = payload(customerId, itemId, { name: "Periodo condonado", startDate: renewalDate });
    const created = await createSubscription(createCommand, actor, context("waive-create", createCommand)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("waive-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow()).companyId!;
    const exclusionCommand = { companyId, subscriptionId: created.value.id, expectedVersion: 2, periodStart: renewalDate, processDate: renewalDate, reason: "Pendiente de acuerdo comercial" };
    const excluded = await excludeSubscriptionRenewal(exclusionCommand, actor, exclusionContext("waive-open", exclusionCommand)); if (!excluded.ok) throw new Error(excluded.error.code);
    const periodEndExclusive = (await prisma.subscriptionRenewalExclusion.findUniqueOrThrow({ where: { id: excluded.value.exclusionId }, select: { periodEndExclusive: true } })).periodEndExclusive.toISOString().slice(0, 10);
    await expect(prisma.subscriptionRenewalWaiverSnapshot.create({ data: {
      exclusionId: excluded.value.exclusionId, companyId, customerId,
      customerCodeSnapshot: "LEGACY", customerLegalNameSnapshot: "Falso historico",
      source: "BACKFILLED_CURRENT_MASTER", currency: "EUR", capturedAt: new Date()
    } })).rejects.toThrow();
    await expect(prisma.subscription.update({ where: { id: created.value.id }, data: { status: "ACTIVE", nextRenewalDate: new Date(`${periodEndExclusive}T00:00:00.000Z`), version: { increment: 1 } } })).rejects.toThrow();
    const command = { companyId, subscriptionId: created.value.id, exclusionId: excluded.value.exclusionId, expectedVersion: 3, reasonCode: "COMMERCIAL_WAIVER" as const, reasonDetail: "Bonificacion excepcional autorizada por direccion" };
    const waiverKey = randomUUID();
    const first = await waiveSubscriptionRenewal(command, actor, waiverContext(waiverKey, command));
    expect(first).toMatchObject({ ok: true, status: 200, value: {
      resolution: "WAIVED", status: "ACTIVE", nextRenewalDate: periodEndExclusive, version: 4,
      valuation: { subtotal: "49.90", discountTotal: "0.00", taxableBase: "49.90", taxAmount: "10.48", total: "60.38", currency: "EUR", calculationVersion: "invoice-lines-v1",
        taxBreakdown: [{ taxRateCode: "IVA_21", taxRate: "21.00", theoreticalTaxableBase: "49.90", theoreticalTaxAmount: "10.48", theoreticalTotal: "60.38" }] }
    } });
    expect(await waiveSubscriptionRenewal(command, actor, waiverContext(waiverKey, command))).toEqual(first);
    if (!first.ok) throw new Error("WAIVER_EXPECTED");
    const { taxBreakdown: _taxBreakdown, ...legacyValuation } = first.value.valuation;
    void _taxBreakdown;
    await prisma.idempotencyRecord.update({ where: { key: `subscription-renewal-waivers-test:${waiverKey}` }, data: {
      responseBody: { ...first.value, valuation: legacyValuation }
    } });
    expect(await waiveSubscriptionRenewal(command, actor, waiverContext(waiverKey, command))).toMatchObject({
      ok: true, value: { valuation: { total: "60.38", taxBreakdown: [] } }
    });
    const reused = { ...command, reasonDetail: "Otra justificacion incompatible con la clave" };
    expect(await waiveSubscriptionRenewal(reused, actor, waiverContext(waiverKey, reused))).toMatchObject({ ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    expect(await prisma.subscriptionRenewalExclusion.findUniqueOrThrow({ where: { id: excluded.value.exclusionId }, select: {
      status: true, resolution: true, resolvedInvoiceId: true, resolutionReasonCode: true, resolutionReasonDetail: true,
      resolvedAgainstVersion: true, resolvedSubscriptionVersion: true, waivedSubtotal: true, waivedDiscountTotal: true,
      waivedTaxableBase: true, waivedTaxAmount: true, waivedTotal: true, waiverCalculationVersion: true
    } })).toMatchObject({
      status: "RESOLVED", resolution: "WAIVED", resolvedInvoiceId: null, resolutionReasonCode: "COMMERCIAL_WAIVER",
      resolutionReasonDetail: command.reasonDetail, resolvedAgainstVersion: 3, resolvedSubscriptionVersion: 4,
      waiverCalculationVersion: "invoice-lines-v1"
    });
    const storedWaiver = await prisma.subscriptionRenewalExclusion.findUniqueOrThrow({ where: { id: excluded.value.exclusionId } });
    expect([storedWaiver.waivedSubtotal, storedWaiver.waivedDiscountTotal, storedWaiver.waivedTaxableBase, storedWaiver.waivedTaxAmount, storedWaiver.waivedTotal].map((amount) => amount?.toFixed(2))).toEqual(["49.90", "0.00", "49.90", "10.48", "60.38"]);
    expect(storedWaiver.waiverSequence).not.toBeNull(); expect(storedWaiver.waiverSequence! > 0n).toBe(true);
    const fiscalReview = await prisma.subscriptionRenewalWaiverReview.findUniqueOrThrow({ where: { exclusionId: excluded.value.exclusionId } });
    expect(fiscalReview).toMatchObject({ status: "PENDING", source: "CURRENT_WORKFLOW", version: 1, openedById: actor.id });
    const startCommand = { expectedVersion: 1 as const };
    expect(await startRenewalWaiverFiscalReview(fiscalReview.id, startCommand, actor, fiscalReviewContext("maker-start", fiscalReview.id, startCommand))).toMatchObject({
      ok: false, status: 409, error: { code: "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_SELF_REVIEW_FORBIDDEN" }
    });
    const reviewer = await fiscalReviewer();
    const invalidTransitionAt = new Date();
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "subscription_renewal_waiver_reviews" SET "status" = 'IN_REVIEW', "version" = 2, "startedById" = ${reviewer.id}::uuid, "startedAt" = ${invalidTransitionAt}, "updatedAt" = ${invalidTransitionAt} WHERE "id" = ${fiscalReview.id}::uuid`;
      await tx.$executeRaw`UPDATE "subscription_renewal_waiver_reviews" SET "status" = 'CLOSED', "version" = 3, "decision" = 'NO_ADDITIONAL_ACTION', "decisionDetail" = 'Intento de omitir el evento intermedio', "decidedById" = ${reviewer.id}::uuid, "decidedAt" = ${invalidTransitionAt}, "closedById" = ${reviewer.id}::uuid, "closedAt" = ${invalidTransitionAt}, "updatedAt" = ${invalidTransitionAt} WHERE "id" = ${fiscalReview.id}::uuid`;
      await tx.$executeRaw`INSERT INTO "subscription_renewal_waiver_review_events" ("companyId", "reviewId", "type", "reviewVersion", "actorId", "decision", "occurredAt") VALUES (${companyId}::uuid, ${fiscalReview.id}::uuid, 'DECIDED', 3, ${reviewer.id}::uuid, 'NO_ADDITIONAL_ACTION', ${invalidTransitionAt})`;
    })).rejects.toThrow(/Every fiscal review version requires one ledger event/);
    const started = await startRenewalWaiverFiscalReview(fiscalReview.id, startCommand, reviewer, fiscalReviewContext("start", fiscalReview.id, startCommand));
    expect(started).toMatchObject({ ok: true, value: { status: "IN_REVIEW", version: 2, startedById: reviewer.id } });
    expect(await startRenewalWaiverFiscalReview(fiscalReview.id, startCommand, reviewer, fiscalReviewContext("start", fiscalReview.id, startCommand))).toEqual(started);
    const pastDueDecision = { expectedVersion: 2 as const, decision: "MANUAL_ACCOUNTING_ACTION_REQUIRED" as const, detail: "Actuacion con vencimiento historico no admisible", actionDueDate: previousMonthDate(todayDate()) };
    expect(await decideRenewalWaiverFiscalReview(fiscalReview.id, pastDueDecision, reviewer, fiscalReviewDecisionContext("past-due", fiscalReview.id, pastDueDecision))).toMatchObject({
      ok: false, status: 422, error: { code: "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_ACTION_DUE_DATE_INVALID" }
    });
    const decisionCommand = { expectedVersion: 2 as const, decision: "MANUAL_ACCOUNTING_ACTION_REQUIRED" as const, detail: "La clasificacion profesional requiere un asiento manual acreditado", actionDueDate: futureDate() };
    const decided = await decideRenewalWaiverFiscalReview(fiscalReview.id, decisionCommand, reviewer, fiscalReviewDecisionContext("decide", fiscalReview.id, decisionCommand));
    expect(decided).toMatchObject({ ok: true, value: { status: "ACTION_REQUIRED", version: 3, decision: "MANUAL_ACCOUNTING_ACTION_REQUIRED", decidedById: reviewer.id } });
    const completionCommand = { expectedVersion: 3 as const, detail: "Asiento revisado y vinculado con evidencia contable suficiente" };
    expect(await completeRenewalWaiverFiscalReview(fiscalReview.id, completionCommand, reviewer, fiscalReviewCompletionContext("missing-entry", fiscalReview.id, completionCommand))).toMatchObject({
      ok: false, status: 422, error: { code: "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_ACCOUNTING_EVIDENCE_INVALID" }
    });
    await seedInvoiceAccounts(actor.id, "1");
    const journalAccounts = await prisma.accountingAccount.findMany({ where: { code: { in: ["705000000", "477000000"] } }, orderBy: { code: "asc" } });
    const accountingEntry = await createManualJournalEntry({
      accountingDate: todayDate(), concept: "Regularizacion contable del periodo condonado", waiverReviewId: fiscalReview.id,
      lines: [
        { accountId: journalAccounts[0]!.id, concept: "Debe regularizacion", debit: "60.38", credit: "0.00" },
        { accountId: journalAccounts[1]!.id, concept: "Haber regularizacion", debit: "0.00", credit: "60.38" }
      ]
    }, actor);
    expect(accountingEntry).toMatchObject({ ok: true, value: { origin: "WAIVER_REGULARIZATION" } });
    const otherReviewer = await fiscalCompletionObserver();
    expect(await completeRenewalWaiverFiscalReview(fiscalReview.id, completionCommand, otherReviewer, fiscalReviewCompletionContext("not-assigned", fiscalReview.id, completionCommand))).toMatchObject({
      ok: false, status: 409, error: { code: "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_NOT_COMPLETABLE" }
    });
    expect(await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_COMPLETION_DENIED" }, select: { payload: true } })).toMatchObject({ payload: { denialReason: "NOT_ASSIGNED" } });
    expect(await completeRenewalWaiverFiscalReview(fiscalReview.id, completionCommand, actor, fiscalReviewCompletionContext("maker-complete", fiscalReview.id, completionCommand))).toMatchObject({
      ok: false, status: 409, error: { code: "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_SELF_REVIEW_FORBIDDEN" }
    });
    const economicCountsBeforeCompletion = await Promise.all([
      prisma.invoice.count(), prisma.accountingJournalEntry.count(), prisma.verifactuFiscalRecord.count(), prisma.verifactuOutboxMessage.count()
    ]);
    const completed = await completeRenewalWaiverFiscalReview(fiscalReview.id, completionCommand, reviewer, fiscalReviewCompletionContext("complete", fiscalReview.id, completionCommand));
    expect(completed).toMatchObject({ ok: true, value: { status: "CLOSED", version: 4, decision: "MANUAL_ACCOUNTING_ACTION_REQUIRED" } });
    expect(await completeRenewalWaiverFiscalReview(fiscalReview.id, completionCommand, reviewer, fiscalReviewCompletionContext("complete", fiscalReview.id, completionCommand))).toEqual(completed);
    const reviewEvents = await prisma.subscriptionRenewalWaiverReviewEvent.findMany({ where: { reviewId: fiscalReview.id }, orderBy: { reviewVersion: "asc" } });
    const storedFiscalReview = await prisma.subscriptionRenewalWaiverReview.findUniqueOrThrow({ where: { id: fiscalReview.id } });
    expect(reviewEvents).toHaveLength(4);
    expect(reviewEvents.map((event) => event.occurredAt.toISOString())).toEqual([
      storedFiscalReview.openedAt.toISOString(), storedFiscalReview.startedAt!.toISOString(), storedFiscalReview.decidedAt!.toISOString(), storedFiscalReview.closedAt!.toISOString()
    ]);
    const accountingEvidence = await prisma.subscriptionRenewalWaiverReviewEvidence.findUniqueOrThrow({ where: { accountingJournalEntryId: accountingEntry.ok ? accountingEntry.value.id : randomUUID() } });
    expect(accountingEvidence).toMatchObject({ reviewId: fiscalReview.id, kind: "ACCOUNTING_JOURNAL_ENTRY", addedById: reviewer.id });
    expect(accountingEvidence.evidenceSnapshot).toMatchObject({ origin: "WAIVER_REGULARIZATION", validationVersion: "accounting-waiver-v1" });
    expect(accountingEvidence.addedAt.getTime()).toBeLessThanOrEqual(storedFiscalReview.closedAt!.getTime());
    expect(await Promise.all([
      prisma.invoice.count(), prisma.accountingJournalEntry.count(), prisma.verifactuFiscalRecord.count(), prisma.verifactuOutboxMessage.count()
    ])).toEqual(economicCountsBeforeCompletion);
    if (!accountingEntry.ok) throw new Error("ACCOUNTING_ENTRY_EXPECTED");
    await expect(prisma.accountingJournalEntry.update({ where: { id: accountingEntry.value.id }, data: { origin: "MANUAL", waiverReviewId: null } })).rejects.toThrow();
    const evidencedLine = await prisma.accountingJournalLine.findFirstOrThrow({ where: { entryId: accountingEntry.value.id } });
    await expect(prisma.accountingJournalLine.update({ where: { id: evidencedLine.id }, data: { debit: "1.00" } })).rejects.toThrow();
    const reversalCommand = { expectedReviewVersion: 4 as const, reasonCode: "ACCOUNTING_ERROR" as const,
      reasonDetail: "El asiento acreditado contiene un error contable confirmado", accountingDate: todayDate() };
    expect(await requestWaiverEvidenceReversal(fiscalReview.id, reversalCommand, actor,
      waiverReversalRequestContext("maker-request", fiscalReview.id, reversalCommand))).toMatchObject({
      ok: false, status: 409, error: { code: "WAIVER_REVERSAL_INDEPENDENCE_REQUIRED" }
    });
    const requestedReversal = await requestWaiverEvidenceReversal(fiscalReview.id, reversalCommand, otherReviewer,
      waiverReversalRequestContext("request", fiscalReview.id, reversalCommand));
    expect(requestedReversal).toMatchObject({ ok: true, status: 201, value: { status: "REQUESTED", version: 1, targetEntryId: accountingEntry.value.id } });
    if (!requestedReversal.ok) throw new Error("WAIVER_REVERSAL_REQUEST_EXPECTED");
    expect(await requestWaiverEvidenceReversal(fiscalReview.id, reversalCommand, otherReviewer,
      waiverReversalRequestContext("request", fiscalReview.id, reversalCommand))).toEqual(requestedReversal);
    const targetForRogueReversal = await prisma.accountingJournalEntry.findUniqueOrThrow({ where: { id: accountingEntry.value.id }, include: { lines: true } });
    await expect(prisma.$transaction(async (tx) => {
      const sequence = (await tx.accountingJournalEntry.aggregate({ where: { fiscalYearId: targetForRogueReversal.fiscalYearId }, _max: { sequence: true } }))._max.sequence! + 1;
      await tx.accountingJournalEntry.create({ data: {
        fiscalYearId: targetForRogueReversal.fiscalYearId, reversesEntryId: targetForRogueReversal.id,
        waiverReversalRequestId: requestedReversal.value.id, year: targetForRogueReversal.year, sequence,
        number: `${targetForRogueReversal.year}/${sequence.toString().padStart(6, "0")}`, accountingDate: new Date(`${todayDate()}T00:00:00.000Z`),
        concept: `Reversión no aprobada ${targetForRogueReversal.number}`, origin: "WAIVER_REGULARIZATION_REVERSAL",
        totalDebit: targetForRogueReversal.totalCredit, totalCredit: targetForRogueReversal.totalDebit, createdById: otherReviewer.id,
        lines: { create: targetForRogueReversal.lines.map((line) => ({ accountId: line.accountId, position: line.position,
          concept: line.concept, debit: line.credit, credit: line.debit })) }
      } });
    })).rejects.toThrow(/non-completed accounting waiver reversal cannot retain an entry/);
    const approvalCommand = { expectedVersion: 1 as const };
    expect(await approveWaiverEvidenceReversal(requestedReversal.value.id, approvalCommand, otherReviewer,
      waiverReversalApprovalContext("requester-approve", requestedReversal.value.id, approvalCommand))).toMatchObject({
      ok: false, status: 409, error: { code: "WAIVER_REVERSAL_SELF_APPROVAL_FORBIDDEN" }
    });
    expect(await approveWaiverEvidenceReversal(requestedReversal.value.id, approvalCommand, reviewer,
      waiverReversalApprovalContext("reviewer-approve", requestedReversal.value.id, approvalCommand))).toMatchObject({
      ok: false, status: 409, error: { code: "WAIVER_REVERSAL_SELF_APPROVAL_FORBIDDEN" }
    });
    const reversalApprover = await accountingReversalApprover();
    const economicCountsBeforeReversal = await Promise.all([
      prisma.invoice.count(), prisma.accountingJournalEntry.count(), prisma.verifactuFiscalRecord.count(), prisma.verifactuOutboxMessage.count()
    ]);
    const approvedReversal = await approveWaiverEvidenceReversal(requestedReversal.value.id, approvalCommand, reversalApprover,
      waiverReversalApprovalContext("approve", requestedReversal.value.id, approvalCommand));
    expect(approvedReversal).toMatchObject({ ok: true, status: 200, value: { status: "COMPLETED", version: 2, approvedById: reversalApprover.id } });
    expect(await approveWaiverEvidenceReversal(requestedReversal.value.id, approvalCommand, reversalApprover,
      waiverReversalApprovalContext("approve", requestedReversal.value.id, approvalCommand))).toEqual(approvedReversal);
    const reversalEntry = await prisma.accountingJournalEntry.findUniqueOrThrow({
      where: { waiverReversalRequestId: requestedReversal.value.id }, include: { lines: { orderBy: { position: "asc" } } }
    });
    const originalLines = await prisma.accountingJournalLine.findMany({ where: { entryId: accountingEntry.value.id }, orderBy: { position: "asc" } });
    expect(reversalEntry).toMatchObject({ origin: "WAIVER_REGULARIZATION_REVERSAL", status: "POSTED", reversesEntryId: accountingEntry.value.id });
    expect(reversalEntry.lines.map((line) => [line.position, line.accountId, line.concept, line.debit.toFixed(2), line.credit.toFixed(2)])).toEqual(
      originalLines.map((line) => [line.position, line.accountId, line.concept, line.credit.toFixed(2), line.debit.toFixed(2)]));
    expect(await Promise.all([
      prisma.invoice.count(), prisma.accountingJournalEntry.count(), prisma.verifactuFiscalRecord.count(), prisma.verifactuOutboxMessage.count()
    ])).toEqual([economicCountsBeforeReversal[0], economicCountsBeforeReversal[1] + 1, economicCountsBeforeReversal[2], economicCountsBeforeReversal[3]]);
    expect(await prisma.subscriptionRenewalWaiverReview.findUniqueOrThrow({ where: { id: fiscalReview.id }, select: { status: true, version: true } })).toEqual({ status: "CLOSED", version: 4 });
    const reportAfterReversal = await listSubscriptionRenewalWaivers({ limit: 25 }, actor);
    expect(reportAfterReversal).toMatchObject({ ok: true, value: { waivers: [{ fiscalReview: {
      status: "CLOSED", version: 4, accountingEvidenceReversal: { id: requestedReversal.value.id, status: "COMPLETED", version: 2 },
      accountingEvidenceFollowUpRequired: true
    } }] } });
    expect(requestWaiverEvidenceReplacementSchema.safeParse({ expectedReviewVersion: 4, reasonCode: "CORRECTED_DATE",
      reasonDetail: "Fecha imposible para la propuesta", accountingDate: "2026-02-31", concept: "Propuesta inválida", lines: [
        { accountId: journalAccounts[0]!.id, concept: "Debe", debit: "1.00", credit: "0.00" },
        { accountId: journalAccounts[1]!.id, concept: "Haber", debit: "0.00", credit: "1.00" }
      ] }).success).toBe(false);
    const replacementCommand = { expectedReviewVersion: 4 as const, reasonCode: "CORRECTED_AMOUNT" as const,
      reasonDetail: "El importe correcto exige una nueva evidencia contable", accountingDate: todayDate(),
      concept: "Sustitución controlada de la regularización", lines: [
        { accountId: journalAccounts[0]!.id, concept: "Debe corregido", debit: "61.00", credit: "0.00" },
        { accountId: journalAccounts[1]!.id, concept: "Haber corregido", debit: "0.00", credit: "61.00" }
      ] };
    const unbalancedReplacementCommand = { ...replacementCommand, lines: [
      replacementCommand.lines[0]!, { ...replacementCommand.lines[1]!, credit: "60.00" }
    ] };
    expect(await requestWaiverEvidenceReplacement(fiscalReview.id, unbalancedReplacementCommand, reversalApprover,
      waiverReplacementRequestContext("unbalanced", fiscalReview.id, unbalancedReplacementCommand))).toMatchObject({
      ok: false, status: 422, error: { code: "WAIVER_REPLACEMENT_PROPOSAL_NOT_BALANCED" }
    });
    const replacementRequestContext = waiverReplacementRequestContext("request", fiscalReview.id, replacementCommand);
    const [requestedReplacement, concurrentRequestReplay] = await Promise.all([
      requestWaiverEvidenceReplacement(fiscalReview.id, replacementCommand, reversalApprover, replacementRequestContext),
      requestWaiverEvidenceReplacement(fiscalReview.id, replacementCommand, reversalApprover, replacementRequestContext)
    ]);
    expect(requestedReplacement).toMatchObject({ ok: true, status: 201, value: { status: "REQUESTED", version: 1,
      sourceEvidenceId: accountingEvidence.id, reversalRequestId: requestedReversal.value.id } });
    if (!requestedReplacement.ok) throw new Error("WAIVER_REPLACEMENT_REQUEST_EXPECTED");
    expect(concurrentRequestReplay).toEqual(requestedReplacement);
    expect(await requestWaiverEvidenceReplacement(fiscalReview.id, unbalancedReplacementCommand, reversalApprover,
      waiverReplacementRequestContext("request", fiscalReview.id, unbalancedReplacementCommand))).toMatchObject({
      ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED" }
    });
    expect(listWaiverEvidenceReplacementProposalsSchema.safeParse({ limit: "1e2" }).success).toBe(false);
    const proposalList = await listWaiverEvidenceReplacementProposals({ limit: 10 }, otherReviewer,
      { correlationId: "accounting-waiver-replacement-list" });
    expect(proposalList).toMatchObject({ ok: true, status: 200, value: { proposals: [{
      id: requestedReplacement.value.id, version: 1, requestedBy: { displayName: reversalApprover.displayName },
      reasonCode: "CORRECTED_AMOUNT", fiscalYear: Number(todayDate().slice(0, 4)), lineCount: 2,
      eligibility: { canApprove: true, blockers: [] }
    }], nextCursor: null } });
    expect(JSON.stringify(proposalList)).not.toContain(replacementCommand.reasonDetail);
    expect(JSON.stringify(proposalList)).not.toContain(replacementCommand.concept);
    expect(JSON.stringify(proposalList)).not.toContain("Debe corregido");
    expect(await listWaiverEvidenceReplacementProposals({ limit: 10, cursor: `${"A".repeat(20)}.${"B".repeat(43)}` }, otherReviewer))
      .toMatchObject({ ok: false, status: 422, error: { code: "WAIVER_REPLACEMENT_PROPOSAL_CURSOR_INVALID" } });
    const replacementDetailResult = await getWaiverEvidenceReplacementDetail(requestedReplacement.value.id, otherReviewer,
      { correlationId: "accounting-waiver-replacement-view" });
    expect(replacementDetailResult).toMatchObject({ ok: true, status: 200, value: {
      id: requestedReplacement.value.id, status: "REQUESTED", version: 1, isRequestedByActor: false,
      requestedBy: { displayName: reversalApprover.displayName },
      sourceEvidence: { sequence: 1, entryNumber: accountingEntry.value.number },
      reversal: { entryNumber: reversalEntry.number },
      eligibility: { canApprove: true, blockers: [] },
      lines: [
        { position: 1, concept: "Debe corregido", debit: "61.00", credit: "0.00" },
        { position: 2, concept: "Haber corregido", debit: "0.00", credit: "61.00" }
      ]
    } });
    if (!replacementDetailResult.ok) throw new Error("WAIVER_REPLACEMENT_DETAIL_EXPECTED");
    const replacementDetail = replacementDetailResult.value;
    const reportWithPendingReplacement = await listSubscriptionRenewalWaivers({ limit: 25 }, otherReviewer);
    expect(reportWithPendingReplacement).toMatchObject({ ok: true, value: { waivers: [{ fiscalReview: {
      accountingEvidenceReplacement: { id: requestedReplacement.value.id, status: "REQUESTED", version: 1, isRequestedByActor: false },
      accountingEvidenceFollowUpRequired: true
    } }] } });
    expect(await requestWaiverEvidenceReplacement(fiscalReview.id, replacementCommand, reversalApprover, replacementRequestContext)).toEqual(requestedReplacement);
    const rejectionCommand = { expectedVersion: 1 as const, rejectionDetail: "El solicitante no puede rechazar su propia propuesta" };
    expect(await rejectWaiverEvidenceReplacement(requestedReplacement.value.id, rejectionCommand, reversalApprover,
      waiverReplacementRejectionContext("self-reject", requestedReplacement.value.id, rejectionCommand))).toMatchObject({
      ok: false, status: 409, error: { code: "WAIVER_REPLACEMENT_SELF_REJECTION_FORBIDDEN" }
    });
    const cancellationCommand = { expectedVersion: 1 as const };
    expect(await cancelWaiverEvidenceReplacement(requestedReplacement.value.id, cancellationCommand, otherReviewer,
      waiverReplacementCancellationContext("third-party-cancel", requestedReplacement.value.id, cancellationCommand))).toMatchObject({
      ok: false, status: 409, error: { code: "WAIVER_REPLACEMENT_NOT_CANCELLABLE" }
    });
    const replacementApproval = { expectedVersion: 1 as const, expectedProposalDigest: replacementDetail.proposalDigest };
    const changedProposalApproval = { expectedVersion: 1 as const, expectedProposalDigest: "0".repeat(64) };
    expect(await approveWaiverEvidenceReplacement(requestedReplacement.value.id, changedProposalApproval, otherReviewer,
      waiverReplacementApprovalContext("changed-proposal", requestedReplacement.value.id, changedProposalApproval))).toMatchObject({
      ok: false, status: 409, error: { code: "WAIVER_REPLACEMENT_PROPOSAL_CHANGED" }
    });
    expect(await approveWaiverEvidenceReplacement(requestedReplacement.value.id, replacementApproval, reversalApprover,
      waiverReplacementApprovalContext("self-approve", requestedReplacement.value.id, replacementApproval))).toMatchObject({
      ok: false, status: 409, error: { code: "WAIVER_REPLACEMENT_SELF_APPROVAL_FORBIDDEN" }
    });
    const replacementApprovalContext = waiverReplacementApprovalContext("approve", requestedReplacement.value.id, replacementApproval);
    const [approvedReplacement, concurrentApprovalReplay] = await Promise.all([
      approveWaiverEvidenceReplacement(requestedReplacement.value.id, replacementApproval, otherReviewer, replacementApprovalContext),
      approveWaiverEvidenceReplacement(requestedReplacement.value.id, replacementApproval, otherReviewer, replacementApprovalContext)
    ]);
    expect(approvedReplacement).toMatchObject({ ok: true, status: 200, value: { status: "COMPLETED", version: 2,
      approvedById: otherReviewer.id, resultingEvidence: { sequence: 2 } } });
    expect(concurrentApprovalReplay).toEqual(approvedReplacement);
    expect(await approveWaiverEvidenceReplacement(requestedReplacement.value.id, replacementApproval, otherReviewer,
      waiverReplacementApprovalContext("resolved-again", requestedReplacement.value.id, replacementApproval))).toMatchObject({
      ok: false, status: 409, error: { code: "WAIVER_REPLACEMENT_REQUEST_NOT_PENDING" }
    });
    const missingReplacementId = randomUUID();
    expect(await approveWaiverEvidenceReplacement(missingReplacementId, replacementApproval, otherReviewer,
      waiverReplacementApprovalContext("missing", missingReplacementId, replacementApproval))).toMatchObject({
      ok: false, status: 404, error: { code: "WAIVER_REPLACEMENT_REQUEST_NOT_FOUND" }
    });
    expect(await rejectWaiverEvidenceReplacement(missingReplacementId, rejectionCommand, otherReviewer,
      waiverReplacementRejectionContext("missing", missingReplacementId, rejectionCommand))).toMatchObject({
      ok: false, status: 404, error: { code: "WAIVER_REPLACEMENT_REQUEST_NOT_FOUND" }
    });
    expect(await cancelWaiverEvidenceReplacement(missingReplacementId, cancellationCommand, reversalApprover,
      waiverReplacementCancellationContext("missing", missingReplacementId, cancellationCommand))).toMatchObject({
      ok: false, status: 404, error: { code: "WAIVER_REPLACEMENT_REQUEST_NOT_FOUND" }
    });
    const replacementEntry = await prisma.accountingJournalEntry.findUniqueOrThrow({ where: { waiverReplacementRequestId: requestedReplacement.value.id },
      include: { lines: { orderBy: { position: "asc" } } } });
    expect(replacementEntry).toMatchObject({ origin: "WAIVER_REGULARIZATION_REPLACEMENT", status: "POSTED", totalDebit: expect.anything(), totalCredit: expect.anything() });
    expect(replacementEntry.lines.map((line) => [line.concept, line.debit.toFixed(2), line.credit.toFixed(2)])).toEqual([
      ["Debe corregido", "61.00", "0.00"], ["Haber corregido", "0.00", "61.00"]
    ]);
    const evidenceChain = await prisma.subscriptionRenewalWaiverReviewEvidence.findMany({ where: { reviewId: fiscalReview.id }, orderBy: { sequence: "asc" } });
    expect(evidenceChain).toHaveLength(2);
    expect(evidenceChain[1]).toMatchObject({ sequence: 2, supersedesEvidenceId: accountingEvidence.id,
      replacementRequestId: requestedReplacement.value.id, accountingJournalEntryId: replacementEntry.id, addedById: otherReviewer.id });
    const reportAfterReplacement = await listSubscriptionRenewalWaivers({ limit: 25 }, actor);
    expect(reportAfterReplacement).toMatchObject({ ok: true, value: { waivers: [{ fiscalReview: {
      evidenceCount: 2, accountingEvidenceReversal: null, accountingEvidenceFollowUpRequired: false
    } }] } });
    const replacementAudit = JSON.stringify(await prisma.auditEvent.findMany({ where: { eventType: { startsWith: "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT" } }, select: { payload: true } }));
    expect(replacementAudit).not.toContain(replacementCommand.reasonDetail);
    expect(replacementAudit).not.toContain("Debe corregido"); expect(replacementAudit).not.toContain("61.00");
    const idempotencyConflictAudits = await prisma.auditEvent.findMany({ where: {
      eventType: "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_REQUEST_DENIED",
      AND: [{ payload: { path: ["denialReason"], equals: "IDEMPOTENCY_KEY_REUSED" } },
        { payload: { path: ["companyId"], equals: companyId } }]
    }, select: { payload: true } });
    expect(idempotencyConflictAudits).toHaveLength(1);
    expect(JSON.stringify(idempotencyConflictAudits)).not.toContain(fiscalReview.id);
    const unbalancedAudits = await prisma.auditEvent.findMany({ where: {
      eventType: "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_REQUEST_DENIED", AND: [
        { payload: { path: ["denialReason"], equals: "PROPOSAL_NOT_BALANCED" } },
        { payload: { path: ["companyId"], equals: companyId } }
      ]
    }, select: { payload: true } });
    expect(unbalancedAudits).toHaveLength(1);
    expect(JSON.stringify(unbalancedAudits)).not.toContain(fiscalReview.id);
    expect(JSON.stringify(unbalancedAudits)).not.toContain(replacementCommand.reasonDetail);
    expect(await prisma.auditEvent.count({ where: { eventType: "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_APPROVAL_DENIED", AND: [
      { payload: { path: ["denialReason"], equals: "REQUEST_NOT_PENDING" } }, { payload: { path: ["companyId"], equals: companyId } }
    ] } })).toBe(1);
    const missingReplacementAuditRows = await prisma.auditEvent.findMany({ where: {
      eventType: { in: ["ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_APPROVAL_DENIED", "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_REJECTION_DENIED",
        "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_CANCELLATION_DENIED"] }, AND: [
        { payload: { path: ["denialReason"], equals: "REQUEST_NOT_FOUND_OR_NOT_VISIBLE" } },
        { payload: { path: ["companyId"], equals: companyId } }
      ]
    }, select: { eventType: true, payload: true } });
    expect(missingReplacementAuditRows).toHaveLength(3);
    const missingReplacementAudit = JSON.stringify(missingReplacementAuditRows);
    expect(missingReplacementAudit).not.toContain(missingReplacementId);
    await expect(prisma.accountingJournalEntry.update({ where: { id: reversalEntry.id }, data: { concept: "Alteración prohibida" } })).rejects.toThrow();
    await expect(prisma.accountingJournalLine.update({ where: { id: reversalEntry.lines[0]!.id }, data: { concept: "Alteración prohibida" } })).rejects.toThrow();
    const ordinaryEntry = await createManualJournalEntry({ accountingDate: todayDate(), concept: "Asiento ordinario independiente", lines: [
      { accountId: journalAccounts[0]!.id, concept: "Debe ordinario", debit: "1.00", credit: "0.00" },
      { accountId: journalAccounts[1]!.id, concept: "Haber ordinario", debit: "0.00", credit: "1.00" }
    ] }, actor);
    if (!ordinaryEntry.ok) throw new Error("ORDINARY_ENTRY_EXPECTED");
    await expect(prisma.accountingJournalLine.update({ where: { id: evidencedLine.id }, data: { entryId: ordinaryEntry.value.id } })).rejects.toThrow();
    const fiscalAuditPayloads = JSON.stringify(await prisma.auditEvent.findMany({ where: { eventType: { startsWith: "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW" } }, select: { payload: true } }));
    expect(fiscalAuditPayloads).not.toContain(decisionCommand.detail);
    expect(fiscalAuditPayloads).not.toContain(completionCommand.detail);
    await expect(prisma.subscriptionRenewalWaiverReview.update({ where: { id: fiscalReview.id }, data: { decisionDetail: "Alteracion posterior prohibida" } })).rejects.toThrow();
    const snapshot = await prisma.subscriptionRenewalWaiverSnapshot.findUniqueOrThrow({ where: { exclusionId: excluded.value.exclusionId }, include: { taxSummaries: true } });
    expect(snapshot).toMatchObject({ customerId, source: "CAPTURED_AT_WAIVER", currency: "EUR", taxSummaries: [{ taxRateCodeSnapshot: "IVA_21" }] });
    expect(snapshot.taxSummaries.map((summary) => [summary.theoreticalTaxableBase.toFixed(2), summary.theoreticalTaxAmount.toFixed(2), summary.theoreticalTotal.toFixed(2)])).toEqual([["49.90", "10.48", "60.38"]]);
    expect(await prisma.invoice.count({ where: { origin: "SUBSCRIPTION" } })).toBe(0);
    expect(await prisma.subscriptionRenewalReservation.count({ where: { subscriptionId: created.value.id } })).toBe(0);
    const auditWhere = { eventType: "SUBSCRIPTION_RENEWAL_PERIOD_WAIVED", payload: { path: ["correlationId"], equals: `subscription-renewal-waivers-${waiverKey}` } } as const;
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: auditWhere });
    expect(JSON.stringify(audit.payload)).not.toContain(command.reasonDetail);
    expect(await prisma.auditEvent.count({ where: auditWhere })).toBe(1);
    await expect(prisma.subscriptionRenewalExclusion.update({ where: { id: excluded.value.exclusionId }, data: { resolutionReasonDetail: "Intento de alteracion posterior" } })).rejects.toThrow();
    await expect(prisma.subscriptionRenewalWaiverSnapshot.update({ where: { exclusionId: excluded.value.exclusionId }, data: { customerLegalNameSnapshot: "Alteracion" } })).rejects.toThrow();
    await expect(prisma.subscriptionRenewalWaiverTaxSummary.delete({ where: { id: snapshot.taxSummaries[0]!.id } })).rejects.toThrow();
    await expect(prisma.subscriptionRenewalExclusion.delete({ where: { id: excluded.value.exclusionId } })).rejects.toThrow();
  }, 20_000);

  it("releases a reserved pending period, waives it and bills the following period", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); await prisma.customer.update({ where: { id: customerId }, data: { code: "9" } });
    await seedInvoiceAccounts(actor.id, "9");
    const itemId = await catalogItem(actor.id); const processDate = todayDate(); const waivedPeriodStart = previousMonthDate(processDate);
    const createCommand = payload(customerId, itemId, { name: "Condonacion tras liberar", startDate: waivedPeriodStart });
    const created = await createSubscription(createCommand, actor, context("waive-cycle-create", createCommand)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("waive-cycle-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow()).companyId!;
    const exclusionCommand = { companyId, subscriptionId: created.value.id, expectedVersion: 2, periodStart: waivedPeriodStart, processDate, reason: "Pendiente antes de reservar" };
    const excluded = await excludeSubscriptionRenewal(exclusionCommand, actor, exclusionContext("waive-cycle-open", exclusionCommand)); if (!excluded.ok) throw new Error(excluded.error.code);
    const firstDraftCommand = {
      companyId, subscriptionIds: [created.value.id], expectedVersions: { [created.value.id]: 3 }, issueDate: processDate,
      pendingExclusionIds: { [created.value.id]: excluded.value.exclusionId }
    };
    const firstDraft = await createSubscriptionRenewalDraft(firstDraftCommand, actor, renewalContext("waive-cycle-reserve", firstDraftCommand));
    if (!firstDraft.ok || !firstDraft.value.invoiceId) throw new Error("RENEWAL_DRAFT_EXPECTED");
    const release = { companyId, invoiceId: firstDraft.value.invoiceId, reason: "Acuerdo comercial posterior" };
    expect(await releaseSubscriptionRenewal(release, actor, releaseContext("waive-cycle-release", release))).toMatchObject({ ok: true, status: 200 });
    const waiver = { companyId, subscriptionId: created.value.id, exclusionId: excluded.value.exclusionId, expectedVersion: 3, reasonCode: "COMMERCIAL_WAIVER" as const, reasonDetail: "Periodo condonado despues de liberar el borrador" };
    const waived = await waiveSubscriptionRenewal(waiver, actor, waiverContext("waive-cycle", waiver));
    expect(waived).toMatchObject({ ok: true, value: { nextRenewalDate: processDate, version: 4, valuation: { total: "60.38" } } });
    if (!waived.ok) throw new Error(waived.error.code);
    const releasedEvidence = await prisma.subscriptionRenewalReservation.findFirstOrThrow({ where: { invoiceId: firstDraft.value.invoiceId }, select: { status: true, releaseReason: true } });
    expect(releasedEvidence).toEqual({ status: "RELEASED", releaseReason: release.reason });
    await expect(prisma.invoice.update({ where: { id: firstDraft.value.invoiceId }, data: { notes: "Alteracion prohibida" } })).rejects.toThrow();
    const nextDraftCommand = { companyId, subscriptionIds: [created.value.id], expectedVersions: { [created.value.id]: 4 }, issueDate: processDate };
    const nextDraft = await createSubscriptionRenewalDraft(nextDraftCommand, actor, renewalContext("waive-cycle-next", nextDraftCommand));
    if (!nextDraft.ok || !nextDraft.value.invoiceId) throw new Error("NEXT_RENEWAL_DRAFT_EXPECTED");
    const confirmation = { companyId, invoiceId: nextDraft.value.invoiceId };
    expect(await confirmSubscriptionRenewal(confirmation, actor, confirmationContext("waive-cycle-confirm", confirmation), { verifactuEnabled: false })).toMatchObject({ ok: true, status: 200 });
    expect(await prisma.subscriptionRenewalReservation.findFirstOrThrow({ where: { invoiceId: nextDraft.value.invoiceId }, select: { status: true, periodStart: true } })).toMatchObject({ status: "BILLED", periodStart: new Date(`${processDate}T00:00:00.000Z`) });
    expect(await prisma.subscriptionRenewalExclusion.findUniqueOrThrow({ where: { id: excluded.value.exclusionId }, select: { resolution: true, waivedTotal: true } })).toMatchObject({ resolution: "WAIVED", waivedTotal: expect.objectContaining({}) });
  });

  it("stores a deterministic theoretical tax breakdown for every waived rate", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const firstItemId = await catalogItem(actor.id);
    const tax10 = await prisma.catalogTaxRate.findFirstOrThrow({ where: { code: "IVA_10" } });
    const secondItemId = (await prisma.catalogItem.create({ data: {
      code: `S${randomUUID().slice(0, 8)}`, kind: "SERVICE", name: `Servicio reducido ${randomUUID()}`,
      salePrice: "10.00", taxRateId: tax10.id, taxRate: tax10.rate, createdById: actor.id
    } })).id;
    const renewalDate = todayDate();
    const createCommand = payload(customerId, firstItemId, { name: "Condonacion con dos tipos", startDate: renewalDate, lines: [
      { catalogItemId: firstItemId, quantity: "1.000", discountPercent: "0.00", discountAmount: "0.00" },
      { catalogItemId: secondItemId, quantity: "1.000", discountPercent: "0.00", discountAmount: "0.00" }
    ] });
    const created = await createSubscription(createCommand, actor, context("waive-taxes-create", createCommand)); if (!created.ok) throw new Error(created.error.code);
    const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context("waive-taxes-activate", { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow()).companyId!;
    const exclusionCommand = { companyId, subscriptionId: created.value.id, expectedVersion: 2, periodStart: renewalDate, processDate: renewalDate, reason: "Revision comercial" };
    const excluded = await excludeSubscriptionRenewal(exclusionCommand, actor, exclusionContext("waive-taxes-open", exclusionCommand)); if (!excluded.ok) throw new Error(excluded.error.code);
    const command = { companyId, subscriptionId: created.value.id, exclusionId: excluded.value.exclusionId, expectedVersion: 3, reasonCode: "COMMERCIAL_WAIVER" as const, reasonDetail: "Condonacion autorizada con dos tipos teoricos" };
    const waived = await waiveSubscriptionRenewal(command, actor, waiverContext("waive-taxes", command)); if (!waived.ok) throw new Error(waived.error.code);
    expect(waived.value.valuation).toMatchObject({ taxableBase: "59.90", taxAmount: "11.48", total: "71.38", taxBreakdown: [
      { taxRateCode: "IVA_10", taxRate: "10.00", theoreticalTaxableBase: "10.00", theoreticalTaxAmount: "1.00", theoreticalTotal: "11.00" },
      { taxRateCode: "IVA_21", taxRate: "21.00", theoreticalTaxableBase: "49.90", theoreticalTaxAmount: "10.48", theoreticalTotal: "60.38" }
    ] });
  });

  it("lists waived periods with a filter-bound frozen cursor and redacts sensitive reasons", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const processDate = todayDate();
    const companyId = (await prisma.installation.findFirstOrThrow()).companyId!;
    const createWaiver = async (index: number) => {
      const createCommand = payload(customerId, itemId, { name: `Historial condonado ${index}`, startDate: processDate });
      const created = await createSubscription(createCommand, actor, context(`waiver-report-create-${index}`, createCommand)); if (!created.ok) throw new Error(created.error.code);
      const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context(`waiver-report-activate-${index}`, { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
      const exclusionCommand = { companyId, subscriptionId: created.value.id, expectedVersion: 2, periodStart: processDate, processDate, reason: `Apertura privada ${index}` };
      const excluded = await excludeSubscriptionRenewal(exclusionCommand, actor, exclusionContext(`waiver-report-open-${index}`, exclusionCommand)); if (!excluded.ok) throw new Error(excluded.error.code);
      const waiver = { companyId, subscriptionId: created.value.id, exclusionId: excluded.value.exclusionId, expectedVersion: 3, reasonCode: index % 2 === 0 ? "COMMERCIAL_WAIVER" as const : "SERVICE_FAILURE" as const, reasonDetail: `Justificacion privada de la condonacion ${index}` };
      const waived = await waiveSubscriptionRenewal(waiver, actor, waiverContext(`waiver-report-${index}`, waiver)); if (!waived.ok) throw new Error(waived.error.code);
      return { exclusionId: excluded.value.exclusionId, reasonDetail: waiver.reasonDetail };
    };
    const firstCreated = await createWaiver(0); const secondCreated = await createWaiver(1);
    const firstPage = await listSubscriptionRenewalWaivers({ limit: 1 }, actor, { correlationId: "waiver-report-page-one" });
    expect(firstPage).toMatchObject({ ok: true, value: { waivers: [{ hasReason: true, reason: secondCreated.reasonDetail }], summary: { count: 2, total: "120.76" }, nextCursor: expect.any(String) } });
    if (!firstPage.ok || !firstPage.value.nextCursor) throw new Error("WAIVER_REPORT_CURSOR_EXPECTED");
    const thirdCreated = await createWaiver(2);
    const secondPage = await listSubscriptionRenewalWaivers({ limit: 1, cursor: firstPage.value.nextCursor }, actor, { correlationId: "waiver-report-page-two" });
    expect(secondPage).toMatchObject({ ok: true, value: { waivers: [{ id: firstCreated.exclusionId }], summary: { count: 2 }, nextCursor: null } });
    if (!secondPage.ok) throw new Error(secondPage.error.code);
    expect(secondPage.value.waivers.map((waiver) => waiver.id)).not.toContain(thirdCreated.exclusionId);
    const tampered = `${firstPage.value.nextCursor.slice(0, -1)}${firstPage.value.nextCursor.endsWith("A") ? "B" : "A"}`;
    expect(await listSubscriptionRenewalWaivers({ limit: 1, cursor: tampered }, actor)).toMatchObject({ ok: false, status: 422, error: { code: "SUBSCRIPTION_RENEWAL_WAIVER_CURSOR_INVALID" } });
    expect(await listSubscriptionRenewalWaivers({ limit: 1, cursor: firstPage.value.nextCursor, reasonCode: "OTHER" }, actor)).toMatchObject({ ok: false, status: 422, error: { code: "SUBSCRIPTION_RENEWAL_WAIVER_CURSOR_INVALID" } });
    const restricted = { ...actor, permissions: actor.permissions.filter((permission) => permission !== "Subscriptions.ManageRenewalExclusions") };
    const redacted = await listSubscriptionRenewalWaivers({ limit: 1 }, restricted, { correlationId: "waiver-report-redacted" });
    expect(redacted).toMatchObject({ ok: true, value: { waivers: [{ hasReason: true }] } });
    if (!redacted.ok) throw new Error(redacted.error.code);
    expect(redacted.value.waivers[0]).not.toHaveProperty("reason");
    const audits = await prisma.auditEvent.findMany({ where: { eventType: "SUBSCRIPTION_RENEWAL_WAIVERS_VIEWED" }, select: { payload: true } });
    expect(JSON.stringify(audits)).not.toContain("Justificacion privada");
    expect(JSON.stringify(audits)).not.toContain(firstPage.value.nextCursor);
  });

  it("materializes an accepted blocked group as pending atomically and replays the failure", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const renewalDate = todayDate();
    const commands = ["Bloqueada A", "Bloqueada B"].map((name) => payload(customerId, itemId, { name, startDate: renewalDate }));
    const subscriptions: Array<{ id: string; version: number }> = [];
    for (let index = 0; index < commands.length; index += 1) {
      const created = await createSubscription(commands[index]!, actor, context(`blocked-create-${index}`, commands[index]!)); if (!created.ok) throw new Error(created.error.code);
      const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context(`blocked-activate-${index}`, { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
      subscriptions.push({ id: created.value.id, version: activated.value.version });
    }
    await prisma.customer.update({ where: { id: customerId }, data: { status: "INACTIVE" } });
    const companyId = (await prisma.installation.findFirstOrThrow()).companyId!;
    const blockedCommand = {
      companyId,
      subscriptionIds: subscriptions.map((subscription) => subscription.id),
      expectedVersions: Object.fromEntries(subscriptions.map((subscription) => [subscription.id, subscription.version])),
      issueDate: renewalDate
    };
    const blocked = await createSubscriptionRenewalDraft(blockedCommand, actor, renewalContext("blocked-group", blockedCommand));
    expect(blocked).toMatchObject({ ok: false, status: 422, error: { code: "CUSTOMER_NOT_ACTIVE" } });
    expect(await createSubscriptionRenewalDraft(blockedCommand, actor, renewalContext("blocked-group", blockedCommand))).toEqual(blocked);
    expect(await prisma.invoice.count({ where: { origin: "SUBSCRIPTION" } })).toBe(0);
    expect(await prisma.subscriptionRenewalReservation.count()).toBe(0);
    expect(await prisma.subscription.findMany({ where: { id: { in: subscriptions.map((subscription) => subscription.id) } }, select: { status: true, version: true } })).toEqual([
      { status: "RENEWAL_PENDING", version: 3 }, { status: "RENEWAL_PENDING", version: 3 }
    ]);
    const exclusions = await prisma.subscriptionRenewalExclusion.findMany({ orderBy: { subscriptionId: "asc" }, select: { id: true, subscriptionId: true, reasonCode: true, attemptCount: true, lastErrorCode: true } });
    expect(exclusions).toHaveLength(2);
    expect(exclusions.every((exclusion) => exclusion.reasonCode === "PREPARATION_FAILED" && exclusion.attemptCount === 1 && exclusion.lastErrorCode === "CUSTOMER_NOT_ACTIVE")).toBe(true);
    const attempts = await prisma.subscriptionRenewalAttempt.findMany({ include: { members: true } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ phase: "PREPARE", outcome: "BLOCKED", errorCode: "CUSTOMER_NOT_ACTIVE", invoiceId: null });
    expect(attempts[0]!.members).toHaveLength(2);
    expect(await listSubscriptionRenewalExclusions({ limit: 25, workState: "BLOCKED" }, actor)).toMatchObject({
      ok: true, value: { exclusions: [{ work: { state: "BLOCKED", blockers: ["CUSTOMER_NOT_ACTIVE"] } }, { work: { state: "BLOCKED", blockers: ["CUSTOMER_NOT_ACTIVE"] } }] }
    });
    await expect(prisma.subscriptionRenewalAttempt.delete({ where: { id: attempts[0]!.id } })).rejects.toThrow();
    await prisma.customer.update({ where: { id: customerId }, data: { status: "ACTIVE" } });
    const retry = {
      ...blockedCommand,
      expectedVersions: Object.fromEntries(subscriptions.map((subscription) => [subscription.id, 3])),
      pendingExclusionIds: Object.fromEntries(exclusions.map((exclusion) => [exclusion.subscriptionId, exclusion.id]))
    };
    expect(await createSubscriptionRenewalDraft(retry, actor, renewalContext("blocked-group-retry", retry))).toMatchObject({ ok: true, status: 201 });
    expect((await prisma.subscriptionRenewalExclusion.findMany({ select: { attemptCount: true, lastErrorCode: true } })).every((exclusion) => exclusion.attemptCount === 2 && exclusion.lastErrorCode === null)).toBe(true);
  });

  it("does not create pending evidence for an invalid group selection", async () => {
    const actor = await admin(); const itemId = await catalogItem(actor.id); const renewalDate = todayDate();
    const customerIds = [await customer(actor.id), await customer(actor.id)];
    const ids: string[] = [];
    for (let index = 0; index < customerIds.length; index += 1) {
      const command = payload(customerIds[index]!, itemId, { name: `Grupo invalido ${index}`, startDate: renewalDate });
      const created = await createSubscription(command, actor, context(`invalid-group-create-${index}`, command)); if (!created.ok) throw new Error(created.error.code);
      const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context(`invalid-group-activate-${index}`, { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
      ids.push(created.value.id);
    }
    const companyId = (await prisma.installation.findFirstOrThrow()).companyId!;
    const invalid = { companyId, subscriptionIds: ids, expectedVersions: Object.fromEntries(ids.map((id) => [id, 2])), issueDate: renewalDate };
    expect(await createSubscriptionRenewalDraft(invalid, actor, renewalContext("invalid-group", invalid))).toMatchObject({ ok: false, status: 422, error: { code: "SUBSCRIPTION_RENEWAL_GROUP_INVALID" } });
    expect(await prisma.subscriptionRenewalExclusion.count()).toBe(0);
    expect(await prisma.subscriptionRenewalAttempt.count()).toBe(0);
    expect((await prisma.subscription.findMany({ where: { id: { in: ids } }, select: { status: true, version: true } })).every((subscription) => subscription.status === "ACTIVE" && subscription.version === 2)).toBe(true);
  });

  it("materializes a closed fiscal-year blocker and seals attempt membership", async () => {
    const actor = await admin(); const customerId = await customer(actor.id); const itemId = await catalogItem(actor.id); const renewalDate = todayDate();
    const companyId = (await prisma.installation.findFirstOrThrow()).companyId!;
    const ids: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const createCommand = payload(customerId, itemId, { name: `Ejercicio cerrado ${index}`, startDate: renewalDate });
      const created = await createSubscription(createCommand, actor, context(`fiscal-block-create-${index}`, createCommand)); if (!created.ok) throw new Error(created.error.code);
      const activated = await activateSubscription(created.value.id, { version: 1 }, actor, context(`fiscal-block-activate-${index}`, { version: 1 })); if (!activated.ok) throw new Error(activated.error.code);
      ids.push(created.value.id);
    }
    await prisma.accountingFiscalYear.deleteMany({ where: { companyId } });
    for (let index = 0; index < ids.length; index += 1) {
      const subscriptionId = ids[index]!;
      const blockedCommand = { companyId, subscriptionIds: [subscriptionId], expectedVersions: { [subscriptionId]: 2 }, issueDate: renewalDate };
      expect(await createSubscriptionRenewalDraft(blockedCommand, actor, renewalContext(`fiscal-block-${index}`, blockedCommand))).toMatchObject({
        ok: false, status: 409, error: { code: "INVOICE_ACCOUNTING_FISCAL_YEAR_NOT_OPEN" }
      });
    }
    expect((await prisma.subscription.findMany({ where: { id: { in: ids } }, select: { status: true, version: true } })).every((subscription) => subscription.status === "RENEWAL_PENDING" && subscription.version === 3)).toBe(true);
    const attempts = await prisma.subscriptionRenewalAttempt.findMany({ orderBy: { attemptedAt: "asc" }, include: { members: true } });
    expect(attempts).toHaveLength(2);
    expect(attempts.every((attempt) => attempt.phase === "PREPARE" && attempt.outcome === "BLOCKED" && attempt.errorCode === "INVOICE_ACCOUNTING_FISCAL_YEAR_NOT_OPEN")).toBe(true);
    expect(await listSubscriptionRenewalExclusions({ limit: 25, workState: "BLOCKED" }, actor)).toMatchObject({
      ok: true, value: { exclusions: [{ work: { state: "BLOCKED", blockers: ["INVOICE_ACCOUNTING_FISCAL_YEAR_NOT_OPEN"] } }, { work: { state: "BLOCKED", blockers: ["INVOICE_ACCOUNTING_FISCAL_YEAR_NOT_OPEN"] } }] }
    });
    const lateMember = attempts[1]!.members[0]!;
    await expect(prisma.subscriptionRenewalAttemptMember.create({ data: {
      attemptId: attempts[0]!.id, companyId: lateMember.companyId,
      subscriptionId: lateMember.subscriptionId, periodStart: lateMember.periodStart,
      subscriptionVersionSnapshot: lateMember.subscriptionVersionSnapshot,
      exclusionId: lateMember.exclusionId, reservationId: null
    } })).rejects.toThrow();
    expect(await prisma.subscriptionRenewalAttemptMember.count({ where: { attemptId: attempts[0]!.id } })).toBe(1);
  });
});

function payload(customerId: string, catalogItemId: string, overrides: Record<string, unknown> = {}) { return { customerId, name: "Soporte mensual", periodicity: "MONTHLY" as const, pricingMode: "FIXED" as const, startDate: "2026-09-01", endDate: null, notes: "Nota privada", lines: [{ catalogItemId, quantity: "1.000", discountPercent: "0.00", discountAmount: "0.00" }], ...overrides }; }
function context(key: string, value: unknown) { return { idempotencyKey: `subscriptions-test:${key}`, requestHash: hashSubscriptionRequest(value), correlationId: `subscriptions-${key}` }; }
function reactivationScheduleContext(action: "create" | "revoke" | "apply", key: string, subscriptionId: string, scheduleId: string | null, value: object) { const semantic = scheduleId ? { subscriptionId, scheduleId, ...value } : { subscriptionId, ...value }; return { idempotencyKey: `subscription-reactivation-schedules-test:${key}`, requestHash: hashSubscriptionReactivationScheduleRequest(action, semantic), correlationId: `subscription-reactivation-schedules-${key}` }; }
function changeScheduleContext(action: "create" | "revoke", key: string, subscriptionId: string, scheduleId: string | null, value: object) { const semantic = scheduleId ? { subscriptionId, scheduleId, ...value } : { subscriptionId, ...value }; return { idempotencyKey: `subscription-change-schedules-test:${key}`, requestHash: hashSubscriptionChangeScheduleRequest(action, semantic), correlationId: `subscription-change-schedules-${key}` }; }
function renewalContext(key: string, value: Parameters<typeof hashSubscriptionRenewalDraftRequest>[0]) { return { idempotencyKey: `subscription-renewals-test:${key}`, requestHash: hashSubscriptionRenewalDraftRequest(value), correlationId: `subscription-renewals-${key}` }; }
function confirmationContext(key: string, value: Parameters<typeof hashSubscriptionRenewalConfirmationRequest>[0]) { return { idempotencyKey: `subscription-renewal-confirmations-test:${key}`, requestHash: hashSubscriptionRenewalConfirmationRequest(value), correlationId: `subscription-renewal-confirmations-${key}` }; }
function releaseContext(key: string, value: Parameters<typeof hashSubscriptionRenewalReleaseRequest>[0]) { return { idempotencyKey: `subscription-renewal-releases-test:${key}`, requestHash: hashSubscriptionRenewalReleaseRequest(value), correlationId: `subscription-renewal-releases-${key}` }; }
function exclusionContext(key: string, value: Parameters<typeof hashSubscriptionRenewalExclusionRequest>[0]) { return { idempotencyKey: `subscription-renewal-exclusions-test:${key}`, requestHash: hashSubscriptionRenewalExclusionRequest(value), correlationId: `subscription-renewal-exclusions-${key}` }; }
function waiverContext(key: string, value: Parameters<typeof hashSubscriptionRenewalWaiverRequest>[0]) { return { idempotencyKey: `subscription-renewal-waivers-test:${key}`, requestHash: hashSubscriptionRenewalWaiverRequest(value), correlationId: `subscription-renewal-waivers-${key}` }; }
function fiscalReviewContext(key: string, reviewId: string, value: { expectedVersion: 1 }) { return { idempotencyKey: `subscription-renewal-waiver-fiscal-review-test:${key}`, requestHash: hashStartRenewalWaiverFiscalReview(reviewId, value), correlationId: `subscription-renewal-waiver-fiscal-review-${key}` }; }
function fiscalReviewDecisionContext(key: string, reviewId: string, value: Parameters<typeof hashDecideRenewalWaiverFiscalReview>[1]) { return { idempotencyKey: `subscription-renewal-waiver-fiscal-review-test:${key}`, requestHash: hashDecideRenewalWaiverFiscalReview(reviewId, value), correlationId: `subscription-renewal-waiver-fiscal-review-${key}` }; }
function fiscalReviewCompletionContext(key: string, reviewId: string, value: Parameters<typeof hashCompleteRenewalWaiverFiscalReview>[1]) { return { idempotencyKey: `subscription-renewal-waiver-fiscal-review-test:${key}`, requestHash: hashCompleteRenewalWaiverFiscalReview(reviewId, value), correlationId: `subscription-renewal-waiver-fiscal-review-${key}` }; }
function waiverReversalRequestContext(key: string, reviewId: string, value: Parameters<typeof hashWaiverEvidenceReversalRequest>[1]) { return { idempotencyKey: `accounting-waiver-reversal-test:${key}`, requestHash: hashWaiverEvidenceReversalRequest(reviewId, value), correlationId: `accounting-waiver-reversal-${key}` }; }
function waiverReversalApprovalContext(key: string, requestId: string, value: Parameters<typeof hashWaiverEvidenceReversalApproval>[1]) { return { idempotencyKey: `accounting-waiver-reversal-test:${key}`, requestHash: hashWaiverEvidenceReversalApproval(requestId, value), correlationId: `accounting-waiver-reversal-${key}` }; }
function waiverReplacementRequestContext(key: string, reviewId: string, value: Parameters<typeof hashWaiverEvidenceReplacementRequest>[1]) { return { idempotencyKey: `accounting-waiver-replacement-test:${key}`, requestHash: hashWaiverEvidenceReplacementRequest(reviewId, value), correlationId: `accounting-waiver-replacement-${key}` }; }
function waiverReplacementApprovalContext(key: string, requestId: string, value: Parameters<typeof hashWaiverEvidenceReplacementApproval>[1]) { return { idempotencyKey: `accounting-waiver-replacement-test:${key}`, requestHash: hashWaiverEvidenceReplacementApproval(requestId, value), correlationId: `accounting-waiver-replacement-${key}` }; }
function waiverReplacementRejectionContext(key: string, requestId: string, value: Parameters<typeof hashWaiverEvidenceReplacementRejection>[1]) { return { idempotencyKey: `accounting-waiver-replacement-test:${key}`, requestHash: hashWaiverEvidenceReplacementRejection(requestId, value), correlationId: `accounting-waiver-replacement-${key}` }; }
function waiverReplacementCancellationContext(key: string, requestId: string, value: Parameters<typeof hashWaiverEvidenceReplacementCancellation>[1]) { return { idempotencyKey: `accounting-waiver-replacement-test:${key}`, requestHash: hashWaiverEvidenceReplacementCancellation(requestId, value), correlationId: `accounting-waiver-replacement-${key}` }; }
function updatePayload(subscription: { version: number; customer: { id: string }; name: string; periodicity: "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL"; pricingMode: "FIXED" | "PER_LICENSE"; startDate: string; endDate: string | null; notes: string | null; lines: Array<{ catalogItemId: string; quantity: string }> }, overrides: Record<string, unknown> = {}) { return { expectedVersion: subscription.version, customerId: subscription.customer.id, name: subscription.name, periodicity: subscription.periodicity, pricingMode: subscription.pricingMode, startDate: subscription.startDate, endDate: subscription.endDate, notes: subscription.notes, lines: subscription.lines.map((line) => ({ catalogItemId: line.catalogItemId, quantity: line.quantity })), ...overrides }; }
async function admin() { const result = await login({ userName: "admin", password }); if (!result.ok) throw new Error(result.error.code); return result.value.user; }
async function fiscalReviewer() { const role = await prisma.role.create({ data: { code: "WaiverFiscalReviewer", name: "Revision fiscal de condonaciones", permissions: { create: ["Subscriptions.ViewRenewalWaivers", "Subscriptions.ViewRenewalWaiverFiscalReviews", "Subscriptions.DecideRenewalWaiverFiscalReviews", "Subscriptions.CompleteRenewalWaiverFiscalReviews"].map((code) => ({ permission: { connect: { code } } })) } } }); await prisma.user.create({ data: { displayName: "Revisor Fiscal", userName: "waiver-fiscal-reviewer", normalizedUserName: "waiver-fiscal-reviewer", passwordHash: hashPassword("Cambiar-reviewer-2026"), roleId: role.id } }); const result = await login({ userName: "waiver-fiscal-reviewer", password: "Cambiar-reviewer-2026" }); if (!result.ok) throw new Error(result.error.code); return result.value.user; }
async function fiscalCompletionObserver() { const role = await prisma.role.findUniqueOrThrow({ where: { code: "WaiverFiscalReviewer" } }); await prisma.user.create({ data: { displayName: "Segundo Revisor", userName: "waiver-fiscal-observer", normalizedUserName: "waiver-fiscal-observer", passwordHash: hashPassword("Cambiar-observer-2026"), roleId: role.id } }); const result = await login({ userName: "waiver-fiscal-observer", password: "Cambiar-observer-2026" }); if (!result.ok) throw new Error(result.error.code); return result.value.user; }
async function accountingReversalApprover() { const role = await prisma.role.create({ data: { code: "WaiverAccountingReversalApprover", name: "Aprobacion de reversiones contables", permissions: { create: ["Accounting.ApproveWaiverEvidenceReversals"].map((code) => ({ permission: { connect: { code } } })) } } }); await prisma.user.create({ data: { displayName: "Aprobador Contable", userName: "waiver-accounting-approver", normalizedUserName: "waiver-accounting-approver", passwordHash: hashPassword("Cambiar-approver-2026"), roleId: role.id } }); const result = await login({ userName: "waiver-accounting-approver", password: "Cambiar-approver-2026" }); if (!result.ok) throw new Error(result.error.code); return result.value.user; }
async function initialize() { const raw = JSON.stringify(initialization); const result = await initializePlatform(initialization, randomUUID(), hashRequestBody(raw)); if (!result.ok) throw new Error(result.error.code); const installation = await prisma.installation.findFirstOrThrow(); await prisma.accountingFiscalYear.create({ data: { companyId: installation.companyId!, year: 2026, startDate: new Date("2026-01-01T00:00:00.000Z"), endDate: new Date("2026-12-31T00:00:00.000Z"), planCode: "PGC_PYMES", planVersion: "2021.1", createdById: installation.initialAdministratorId! } }); }
async function customer(createdById: string) { const suffix = randomUUID().replaceAll("-", "").slice(0, 12); return (await prisma.customer.create({ data: { code: `C${suffix.slice(0, 8)}`, type: "COMPANY", legalName: "Cliente Suscripciones SL", taxId: `VAT-${suffix}`, normalizedTaxId: `VAT${suffix}`, fiscalTreatment: "DOMESTIC", fiscalAddressLine: "Calle Test 1", fiscalPostalCode: "28001", fiscalCity: "Madrid", fiscalCountry: "ES", createdById } })).id; }
async function catalogItem(createdById: string) { const tax = await prisma.catalogTaxRate.findFirstOrThrow({ where: { code: "IVA_21" } }); return (await prisma.catalogItem.create({ data: { code: `S${randomUUID().slice(0, 8)}`, kind: "SERVICE", name: `Servicio recurrente ${randomUUID()}`, salePrice: "49.90", taxRateId: tax.id, taxRate: tax.rate, createdById } })).id; }
async function seedInvoiceAccounts(createdById: string, customerCode: string) { const fiscalYear = await prisma.accountingFiscalYear.findFirstOrThrow({ where: { year: 2026 } }); await prisma.accountingAccount.createMany({ data: [
  { fiscalYearId: fiscalYear.id, code: `430${customerCode.padStart(6, "0")}`, name: "Cliente renovacion", type: "ASSET", level: 4, isPostable: true, createdById },
  { fiscalYearId: fiscalYear.id, code: "705000000", name: "Prestaciones de servicios", type: "INCOME", level: 4, isPostable: true, createdById },
  { fiscalYearId: fiscalYear.id, code: "477000000", name: "IVA repercutido", type: "LIABILITY", level: 4, isPostable: true, createdById }
] }); }
function testSifInstallation(companyId: string) { return {
  companyId, installationCode: "SUBSCRIPTIONS-TEST-SIF", environment: "TEST" as const,
  contractVersion: "VF_V1", schemaVersion: "tikeV1.0",
  artifactManifestVersion: "AEAT_VERIFACTU_ARTIFACTS_V1", artifactManifestSha256: "a".repeat(64),
  producerTaxId: "B12345678", producerName: "CriGestion Test SL", systemName: "CriGestion",
  systemId: "CG", systemVersion: "0.1.0", installationNumber: "SUBSCRIPTIONS-TEST-1",
  activatedAt: new Date("2026-08-06T09:00:00.000Z")
}; }
async function seedDueCancellation(companyId: string, subscriptionId: string, requestedById: string, reason: string) {
  const effectiveDate = todayDate();
  return prisma.$transaction(async (tx) => {
    // Historical fixture: production inserts must always pass the trigger and be future-dated.
    await tx.$executeRawUnsafe('ALTER TABLE "subscription_cancellation_schedules" DISABLE TRIGGER "subscription_cancellation_schedule_history_trigger"');
    const schedule = await tx.subscriptionCancellationSchedule.create({
      data: {
        companyId, subscriptionId, effectiveDate: new Date(`${effectiveDate}T00:00:00.000Z`),
        reason, createdAgainstVersion: 2, requestedById
      },
      select: { id: true }
    });
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
    await tx.$executeRawUnsafe('ALTER TABLE "subscription_cancellation_schedules" ENABLE TRIGGER "subscription_cancellation_schedule_history_trigger"');
    await tx.subscription.update({ where: { id: subscriptionId }, data: { version: { increment: 1 } } });
    return schedule;
  });
}
async function resolveCancellationWithRetry(companyId: string, subscriptionId: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        (tx) => resolveScheduledCancellationBeforeRenewal(tx, { companyId, subscriptionId }),
        { isolationLevel: "Serializable" }
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
async function makeReactivationScheduleDue(subscriptionId: string, scheduleId: string) {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayDate = new Date(`${yesterday.toISOString().slice(0, 10)}T00:00:00.000Z`);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE "subscriptions" DISABLE TRIGGER "subscription_header_lifecycle_trigger"');
    await tx.$executeRawUnsafe('ALTER TABLE "subscription_reactivation_schedules" DISABLE TRIGGER "subscription_reactivation_schedule_history_trigger"');
    await tx.subscription.update({ where: { id: subscriptionId }, data: { cancelledAt: yesterday, cancellationEffectiveDate: yesterdayDate } });
    await tx.subscriptionReactivationSchedule.update({
      where: { id: scheduleId },
      data: {
        requestedAt: yesterday,
        effectiveDate: new Date(`${todayDate()}T00:00:00.000Z`),
        cancelledAtSnapshot: yesterday,
        cancellationEffectiveDateSnapshot: yesterdayDate
      }
    });
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
    await tx.$executeRawUnsafe('ALTER TABLE "subscription_reactivation_schedules" ENABLE TRIGGER "subscription_reactivation_schedule_history_trigger"');
    await tx.$executeRawUnsafe('ALTER TABLE "subscriptions" ENABLE TRIGGER "subscription_header_lifecycle_trigger"');
  });
}
async function reset() { await prisma.$executeRawUnsafe('TRUNCATE TABLE "companies", "roles", "permissions", "reserved_user_names", "idempotency_records" RESTART IDENTITY CASCADE'); }
function todayDate() { const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); const value = Object.fromEntries(parts.map((part) => [part.type, part.value])); return `${value.year}-${value.month}-${value.day}`; }
function previousMonthDate(value: string) { const date = new Date(`${value}T00:00:00.000Z`); date.setUTCMonth(date.getUTCMonth() - 1); return date.toISOString().slice(0, 10); }
function futureDate() { return new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); }
function nextDay(value: string) { return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value ? new Date(new Date(`${value}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10) : value; }
