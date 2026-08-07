import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { GET as subscriptionsGet, POST as subscriptionsPost } from "@/app/api/subscriptions/route";
import { GET as subscriptionGet, PUT as subscriptionPut } from "@/app/api/subscriptions/[subscriptionId]/route";
import { POST as subscriptionActivate } from "@/app/api/subscriptions/[subscriptionId]/activate/route";
import { POST as subscriptionCancel } from "@/app/api/subscriptions/[subscriptionId]/cancel/route";
import { POST as subscriptionSchedule } from "@/app/api/subscriptions/[subscriptionId]/cancellation-schedules/route";
import { POST as subscriptionScheduleCancel } from "@/app/api/subscriptions/[subscriptionId]/cancellation-schedules/[scheduleId]/cancel/route";
import { GET as renewalsGet, POST as renewalsPost } from "@/app/api/subscriptions/renewals/route";
import { POST as renewalConfirm } from "@/app/api/subscriptions/renewals/[invoiceId]/confirm/route";
import { POST as renewalRelease } from "@/app/api/subscriptions/renewals/[invoiceId]/release/route";
import { POST as renewalExclude } from "@/app/api/subscriptions/[subscriptionId]/renewal-exclusions/route";
import { GET as renewalExclusionsGet } from "@/app/api/subscriptions/renewal-exclusions/route";
import { POST as renewalWaive } from "@/app/api/subscriptions/[subscriptionId]/renewal-exclusions/[exclusionId]/waive/route";
import { GET as renewalWaiversGet } from "@/app/api/subscriptions/renewal-waivers/route";
import { POST as renewalWaiversExport } from "@/app/api/subscriptions/renewal-waivers/export/route";
import { POST as renewalWaiverFiscalReviewStart } from "@/app/api/subscriptions/renewal-waiver-fiscal-reviews/[reviewId]/start/route";
import { POST as renewalWaiverFiscalReviewDecide } from "@/app/api/subscriptions/renewal-waiver-fiscal-reviews/[reviewId]/decide/route";
import { POST as renewalWaiverFiscalReviewComplete } from "@/app/api/subscriptions/renewal-waiver-fiscal-reviews/[reviewId]/complete/route";
import { POST as waiverEvidenceReversalRequest } from "@/app/api/subscriptions/renewal-waiver-fiscal-reviews/[reviewId]/accounting-reversals/route";
import { POST as waiverEvidenceReversalApprove } from "@/app/api/accounting/waiver-evidence-reversals/[requestId]/approve/route";
import { POST as waiverEvidenceReversalReject } from "@/app/api/accounting/waiver-evidence-reversals/[requestId]/reject/route";
import { POST as waiverEvidenceReversalCancel } from "@/app/api/accounting/waiver-evidence-reversals/[requestId]/cancel/route";
import { POST as waiverEvidenceReplacementRequest } from "@/app/api/subscriptions/renewal-waiver-fiscal-reviews/[reviewId]/accounting-replacements/route";
import { POST as waiverEvidenceReplacementApprove } from "@/app/api/accounting/waiver-evidence-replacements/[requestId]/approve/route";
import { POST as waiverEvidenceReplacementReject } from "@/app/api/accounting/waiver-evidence-replacements/[requestId]/reject/route";
import { POST as waiverEvidenceReplacementCancel } from "@/app/api/accounting/waiver-evidence-replacements/[requestId]/cancel/route";
import { GET as waiverEvidenceReplacementGet } from "@/app/api/accounting/waiver-evidence-replacements/[requestId]/route";
import { prisma } from "@/lib/prisma";
import { sessionCookieName } from "@/modules/platform/application/auth";
import { hashRequestBody, initializePlatform, type InitializeCommand } from "@/modules/platform/application/installation";
import { hashPassword } from "@/modules/platform/application/passwords";

const cookieMock = vi.hoisted(() => { const values = new Map<string, string>(); return { values, store: { get(name: string) { const value = values.get(name); return value ? { name, value } : undefined; }, set(name: string, value: string) { values.set(name, value); }, delete(name: string) { values.delete(name); } }, reset() { values.clear(); } }; });
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieMock.store) }));
const password = "Cambiar-esta-clave-2026";
const initialization: InitializeCommand = { company: { legalName: "CriGestion Test SL", taxId: "B12345678", email: "admin@example.test" }, administrator: { displayName: "Administrador", userName: "admin", password } };

describe("subscription HTTP contracts", () => {
  beforeEach(async () => { process.env.APP_BASE_URL = "http://localhost:3000"; process.env.AUTH_COOKIE_SECURE = "false"; cookieMock.reset(); await reset(); await initialize(); }, 30_000);
  afterAll(async () => { await reset(); await prisma.$disconnect(); }, 30_000);

  it("requires authentication, CSRF, origin and idempotency", async () => {
    expect((await subscriptionsGet(apiRequest("/api/subscriptions"))).status).toBe(401);
    expect((await subscriptionGet(apiRequest("/api/subscriptions/no"), { params: Promise.resolve({ subscriptionId: "no" }) })).status).toBe(401);
    expect((await waiverEvidenceReplacementGet(apiRequest(`/api/accounting/waiver-evidence-replacements/${randomUUID()}`),
      { params: Promise.resolve({ requestId: randomUUID() }) })).status).toBe(401);
    await login(); const references = await createReferences();
    expect((await subscriptionsPost(jsonRequest("/api/subscriptions", payload(references), { origin: "https://evil.example" }))).status).toBe(403);
    expect((await subscriptionsPost(jsonRequest("/api/subscriptions", payload(references)))).status).toBe(403);
    const csrf = await csrfToken(); expect((await subscriptionsPost(jsonRequest("/api/subscriptions", payload(references), { csrf, idempotency: null }))).status).toBe(400);
    expect((await subscriptionsPost(new Request("http://localhost/api/subscriptions", { method: "POST", headers: { Origin: "http://localhost:3000", "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID(), "Content-Type": "text/plain" }, body: "{}" }))).status).toBe(415);
    expect((await subscriptionGet(apiRequest("/api/subscriptions/no"), { params: Promise.resolve({ subscriptionId: "no" }) })).status).toBe(422);
    const reviewId = randomUUID(); const requestId = randomUUID();
    const reviewContext = { params: Promise.resolve({ reviewId }) }; const reversalContext = { params: Promise.resolve({ requestId }) };
    const invalidReplacementDetail = await waiverEvidenceReplacementGet(apiRequest("/api/accounting/waiver-evidence-replacements/no"),
      { params: Promise.resolve({ requestId: "no" }) });
    expect(invalidReplacementDetail.status).toBe(422);
    expect(invalidReplacementDetail.headers.get("cache-control")).toContain("private, no-store");
    const missingReplacementDetail = await waiverEvidenceReplacementGet(apiRequest(`/api/accounting/waiver-evidence-replacements/${requestId}`), reversalContext);
    expect(missingReplacementDetail.status).toBe(404);
    expect(missingReplacementDetail.headers.get("vary")).toBe("Cookie");
    const reversalBody = { expectedReviewVersion: 4, reasonCode: "ACCOUNTING_ERROR", reasonDetail: "Corrección contable suficientemente justificada", accountingDate: todayDate() };
    expect((await waiverEvidenceReversalRequest(jsonRequest(`/api/subscriptions/renewal-waiver-fiscal-reviews/${reviewId}/accounting-reversals`, reversalBody, { csrf, origin: "https://evil.example" }), reviewContext)).status).toBe(403);
    expect((await waiverEvidenceReversalRequest(jsonRequest(`/api/subscriptions/renewal-waiver-fiscal-reviews/${reviewId}/accounting-reversals`, reversalBody), reviewContext)).status).toBe(403);
    expect((await waiverEvidenceReversalRequest(jsonRequest(`/api/subscriptions/renewal-waiver-fiscal-reviews/${reviewId}/accounting-reversals`, reversalBody, { csrf, idempotency: null }), reviewContext)).status).toBe(400);
    expect((await waiverEvidenceReversalRequest(jsonRequest(`/api/subscriptions/renewal-waiver-fiscal-reviews/${reviewId}/accounting-reversals`, { ...reversalBody, unexpected: true }, { csrf }), reviewContext)).status).toBe(422);
    expect((await waiverEvidenceReversalApprove(jsonRequest(`/api/accounting/waiver-evidence-reversals/${requestId}/approve`, { expectedVersion: 1, unexpected: true }, { csrf }), reversalContext)).status).toBe(422);
    expect((await waiverEvidenceReversalReject(jsonRequest(`/api/accounting/waiver-evidence-reversals/${requestId}/reject`, { expectedVersion: 1, rejectionDetail: "corto" }, { csrf }), reversalContext)).status).toBe(422);
    expect((await waiverEvidenceReversalCancel(jsonRequest(`/api/accounting/waiver-evidence-reversals/${requestId}/cancel`, { expectedVersion: 1 }, { csrf, origin: "https://evil.example" }), reversalContext)).status).toBe(403);
    const replacementBody = { expectedReviewVersion: 4, reasonCode: "CORRECTED_AMOUNT", reasonDetail: "Corrección contable suficientemente justificada",
      accountingDate: todayDate(), concept: "Sustitución propuesta", lines: [
        { accountId: randomUUID(), concept: "Debe", debit: "1.00", credit: "0.00" },
        { accountId: randomUUID(), concept: "Haber", debit: "0.00", credit: "1.00" }
      ] };
    expect((await waiverEvidenceReplacementRequest(jsonRequest(`/api/subscriptions/renewal-waiver-fiscal-reviews/${reviewId}/accounting-replacements`, replacementBody, { csrf, origin: "https://evil.example" }), reviewContext)).status).toBe(403);
    expect((await waiverEvidenceReplacementRequest(jsonRequest(`/api/subscriptions/renewal-waiver-fiscal-reviews/${reviewId}/accounting-replacements`, replacementBody), reviewContext)).status).toBe(403);
    expect((await waiverEvidenceReplacementRequest(jsonRequest(`/api/subscriptions/renewal-waiver-fiscal-reviews/${reviewId}/accounting-replacements`, replacementBody, { csrf, idempotency: null }), reviewContext)).status).toBe(400);
    expect((await waiverEvidenceReplacementRequest(jsonRequest(`/api/subscriptions/renewal-waiver-fiscal-reviews/${reviewId}/accounting-replacements`, { ...replacementBody, accountingDate: "2026-02-31" }, { csrf }), reviewContext)).status).toBe(422);
    expect((await waiverEvidenceReplacementApprove(jsonRequest(`/api/accounting/waiver-evidence-replacements/${requestId}/approve`, { expectedVersion: 1, unexpected: true }, { csrf }), reversalContext)).status).toBe(422);
    expect((await waiverEvidenceReplacementReject(jsonRequest(`/api/accounting/waiver-evidence-replacements/${requestId}/reject`, { expectedVersion: 1, rejectionDetail: "corto" }, { csrf }), reversalContext)).status).toBe(422);
    expect((await waiverEvidenceReplacementCancel(jsonRequest(`/api/accounting/waiver-evidence-replacements/${requestId}/cancel`, { expectedVersion: 1 }, { csrf, origin: "https://evil.example" }), reversalContext)).status).toBe(403);
  });

  it("creates, edits, lists, reads, activates and cancels a subscription", async () => {
    await login(); const csrf = await csrfToken(); const references = await createReferences(); const effectiveDate = futureDate();
    const creation = await subscriptionsPost(jsonRequest("/api/subscriptions", payload(references, effectiveDate), { csrf })); expect(creation.status).toBe(201); const created = await creation.json() as { id: string; version: number; status: string };
    expect(created).toMatchObject({ version: 1, status: "DRAFT" }); expect((await subscriptionsGet(apiRequest("/api/subscriptions"))).status).toBe(200);
    const detail = await subscriptionGet(apiRequest(`/api/subscriptions/${created.id}`), { params: Promise.resolve({ subscriptionId: created.id }) }); expect(detail.status).toBe(200);
    const updateBody = { expectedVersion: 1, ...payload(references, effectiveDate), name: "Soporte actualizado" };
    const update = await subscriptionPut(putRequest(`/api/subscriptions/${created.id}`, updateBody, { csrf }), { params: Promise.resolve({ subscriptionId: created.id }) }); expect(update.status).toBe(200); expect(await update.json()).toMatchObject({ name: "Soporte actualizado", version: 2 });
    const activation = await subscriptionActivate(jsonRequest(`/api/subscriptions/${created.id}/activate`, { version: 2 }, { csrf }), { params: Promise.resolve({ subscriptionId: created.id }) }); expect(activation.status).toBe(200); expect(await activation.json()).toMatchObject({ status: "ACTIVE", version: 3 });
    const scheduledResponse = await subscriptionSchedule(jsonRequest(`/api/subscriptions/${created.id}/cancellation-schedules`, { expectedVersion: 3, effectiveDate, reason: "Baja futura" }, { csrf }), { params: Promise.resolve({ subscriptionId: created.id }) }); expect(scheduledResponse.status).toBe(201); const scheduled = await scheduledResponse.json() as { subscriptionVersion: number; schedule: { id: string; version: number } }; expect(scheduled).toMatchObject({ subscriptionVersion: 4, schedule: { version: 1 } });
    const revokedResponse = await subscriptionScheduleCancel(jsonRequest(`/api/subscriptions/${created.id}/cancellation-schedules/${scheduled.schedule.id}/cancel`, { expectedSubscriptionVersion: 4, expectedScheduleVersion: 1, reason: "Continua el servicio" }, { csrf }), { params: Promise.resolve({ subscriptionId: created.id, scheduleId: scheduled.schedule.id }) }); expect(revokedResponse.status).toBe(200); expect(await revokedResponse.json()).toMatchObject({ subscriptionVersion: 5, schedule: { status: "REVOKED", version: 2 } });
    const cancellation = await subscriptionCancel(jsonRequest(`/api/subscriptions/${created.id}/cancel`, { expectedVersion: 5, reason: "Baja solicitada" }, { csrf }), { params: Promise.resolve({ subscriptionId: created.id }) }); expect(cancellation.status).toBe(200); expect(await cancellation.json()).toMatchObject({ status: "CANCELLED", version: 6, cancellation: { reason: "Baja solicitada" } });
  });

  it("replays creation and rejects unknown fields and invalid ids", async () => {
    await login(); const csrf = await csrfToken(); const references = await createReferences(); const key = randomUUID();
    const first = await subscriptionsPost(jsonRequest("/api/subscriptions", payload(references), { csrf, idempotency: key })); const replay = await subscriptionsPost(jsonRequest("/api/subscriptions", payload(references), { csrf, idempotency: key })); expect(await replay.json()).toEqual(await first.json()); expect(await prisma.subscription.count()).toBe(1);
    expect((await subscriptionsPost(jsonRequest("/api/subscriptions", { ...payload(references), unexpected: true }, { csrf }))).status).toBe(422);
    expect((await subscriptionGet(apiRequest("/api/subscriptions/no"), { params: Promise.resolve({ subscriptionId: "no" }) })).status).toBe(422);
  });

  it("protects draft updates and cancellation with origin, CSRF and idempotency", async () => {
    await login(); const csrf = await csrfToken(); const references = await createReferences();
    const created = await (await subscriptionsPost(jsonRequest("/api/subscriptions", payload(references), { csrf }))).json() as { id: string; version: number };
    const updateBody = { expectedVersion: created.version, ...payload(references) };
    expect((await subscriptionPut(putRequest(`/api/subscriptions/${created.id}`, updateBody, { csrf, origin: "https://evil.example" }), { params: Promise.resolve({ subscriptionId: created.id }) })).status).toBe(403);
    expect((await subscriptionPut(putRequest(`/api/subscriptions/${created.id}`, updateBody), { params: Promise.resolve({ subscriptionId: created.id }) })).status).toBe(403);
    expect((await subscriptionPut(putRequest(`/api/subscriptions/${created.id}`, updateBody, { csrf, idempotency: null }), { params: Promise.resolve({ subscriptionId: created.id }) })).status).toBe(400);
    const activation = await subscriptionActivate(jsonRequest(`/api/subscriptions/${created.id}/activate`, { version: created.version }, { csrf }), { params: Promise.resolve({ subscriptionId: created.id }) }); expect(activation.status).toBe(200);
    expect((await subscriptionCancel(jsonRequest(`/api/subscriptions/${created.id}/cancel`, { expectedVersion: 2, reason: "Baja segura" }, { csrf, idempotency: null }), { params: Promise.resolve({ subscriptionId: created.id }) })).status).toBe(400);
    expect((await subscriptionSchedule(jsonRequest(`/api/subscriptions/${created.id}/cancellation-schedules`, { expectedVersion: 2, effectiveDate: futureDate(), reason: "Baja futura" }, { csrf, idempotency: null }), { params: Promise.resolve({ subscriptionId: created.id }) })).status).toBe(400);
  });

  it("allows view-only users to read but not create or activate", async () => {
    const references = await createReferences(); await login(); const adminCsrf = await csrfToken(); const created = await (await subscriptionsPost(jsonRequest("/api/subscriptions", payload(references), { csrf: adminCsrf }))).json() as { id: string; version: number };
    await createViewOnlyUser(); cookieMock.reset(); await login("viewer", "Cambiar-viewer-2026"); const csrf = await csrfToken();
    expect((await subscriptionsGet(apiRequest("/api/subscriptions"))).status).toBe(200);
    expect((await subscriptionsPost(jsonRequest("/api/subscriptions", payload(references), { csrf }))).status).toBe(403);
    expect((await renewalsGet(apiRequest(`/api/subscriptions/renewals?processDate=${todayDate()}`))).status).toBe(403);
    expect((await renewalsPost(jsonRequest("/api/subscriptions/renewals", { subscriptions: [{ subscriptionId: created.id, expectedVersion: created.version }], issueDate: todayDate() }, { csrf }))).status).toBe(403);
    expect((await subscriptionActivate(jsonRequest(`/api/subscriptions/${created.id}/activate`, { version: created.version }, { csrf }), { params: Promise.resolve({ subscriptionId: created.id }) })).status).toBe(403);
    expect((await subscriptionCancel(jsonRequest(`/api/subscriptions/${created.id}/cancel`, { expectedVersion: created.version, reason: "Sin permiso" }, { csrf }), { params: Promise.resolve({ subscriptionId: created.id }) })).status).toBe(403);
    expect((await subscriptionSchedule(jsonRequest(`/api/subscriptions/${created.id}/cancellation-schedules`, { expectedVersion: created.version, effectiveDate: futureDate(), reason: "Sin permiso" }, { csrf }), { params: Promise.resolve({ subscriptionId: created.id }) })).status).toBe(403);
  });

  it("protects renewal preview, preparation and release with the runner permission", async () => {
    expect((await renewalsGet(apiRequest(`/api/subscriptions/renewals?processDate=${todayDate()}`))).status).toBe(401);
    expect((await renewalExclusionsGet(apiRequest("/api/subscriptions/renewal-exclusions"))).status).toBe(401);
    await login(); const csrf = await csrfToken(); const references = await createReferences(); await prisma.customer.update({ where: { id: references.customerId }, data: { code: "6" } });
    const created = await (await subscriptionsPost(jsonRequest("/api/subscriptions", payload(references, todayDate()), { csrf }))).json() as { id: string; version: number };
    await subscriptionActivate(jsonRequest(`/api/subscriptions/${created.id}/activate`, { version: created.version }, { csrf }), { params: Promise.resolve({ subscriptionId: created.id }) });
    const installation = await prisma.installation.findFirstOrThrow();
    await seedRenewalAccounting(installation.companyId!, references.actorId, "6");
    expect((await renewalsGet(apiRequest(`/api/subscriptions/renewals?processDate=${todayDate()}`))).status).toBe(200);
    const body = { subscriptions: [{ subscriptionId: created.id, expectedVersion: 2 }], issueDate: todayDate() };
    expect((await renewalsPost(jsonRequest("/api/subscriptions/renewals", body, { csrf, origin: "https://evil.example" }))).status).toBe(403);
    expect((await renewalsPost(jsonRequest("/api/subscriptions/renewals", body))).status).toBe(403);
    expect((await renewalsPost(jsonRequest("/api/subscriptions/renewals", body, { csrf, idempotency: null }))).status).toBe(400);
    expect((await renewalsPost(jsonRequest("/api/subscriptions/renewals", { ...body, unexpected: true }, { csrf }))).status).toBe(422);
    expect((await renewalsPost(jsonRequest("/api/subscriptions/renewals", { ...body, issueDate: "2026-02-31" }, { csrf }))).status).toBe(422);
    const oversized = new Request("http://localhost/api/subscriptions/renewals", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() }, body: JSON.stringify({ padding: "x".repeat(17_000) }) });
    expect((await renewalsPost(oversized)).status).toBe(413);
    const prepared = await renewalsPost(jsonRequest("/api/subscriptions/renewals", body, { csrf })); expect(prepared.status).toBe(201);
    const invoiceId = ((await prepared.json()) as { invoiceId: string }).invoiceId;
    const released = await renewalRelease(jsonRequest(`/api/subscriptions/renewals/${invoiceId}/release`, { reason: "Correccion de la seleccion" }, { csrf }), { params: Promise.resolve({ invoiceId }) });
    expect(released.status).toBe(200); expect(await released.json()).toMatchObject({ invoiceId, subscriptionIds: [created.id] });
  });

  it("requires both confirmation and invoice issue permissions to emit a renewal", async () => {
    await login(); const adminToken = cookieMock.values.get(sessionCookieName)!; const csrf = await csrfToken(); const references = await createReferences(); await prisma.customer.update({ where: { id: references.customerId }, data: { code: "7" } });
    const created = await (await subscriptionsPost(jsonRequest("/api/subscriptions", payload(references, todayDate()), { csrf }))).json() as { id: string; version: number };
    await subscriptionActivate(jsonRequest(`/api/subscriptions/${created.id}/activate`, { version: created.version }, { csrf }), { params: Promise.resolve({ subscriptionId: created.id }) });
    const installation = await prisma.installation.findFirstOrThrow();
    await seedRenewalAccounting(installation.companyId!, references.actorId, "7");
    const prepared = await renewalsPost(jsonRequest("/api/subscriptions/renewals", { subscriptions: [{ subscriptionId: created.id, expectedVersion: 2 }], issueDate: todayDate() }, { csrf }));
    const invoiceId = ((await prepared.json()) as { invoiceId: string }).invoiceId;
    await createRenewalConfirmerWithoutBilling(); cookieMock.reset(); await login("renewal-confirmer", "Cambiar-confirmer-2026"); const partialCsrf = await csrfToken();
    expect((await renewalConfirm(jsonRequest(`/api/subscriptions/renewals/${invoiceId}/confirm`, {}, { csrf: partialCsrf }), { params: Promise.resolve({ invoiceId }) })).status).toBe(403);
    cookieMock.values.set(sessionCookieName, adminToken); const adminCsrf = await csrfToken();
    const confirmed = await renewalConfirm(jsonRequest(`/api/subscriptions/renewals/${invoiceId}/confirm`, {}, { csrf: adminCsrf }), { params: Promise.resolve({ invoiceId }) });
    expect(confirmed.status).toBe(200); expect(await confirmed.json()).toMatchObject({ invoiceId, subscriptions: [{ id: created.id, version: 3 }] });
  });

  it("protects manual renewal exclusion with a separate permission and strict contract", async () => {
    await login(); const adminToken = cookieMock.values.get(sessionCookieName)!; const adminCsrf = await csrfToken(); const references = await createReferences();
    const created = await (await subscriptionsPost(jsonRequest("/api/subscriptions", payload(references, todayDate()), { csrf: adminCsrf }))).json() as { id: string; version: number };
    await subscriptionActivate(jsonRequest(`/api/subscriptions/${created.id}/activate`, { version: created.version }, { csrf: adminCsrf }), { params: Promise.resolve({ subscriptionId: created.id }) });
    const path = `/api/subscriptions/${created.id}/renewal-exclusions`;
    const body = { expectedVersion: 2, periodStart: todayDate(), processDate: todayDate(), reason: "Pendiente de validacion comercial" };
    const routeContext = { params: Promise.resolve({ subscriptionId: created.id }) };
    expect((await renewalExclude(jsonRequest(path, body, { csrf: adminCsrf, origin: "https://evil.example" }), routeContext)).status).toBe(403);
    expect((await renewalExclude(jsonRequest(path, body), routeContext)).status).toBe(403);
    expect((await renewalExclude(jsonRequest(path, body, { csrf: adminCsrf, idempotency: null }), routeContext)).status).toBe(400);
    expect((await renewalExclude(jsonRequest(path, { ...body, unexpected: true }, { csrf: adminCsrf }), routeContext)).status).toBe(422);
    await createRenewalRunnerWithoutExclusions(); cookieMock.reset(); await login("renewal-runner", "Cambiar-runner-2026"); const runnerToken = cookieMock.values.get(sessionCookieName)!; const runnerCsrf = await csrfToken();
    expect((await renewalExclude(jsonRequest(path, body, { csrf: runnerCsrf }), routeContext)).status).toBe(403);
    cookieMock.values.set(sessionCookieName, adminToken); const restoredCsrf = await csrfToken();
    const excluded = await renewalExclude(jsonRequest(path, body, { csrf: restoredCsrf }), routeContext);
    expect(excluded.status).toBe(201); expect(await excluded.json()).toMatchObject({ subscriptionId: created.id, status: "RENEWAL_PENDING", version: 3 });
    const secondCreated = await (await subscriptionsPost(jsonRequest("/api/subscriptions", { ...payload(references, todayDate()), name: "Segundo pendiente" }, { csrf: restoredCsrf }))).json() as { id: string; version: number };
    await subscriptionActivate(jsonRequest(`/api/subscriptions/${secondCreated.id}/activate`, { version: secondCreated.version }, { csrf: restoredCsrf }), { params: Promise.resolve({ subscriptionId: secondCreated.id }) });
    const secondPath = `/api/subscriptions/${secondCreated.id}/renewal-exclusions`;
    const secondBody = { ...body, expectedVersion: 2 };
    expect((await renewalExclude(jsonRequest(secondPath, secondBody, { csrf: restoredCsrf }), { params: Promise.resolve({ subscriptionId: secondCreated.id }) })).status).toBe(201);
    const adminQueue = await renewalExclusionsGet(apiRequest("/api/subscriptions/renewal-exclusions?limit=1"));
    expect(adminQueue.status).toBe(200); expect(adminQueue.headers.get("Cache-Control")).toBe("private, no-store");
    const adminQueueBody = await adminQueue.json() as { exclusions: Array<{ id: string; reason: string; hasReason: boolean; work: { state: string } }>; nextCursor: string };
    expect(adminQueueBody).toMatchObject({ exclusions: [{ id: expect.any(String), reason: body.reason, hasReason: true, work: { state: "BLOCKED" } }], nextCursor: expect.any(String) });
    const adminSecondPage = await renewalExclusionsGet(apiRequest(`/api/subscriptions/renewal-exclusions?limit=1&cursor=${encodeURIComponent(adminQueueBody.nextCursor)}`));
    expect(adminSecondPage.status).toBe(200); const adminSecondPageBody = await adminSecondPage.json() as { exclusions: Array<{ id: string }>; nextCursor: null };
    expect(adminSecondPageBody.nextCursor).toBeNull(); expect(adminSecondPageBody.exclusions[0]!.id).not.toBe(adminQueueBody.exclusions[0]!.id);
    expect((await renewalExclusionsGet(apiRequest("/api/subscriptions/renewal-exclusions?unknown=true"))).status).toBe(422);
    expect((await renewalExclusionsGet(apiRequest("/api/subscriptions/renewal-exclusions?limit=1&limit=2"))).status).toBe(422);
    await createRenewalExclusionManagerWithoutRunner(); cookieMock.reset(); await login("renewal-exclusion-manager", "Cambiar-exclusion-manager-2026");
    expect((await renewalExclusionsGet(apiRequest("/api/subscriptions/renewal-exclusions"))).status).toBe(403);
    cookieMock.reset(); cookieMock.values.set(sessionCookieName, runnerToken);
    const restrictedQueue = await renewalExclusionsGet(apiRequest("/api/subscriptions/renewal-exclusions"));
    expect(restrictedQueue.status).toBe(200); const restrictedBody = await restrictedQueue.json() as { exclusions: Array<Record<string, unknown>> };
    expect(restrictedBody.exclusions[0]).toMatchObject({ hasReason: true }); expect(restrictedBody.exclusions[0]).not.toHaveProperty("reason");
  });

  it("protects and replays an administrative renewal waiver", async () => {
    await login(); const adminToken = cookieMock.values.get(sessionCookieName)!; const csrf = await csrfToken(); const references = await createReferences();
    await prisma.customer.update({ where: { id: references.customerId }, data: { legalName: "=HYPERLINK(\"https://example.test\")" } });
    const created = await (await subscriptionsPost(jsonRequest("/api/subscriptions", payload(references, todayDate()), { csrf }))).json() as { id: string; version: number };
    await subscriptionActivate(jsonRequest(`/api/subscriptions/${created.id}/activate`, { version: created.version }, { csrf }), { params: Promise.resolve({ subscriptionId: created.id }) });
    const exclusionBody = { expectedVersion: 2, periodStart: todayDate(), processDate: todayDate(), reason: "Pendiente de autorizacion administrativa" };
    const exclusionResponse = await renewalExclude(jsonRequest(`/api/subscriptions/${created.id}/renewal-exclusions`, exclusionBody, { csrf }), { params: Promise.resolve({ subscriptionId: created.id }) });
    const exclusion = await exclusionResponse.json() as { exclusionId: string; version: number };
    const path = `/api/subscriptions/${created.id}/renewal-exclusions/${exclusion.exclusionId}/waive`;
    const routeContext = { params: Promise.resolve({ subscriptionId: created.id, exclusionId: exclusion.exclusionId }) };
    const body = { expectedVersion: exclusion.version, reasonCode: "COMMERCIAL_WAIVER", reasonDetail: "Bonificacion excepcional autorizada" };
    expect((await renewalWaive(jsonRequest(path, body, { csrf, origin: "https://evil.example" }), routeContext)).status).toBe(403);
    expect((await renewalWaive(jsonRequest(path, body), routeContext)).status).toBe(403);
    expect((await renewalWaive(jsonRequest(path, body, { csrf, idempotency: null }), routeContext)).status).toBe(400);
    expect((await renewalWaive(jsonRequest(path, { ...body, unexpected: true }, { csrf }), routeContext)).status).toBe(422);
    await createRenewalRunnerWithoutExclusions(); cookieMock.reset(); await login("renewal-runner", "Cambiar-runner-2026"); const runnerCsrf = await csrfToken();
    expect((await renewalWaive(jsonRequest(path, body, { csrf: runnerCsrf }), routeContext)).status).toBe(403);
    cookieMock.values.set(sessionCookieName, adminToken); const restoredCsrf = await csrfToken(); const idempotency = randomUUID();
    const first = await renewalWaive(jsonRequest(path, body, { csrf: restoredCsrf, idempotency }), routeContext);
    expect(first.status).toBe(200); const firstBody = await first.json(); expect(firstBody).toMatchObject({ exclusionId: exclusion.exclusionId, subscriptionId: created.id, resolution: "WAIVED", status: "ACTIVE", version: 4 });
    const replay = await renewalWaive(jsonRequest(path, body, { csrf: restoredCsrf, idempotency }), routeContext);
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual(firstBody);
    const fiscalReviewId = (firstBody as { fiscalReview: { id: string } }).fiscalReview.id;
    const fiscalContext = { params: Promise.resolve({ reviewId: fiscalReviewId }) };
    expect((await renewalWaiverFiscalReviewStart(jsonRequest(`/api/subscriptions/renewal-waiver-fiscal-reviews/${fiscalReviewId}/start`, { expectedVersion: 1 }, { csrf: restoredCsrf }), fiscalContext)).status).toBe(409);
    await createRenewalWaiverFiscalReviewer(); cookieMock.reset(); await login("renewal-waiver-fiscal-reviewer", "Cambiar-fiscal-reviewer-2026"); const reviewerCsrf = await csrfToken();
    expect((await renewalWaiverFiscalReviewStart(jsonRequest(`/api/subscriptions/renewal-waiver-fiscal-reviews/${fiscalReviewId}/start`, { expectedVersion: 1 }, { csrf: reviewerCsrf, origin: "https://evil.example" }), fiscalContext)).status).toBe(403);
    expect((await renewalWaiverFiscalReviewStart(jsonRequest(`/api/subscriptions/renewal-waiver-fiscal-reviews/${fiscalReviewId}/start`, { expectedVersion: 1 }), fiscalContext)).status).toBe(403);
    const startedReview = await renewalWaiverFiscalReviewStart(jsonRequest(`/api/subscriptions/renewal-waiver-fiscal-reviews/${fiscalReviewId}/start`, { expectedVersion: 1 }, { csrf: reviewerCsrf }), fiscalContext);
    expect(startedReview.status).toBe(200); expect(await startedReview.json()).toMatchObject({ status: "IN_REVIEW", version: 2 });
    const completionUrl = `/api/subscriptions/renewal-waiver-fiscal-reviews/${fiscalReviewId}/complete`;
    const hostileCompletion = await renewalWaiverFiscalReviewComplete(jsonRequest(completionUrl, { expectedVersion: 3, detail: "Cierre contable acreditado" }, { csrf: reviewerCsrf, origin: "https://evil.example" }), fiscalContext);
    expect(hostileCompletion.status).toBe(403); expect(await hostileCompletion.json()).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    const csrfLessCompletion = await renewalWaiverFiscalReviewComplete(jsonRequest(completionUrl, { expectedVersion: 3, detail: "Cierre contable acreditado" }), fiscalContext);
    expect(csrfLessCompletion.status).toBe(403); expect(await csrfLessCompletion.json()).toMatchObject({ code: "CSRF_TOKEN_INVALID" });
    const unauthorizedCompletion = await renewalWaiverFiscalReviewComplete(jsonRequest(completionUrl, { expectedVersion: 3, detail: "Cierre contable acreditado" }, { csrf: reviewerCsrf }), fiscalContext);
    expect(unauthorizedCompletion.status).toBe(403); expect(await unauthorizedCompletion.json()).toMatchObject({ code: "FORBIDDEN" });
    expect((await renewalWaiverFiscalReviewDecide(jsonRequest(`/api/subscriptions/renewal-waiver-fiscal-reviews/${fiscalReviewId}/decide`, { expectedVersion: 2, decision: "EXTERNAL_ADVICE_REQUIRED", detail: "Consulta externa necesaria" }, { csrf: reviewerCsrf }), fiscalContext)).status).toBe(422);
    const decidedReview = await renewalWaiverFiscalReviewDecide(jsonRequest(`/api/subscriptions/renewal-waiver-fiscal-reviews/${fiscalReviewId}/decide`, { expectedVersion: 2, decision: "NO_ADDITIONAL_ACTION", detail: "Evidencia coherente sin actuaciones fiscales adicionales" }, { csrf: reviewerCsrf }), fiscalContext);
    expect(decidedReview.status).toBe(200); expect(await decidedReview.json()).toMatchObject({ status: "CLOSED", version: 3, decision: "NO_ADDITIONAL_ACTION" });
    cookieMock.values.set(sessionCookieName, adminToken);
    const history = await renewalWaiversGet(apiRequest("/api/subscriptions/renewal-waivers?limit=1"));
    expect(history.status).toBe(200); expect(history.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    const historyBody = await history.json() as { waivers: Array<Record<string, unknown>>; summary: { count: number; total: string } };
    expect(historyBody).toMatchObject({ waivers: [{ id: exclusion.exclusionId, reason: body.reasonDetail, hasReason: true,
      customer: { legalName: "=HYPERLINK(\"https://example.test\")", labelSource: "CAPTURED_AT_WAIVER" },
      valuation: { total: "24.20", taxBreakdown: [{ taxRateCode: "IVA_21", theoreticalTaxableBase: "20.00", theoreticalTaxAmount: "4.20", theoreticalTotal: "24.20" }] },
      fiscalReview: { id: fiscalReviewId, status: "CLOSED", decision: "NO_ADDITIONAL_ACTION" } }], summary: { count: 1, total: "24.20" } });
    expect((await renewalWaiversGet(apiRequest("/api/subscriptions/renewal-waivers?unknown=true"))).status).toBe(422);
    expect((await renewalWaiversGet(apiRequest("/api/subscriptions/renewal-waivers?limit=1&limit=2"))).status).toBe(422);
    await createRenewalWaiverViewer(); cookieMock.reset(); await login("renewal-waiver-viewer", "Cambiar-waiver-viewer-2026");
    const restrictedHistory = await renewalWaiversGet(apiRequest("/api/subscriptions/renewal-waivers"));
    expect(restrictedHistory.status).toBe(200); const restrictedHistoryBody = await restrictedHistory.json() as { waivers: Array<Record<string, unknown>> };
    expect(restrictedHistoryBody.waivers[0]).toMatchObject({ hasReason: true }); expect(restrictedHistoryBody.waivers[0]).not.toHaveProperty("reason"); expect(restrictedHistoryBody.waivers[0]).not.toHaveProperty("fiscalReview");
    const restrictedCsrf = await csrfToken();
    expect((await renewalWaiversExport(jsonRequest("/api/subscriptions/renewal-waivers/export", { waivedFrom: todayDate(), waivedTo: todayDate() }, { csrf: restrictedCsrf }))).status).toBe(403);
    cookieMock.values.set(sessionCookieName, adminToken); const exportCsrf = await csrfToken();
    await prisma.customer.update({ where: { id: references.customerId }, data: { legalName: "Nombre maestro posterior" } });
    const exportBody = { waivedFrom: todayDate(), waivedTo: todayDate() };
    expect((await renewalWaiversExport(jsonRequest("/api/subscriptions/renewal-waivers/export", {}, { csrf: exportCsrf }))).status).toBe(422);
    expect((await renewalWaiversExport(jsonRequest("/api/subscriptions/renewal-waivers/export", exportBody, { csrf: exportCsrf, origin: "https://evil.example" }))).status).toBe(403);
    expect((await renewalWaiversExport(jsonRequest("/api/subscriptions/renewal-waivers/export", exportBody))).status).toBe(403);
    const exported = await renewalWaiversExport(jsonRequest("/api/subscriptions/renewal-waivers/export", exportBody, { csrf: exportCsrf }));
    expect(exported.status).toBe(200); expect(exported.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(exported.headers.get("Content-Disposition")).toContain("condonaciones-renovacion-");
    const csvBytes = new Uint8Array(await exported.arrayBuffer());
    expect([...csvBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder("utf-8").decode(csvBytes);
    expect(csv).toContain("INFORME_INTERNO_NO_FISCAL");
    expect(csv).toContain("'=HYPERLINK"); expect(csv).not.toContain("Nombre maestro posterior");
    expect(csv).toContain("IVA_21 21.00%: base 20.00, IVA 4.20, total 24.20"); expect(csv).not.toContain(body.reasonDetail);
    const exportAudit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUBSCRIPTION_RENEWAL_WAIVERS_EXPORTED" } });
    expect(JSON.stringify(exportAudit.payload)).not.toContain(body.reasonDetail);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await renewalWaiversExport(jsonRequest("/api/subscriptions/renewal-waivers/export", exportBody, { csrf: exportCsrf }))).status).toBe(200);
    }
    const limited = await renewalWaiversExport(jsonRequest("/api/subscriptions/renewal-waivers/export", exportBody, { csrf: exportCsrf }));
    expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).toBe("900");
  });
});

function payload(references: { customerId: string; itemId: string }, startDate = "2026-09-01") { return { customerId: references.customerId, name: "Soporte mensual", periodicity: "MONTHLY", pricingMode: "FIXED", startDate, endDate: null, notes: null, lines: [{ catalogItemId: references.itemId, quantity: "1.000" }] }; }
function apiRequest(path: string) { return new Request(`http://localhost${path}`); }
function jsonRequest(path: string, body: unknown, options: { csrf?: string; idempotency?: string | null; origin?: string } = {}) { const headers = new Headers({ "Content-Type": "application/json", Origin: options.origin ?? "http://localhost:3000" }); if (options.csrf) headers.set("X-CSRF-Token", options.csrf); if (options.idempotency !== null) headers.set("Idempotency-Key", options.idempotency ?? randomUUID()); return new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) }); }
function putRequest(path: string, body: unknown, options: { csrf?: string; idempotency?: string | null; origin?: string } = {}) { const request = jsonRequest(path, body, options); return new Request(request, { method: "PUT" }); }
async function login(userName = "admin", loginPassword = password) { const response = await loginPost(jsonRequest("/api/auth/login", { userName, password: loginPassword })); expect(response.status).toBe(200); expect(cookieMock.values.has(sessionCookieName)).toBe(true); }
async function csrfToken() { const response = await csrfGet(apiRequest("/api/auth/csrf")); return ((await response.json()) as { csrfToken: string }).csrfToken; }
async function initialize() { const raw = JSON.stringify(initialization); const result = await initializePlatform(initialization, randomUUID(), hashRequestBody(raw)); if (!result.ok) throw new Error(result.error.code); }
async function createReferences() { const actor = await prisma.user.findFirstOrThrow(); const suffix = randomUUID().replaceAll("-", "").slice(0, 12); const customer = await prisma.customer.create({ data: { code: `C${suffix.slice(0, 8)}`, type: "COMPANY", legalName: "Cliente API SL", taxId: `VAT-${suffix}`, normalizedTaxId: `VAT${suffix}`, fiscalTreatment: "DOMESTIC", fiscalAddressLine: "Calle Test 1", fiscalPostalCode: "28001", fiscalCity: "Madrid", fiscalCountry: "ES", createdById: actor.id } }); const tax = await prisma.catalogTaxRate.findFirstOrThrow({ where: { code: "IVA_21" } }); const item = await prisma.catalogItem.create({ data: { code: `S${suffix.slice(0, 8)}`, kind: "SERVICE", name: `Servicio API ${suffix}`, salePrice: "20.00", taxRateId: tax.id, taxRate: tax.rate, createdById: actor.id } }); return { customerId: customer.id, itemId: item.id, actorId: actor.id }; }
async function createViewOnlyUser() { const role = await prisma.role.create({ data: { code: "SubscriptionViewer", name: "Consulta suscripciones", permissions: { create: { permission: { connect: { code: "Subscriptions.View" } } } } } }); await prisma.user.create({ data: { displayName: "Consulta", userName: "viewer", normalizedUserName: "viewer", passwordHash: hashPassword("Cambiar-viewer-2026"), roleId: role.id } }); }
async function createRenewalConfirmerWithoutBilling() { const role = await prisma.role.create({ data: { code: "RenewalConfirmer", name: "Confirma renovaciones", permissions: { create: { permission: { connect: { code: "Subscriptions.ConfirmRenewals" } } } } } }); await prisma.user.create({ data: { displayName: "Confirmador", userName: "renewal-confirmer", normalizedUserName: "renewal-confirmer", passwordHash: hashPassword("Cambiar-confirmer-2026"), roleId: role.id } }); }
async function createRenewalRunnerWithoutExclusions() { const role = await prisma.role.create({ data: { code: "RenewalRunner", name: "Ejecuta renovaciones", permissions: { create: { permission: { connect: { code: "Subscriptions.RunRenewals" } } } } } }); await prisma.user.create({ data: { displayName: "Operador", userName: "renewal-runner", normalizedUserName: "renewal-runner", passwordHash: hashPassword("Cambiar-runner-2026"), roleId: role.id } }); }
async function createRenewalExclusionManagerWithoutRunner() { const role = await prisma.role.create({ data: { code: "RenewalExclusionManager", name: "Gestiona exclusiones", permissions: { create: { permission: { connect: { code: "Subscriptions.ManageRenewalExclusions" } } } } } }); await prisma.user.create({ data: { displayName: "Gestor de exclusiones", userName: "renewal-exclusion-manager", normalizedUserName: "renewal-exclusion-manager", passwordHash: hashPassword("Cambiar-exclusion-manager-2026"), roleId: role.id } }); }
async function createRenewalWaiverViewer() { const role = await prisma.role.create({ data: { code: "RenewalWaiverViewer", name: "Consulta condonaciones", permissions: { create: { permission: { connect: { code: "Subscriptions.ViewRenewalWaivers" } } } } } }); await prisma.user.create({ data: { displayName: "Consulta condonaciones", userName: "renewal-waiver-viewer", normalizedUserName: "renewal-waiver-viewer", passwordHash: hashPassword("Cambiar-waiver-viewer-2026"), roleId: role.id } }); }
async function createRenewalWaiverFiscalReviewer() { const role = await prisma.role.create({ data: { code: "RenewalWaiverFiscalReviewer", name: "Revision fiscal de condonaciones", permissions: { create: ["Subscriptions.ViewRenewalWaivers", "Subscriptions.ViewRenewalWaiverFiscalReviews", "Subscriptions.DecideRenewalWaiverFiscalReviews"].map((code) => ({ permission: { connect: { code } } })) } } }); await prisma.user.create({ data: { displayName: "Revisor fiscal", userName: "renewal-waiver-fiscal-reviewer", normalizedUserName: "renewal-waiver-fiscal-reviewer", passwordHash: hashPassword("Cambiar-fiscal-reviewer-2026"), roleId: role.id } }); }
async function seedRenewalAccounting(companyId: string, actorId: string, customerCode: string) { const fiscalYear = await prisma.accountingFiscalYear.create({ data: { companyId, year: 2026, startDate: new Date("2026-01-01T00:00:00.000Z"), endDate: new Date("2026-12-31T00:00:00.000Z"), planCode: "PGC_PYMES", planVersion: "2021.1", createdById: actorId } }); await prisma.accountingAccount.createMany({ data: [
  { fiscalYearId: fiscalYear.id, code: `430${customerCode.padStart(6, "0")}`, name: "Cliente renovacion", type: "ASSET", level: 4, isPostable: true, createdById: actorId },
  { fiscalYearId: fiscalYear.id, code: "705000000", name: "Servicios", type: "INCOME", level: 4, isPostable: true, createdById: actorId },
  { fiscalYearId: fiscalYear.id, code: "477000000", name: "IVA repercutido", type: "LIABILITY", level: 4, isPostable: true, createdById: actorId }
] }); }
async function reset() { await prisma.$executeRawUnsafe('TRUNCATE TABLE "companies", "roles", "permissions", "reserved_user_names", "idempotency_records" RESTART IDENTITY CASCADE'); }
function futureDate() { return new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); }
function todayDate() { const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); const value = Object.fromEntries(parts.map((part) => [part.type, part.value])); return `${value.year}-${value.month}-${value.day}`; }
