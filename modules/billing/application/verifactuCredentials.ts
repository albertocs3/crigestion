import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";
import { isStagingProductionCapabilityForbidden } from "@/modules/platform/application/stagingEnvironment";
import type { VerifactuCredentialProbe, VerifactuCredentialProbeResult } from "../infrastructure/verifactu/credentialProbe";
import { loadStagedVerifactuCredential, stageVerifactuCredentialVersion } from "../infrastructure/verifactu/credentialStore";
import type { SecureEnvelopeCipher } from "../infrastructure/verifactu/secureEnvelope";

export const stageVerifactuCredentialSchema = z.object({
  sifInstallationId: z.string().uuid(),
  alias: z.string().trim().min(1).max(120),
  passphrase: z.string().max(4096),
  endpointKind: z.enum(["STANDARD", "SEAL"]),
  allowTest: z.boolean().default(true),
  allowProduction: z.boolean().default(false)
}).strict().refine((value) => value.allowTest, { message: "La credencial debe autorizar TEST antes de activarse." });

export type StageVerifactuCredentialCommand = z.infer<typeof stageVerifactuCredentialSchema> & { pfx: Buffer };

export const activateVerifactuCredentialSchema = z.object({
  sifInstallationId: z.string().uuid(),
  fiscalRecordId: z.string().uuid(),
  targetProductionSifInstallationId: z.string().uuid().optional()
}).strict();

export type VerifactuCredentialCycleDependencies = {
  credentialCipher: SecureEnvelopeCipher;
  probe: VerifactuCredentialProbe;
  now?: () => Date;
};

type OperationContext = { correlationId?: string; idempotencyKey: string; requestHash: string };

export type VerifactuCredentialManagement = {
  companyId: string;
  installations: Array<{
    id: string; installationCode: string; environment: "TEST" | "PRODUCTION"; status: string;
    credential: null | { alias: string; status: string };
    fiscalRecords: Array<{ id: string; invoiceNumber: string; issueDate: string; issuerName: string }>;
  }>;
  credentials: Array<{
    alias: string; status: string;
    assignments: Array<{ id: string; installationCode: string; environment: "TEST" | "PRODUCTION" }>;
    versions: Array<{
      id: string; version: number; status: string; endpointKind: "STANDARD" | "SEAL";
      allowProduction: boolean; validFrom: string; validUntil: string; testedAt: string | null;
      activatedAt: string | null; retiredAt: string | null;
      latestTest: null | { outcome: string; stableCode: string | null; startedAt: string; completedAt: string | null };
    }>;
  }>;
};

export async function getVerifactuCredentialManagement(): Promise<VerifactuCredentialManagement | null> {
  const installation = await prisma.installation.findUnique({ where: { singletonKey: 1 }, select: { companyId: true } });
  if (!installation?.companyId) return null;
  const [sifInstallations, credentials] = await Promise.all([
    prisma.verifactuSifInstallation.findMany({
      where: { companyId: installation.companyId }, orderBy: [{ environment: "asc" }, { installationCode: "asc" }],
      select: {
        id: true, installationCode: true, environment: true, status: true,
        credential: { select: { alias: true, status: true } },
        fiscalRecords: { orderBy: { createdAt: "desc" }, take: 20, select: { id: true, invoiceNumber: true, invoiceIssueDate: true, issuerName: true } }
      }
    }),
    prisma.verifactuMtlsCredential.findMany({
      where: { companyId: installation.companyId }, orderBy: { createdAt: "desc" },
      select: {
        alias: true, status: true,
        sifInstallations: { orderBy: [{ environment: "asc" }, { installationCode: "asc" }], select: { id: true, installationCode: true, environment: true } },
        versions: { orderBy: { version: "desc" }, select: {
          id: true, version: true, status: true, endpointKind: true, allowProduction: true,
          validFrom: true, validUntil: true, testedAt: true, activatedAt: true, retiredAt: true,
          testAttempts: { orderBy: { startedAt: "desc" }, take: 1, select: { outcome: true, stableCode: true, startedAt: true, completedAt: true } }
        } }
      }
    })
  ]);
  return {
    companyId: installation.companyId,
    installations: sifInstallations.map((sif) => ({
      id: sif.id, installationCode: sif.installationCode, environment: sif.environment, status: sif.status,
      credential: sif.credential,
      fiscalRecords: sif.environment === "TEST" ? sif.fiscalRecords.map((record) => ({
        id: record.id, invoiceNumber: record.invoiceNumber, issueDate: record.invoiceIssueDate.toISOString(), issuerName: record.issuerName
      })) : []
    })),
    credentials: credentials.map((credential) => ({
      alias: credential.alias, status: credential.status,
      assignments: credential.sifInstallations,
      versions: credential.versions.map((version) => ({
          id: version.id, version: version.version, status: version.status, endpointKind: version.endpointKind,
          allowProduction: version.allowProduction, validFrom: version.validFrom.toISOString(), validUntil: version.validUntil.toISOString(),
          testedAt: version.testedAt?.toISOString() ?? null, activatedAt: version.activatedAt?.toISOString() ?? null,
          retiredAt: version.retiredAt?.toISOString() ?? null,
          latestTest: version.testAttempts[0] ? {
            outcome: version.testAttempts[0].outcome, stableCode: version.testAttempts[0].stableCode,
            startedAt: version.testAttempts[0].startedAt.toISOString(), completedAt: version.testAttempts[0].completedAt?.toISOString() ?? null
          } : null
        }))
    }))
  };
}

export async function stageVerifactuCredential(
  command: StageVerifactuCredentialCommand,
  actor: SessionUser,
  context: OperationContext,
  dependencies: VerifactuCredentialCycleDependencies
): Promise<{ ok: true; status: 201 | 200; value: { credentialRef: string; versionId: string; version: number; status: "STAGED"; validFrom: string; validUntil: string } } | CredentialCycleFailure> {
  const pfx = command.pfx;
  if (pfx.byteLength < 1 || pfx.byteLength > 512 * 1024) {
    pfx.fill(0);
    return failure(422, "VERIFACTU_CREDENTIAL_MATERIAL_INVALID", "El certificado PFX no es valido.");
  }
  if (isStagingProductionCapabilityForbidden() && command.allowProduction) {
    pfx.fill(0);
    return failure(409, "VERIFACTU_PRODUCTION_FORBIDDEN_IN_STAGING", "Staging solo admite credenciales AEAT TEST.");
  }
  try {
    if (isStagingProductionCapabilityForbidden()) {
      const stagingInstallation = await prisma.verifactuSifInstallation.findFirst({
        where: { id: command.sifInstallationId, environment: "TEST", status: "ACTIVE" },
        select: { id: true }
      });
      if (!stagingInstallation) {
        return failure(409, "VERIFACTU_PRODUCTION_FORBIDDEN_IN_STAGING", "Staging solo admite instalaciones SIF TEST activas.");
      }
    }
    const existingIdempotency = await prisma.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey }, select: { requestHash: true } });
    if (existingIdempotency && existingIdempotency.requestHash !== context.requestHash) {
      return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
    }
    const result = await stageVerifactuCredentialVersion({
      sifInstallationId: command.sifInstallationId, alias: command.alias, pfx, passphrase: command.passphrase,
      endpointKind: command.endpointKind, allowTest: command.allowTest, allowProduction: command.allowProduction,
      actorUserId: actor.id, correlationId: context.correlationId, idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash, cipher: dependencies.credentialCipher
    });
    return { ok: true, status: result.replayed ? 200 : 201, value: {
      credentialRef: result.credentialRef, versionId: result.versionId, version: result.version, status: "STAGED",
      validFrom: result.validFrom.toISOString(), validUntil: result.validUntil.toISOString()
    } };
  } catch (error) {
    if (hasCode(error, "VERIFACTU_IDEMPOTENCY_KEY_REUSED")) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
    if (hasCode(error, "VERIFACTU_SIF_INSTALLATION_NOT_FOUND")) return failure(404, "VERIFACTU_SIF_INSTALLATION_NOT_FOUND", "La instalacion VeriFactu no existe.");
    if (hasCode(error, "VERIFACTU_CREDENTIAL_UNAVAILABLE")) return failure(409, "VERIFACTU_CREDENTIAL_UNAVAILABLE", "La credencial asociada no admite nuevas versiones.");
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return failure(409, "VERIFACTU_CREDENTIAL_STAGE_CONFLICT", "La credencial cambio durante la importacion; reintente la operacion.");
    if (hasCode(error, "VERIFACTU_CREDENTIAL_MATERIAL_INVALID") || hasCode(error, "VERIFACTU_CREDENTIAL_METADATA_INVALID")) {
      return failure(422, "VERIFACTU_CREDENTIAL_MATERIAL_INVALID", "El certificado PFX o sus metadatos no son validos.");
    }
    throw error;
  } finally { pfx.fill(0); }
}

export async function testAndActivateVerifactuCredential(
  versionId: string,
  command: z.infer<typeof activateVerifactuCredentialSchema>,
  actor: SessionUser,
  context: OperationContext,
  dependencies: VerifactuCredentialCycleDependencies
): Promise<{ ok: true; status: 200; value: { credentialRef: string; versionId: string; version: number; status: "ACTIVE"; testedAt: string; retiredVersionId: string | null } } | CredentialCycleFailure> {
  if (isStagingProductionCapabilityForbidden() && command.targetProductionSifInstallationId) {
    return failure(409, "VERIFACTU_PRODUCTION_FORBIDDEN_IN_STAGING", "Staging no puede asociar credenciales a instalaciones productivas.");
  }
  const target = await findActivationTarget(versionId, command);
  if (!target) return failure(404, "VERIFACTU_CREDENTIAL_VERSION_NOT_FOUND", "La version de credencial no existe.");
  const replayRecord = await prisma.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  if (replayRecord) {
    if (replayRecord.requestHash !== context.requestHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
    const response = activationResponseSchema.parse(replayRecord.responseBody);
    return { ok: true, status: 200, value: response };
  }
  const existingAttempt = await prisma.verifactuMtlsCredentialTestAttempt.findUnique({ where: { idempotencyKey: context.idempotencyKey } });
  if (existingAttempt && existingAttempt.requestHash !== context.requestHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
  if (target.status === "ACTIVE" && existingAttempt?.outcome === "PASSED") return activeResponse(target, existingAttempt.completedAt ?? existingAttempt.startedAt, null);
  if (target.status !== "STAGED") return failure(409, "VERIFACTU_CREDENTIAL_VERSION_NOT_STAGED", "La version no esta preparada para prueba y activacion.");
  if (target.validFrom > (dependencies.now?.() ?? new Date()) || target.validUntil <= (dependencies.now?.() ?? new Date())) {
    return failure(409, "VERIFACTU_CREDENTIAL_OUTSIDE_VALIDITY", "El certificado no esta vigente.");
  }
  if (target.sifInstallation.environment !== "TEST" || target.sifInstallation.status !== "ACTIVE") {
    return failure(409, "VERIFACTU_TEST_INSTALLATION_REQUIRED", "La activacion requiere una instalacion VeriFactu TEST activa.");
  }
  if (existingAttempt?.outcome === "RUNNING") {
    if (existingAttempt.startedAt > new Date(startedNow(dependencies).getTime() - 5 * 60_000)) return failure(409, "VERIFACTU_CREDENTIAL_TEST_IN_PROGRESS", "Ya hay una prueba en curso para esta version.");
    await expireRunningAttempt(existingAttempt.id, startedNow(dependencies), target, actor.id, context.correlationId);
    return probeFailure("UNKNOWN", "VERIFACTU_CREDENTIAL_TEST_EXPIRED");
  }
  if (existingAttempt) return probeFailure(existingAttempt.outcome, existingAttempt.stableCode ?? "VERIFACTU_AEAT_TEST_FAILED");

  const recoveryTime = startedNow(dependencies);
  await expireStaleAttempts(versionId, recoveryTime, target, actor.id, context.correlationId);
  const startedAt = recoveryTime;
  const attemptId = randomUUID();
  try {
    await prisma.$transaction([
      prisma.verifactuMtlsCredentialTestAttempt.create({ data: {
        id: attemptId, versionId, idempotencyKey: context.idempotencyKey, requestHash: context.requestHash,
        outcome: "RUNNING", pfxSha256: target.pfxSha256, startedAt, actorUserId: actor.id, correlationId: context.correlationId
      } }),
      prisma.auditEvent.create({ data: { eventType: "VERIFACTU_MTLS_TEST_STARTED", actorType: "USER", payload: safeAuditPayload(target, actor.id, context.correlationId, attemptId) } })
    ]);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return failure(409, "VERIFACTU_CREDENTIAL_TEST_IN_PROGRESS", "Ya hay una prueba en curso para esta version.");
    }
    throw error;
  }

  let probeResult: VerifactuCredentialProbeResult;
  let staged: Awaited<ReturnType<typeof loadStagedVerifactuCredential>> = null;
  try {
    staged = await loadStagedVerifactuCredential({ versionId, companyId: target.companyId, cipher: dependencies.credentialCipher });
    if (!staged) {
      probeResult = { outcome: "FAILED", stableCode: "VERIFACTU_CREDENTIAL_VERSION_CHANGED" };
    } else {
      probeResult = await dependencies.probe({ credential: staged, fiscalKey: target.fiscalKey });
    }
  } catch {
    probeResult = { outcome: "UNKNOWN", stableCode: "VERIFACTU_AEAT_TEST_UNEXPECTED_FAILURE" };
  } finally { staged?.release(); }
  const completedAt = dependencies.now?.() ?? new Date();
  if (probeResult.outcome !== "PASSED") {
    await completeFailedAttempt(attemptId, probeResult, completedAt, target, actor.id, context.correlationId);
    return probeFailure(probeResult.outcome, probeResult.stableCode);
  }

  try {
    const activated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "verifactu_mtls_credentials" WHERE "id" = ${target.credentialId}::uuid FOR UPDATE`;
      const current = await tx.verifactuMtlsCredentialVersion.findUnique({ where: { id: versionId }, select: { status: true, pfxSha256: true } });
      if (!current || current.status !== "STAGED" || current.pfxSha256 !== target.pfxSha256) throw new Error("VERIFACTU_CREDENTIAL_VERSION_CHANGED");
      const activeBeforeRotation = await tx.verifactuMtlsCredentialVersion.findFirst({ where: { credentialId: target.credentialId, status: "ACTIVE" }, select: { id: true } });
      if ((activeBeforeRotation?.id ?? null) !== target.expectedActiveVersionId) throw new Error("VERIFACTU_CREDENTIAL_ACTIVATION_CONFLICT");
      await tx.verifactuMtlsCredentialTestAttempt.update({ where: { id: attemptId }, data: {
        outcome: "PASSED", completedAt, stableCode: probeResult.stableCode, responseSha256: probeResult.responseSha256
      } });
      await tx.verifactuMtlsCredentialVersion.update({ where: { id: versionId }, data: {
        status: "TESTED", testedAt: completedAt, testedPfxSha256: target.pfxSha256, testedAttemptId: attemptId
      } });
      const previous = activeBeforeRotation;
      if (previous) await tx.verifactuMtlsCredentialVersion.update({ where: { id: previous.id }, data: { status: "RETIRED", retiredAt: completedAt } });
      await tx.verifactuMtlsCredentialVersion.update({ where: { id: versionId }, data: { status: "ACTIVE", activatedAt: completedAt } });
      await tx.verifactuSifInstallation.update({ where: { id: command.sifInstallationId }, data: { credentialRef: target.credentialRef } });
      if (target.productionInstallation) await tx.verifactuSifInstallation.update({ where: { id: target.productionInstallation.id }, data: { credentialRef: target.credentialRef } });
      if (previous) await tx.auditEvent.create({ data: { eventType: "VERIFACTU_MTLS_VERSION_RETIRED", actorType: "USER", payload: { ...safeAuditPayload(target, actor.id, context.correlationId, attemptId), retiredVersionId: previous.id } } });
      await tx.auditEvent.create({ data: { eventType: "VERIFACTU_MTLS_VERSION_ACTIVATED", actorType: "USER", payload: safeAuditPayload(target, actor.id, context.correlationId, attemptId) } });
      const response = activeResponseValue(target, completedAt, previous?.id ?? null);
      await tx.idempotencyRecord.create({ data: { key: context.idempotencyKey, requestHash: context.requestHash, responseStatus: 200, responseBody: response } });
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { ok: true, status: 200, value: activated };
  } catch (error) {
    await completeFailedAttempt(attemptId, { outcome: "UNKNOWN", stableCode: "VERIFACTU_CREDENTIAL_ACTIVATION_CONFLICT", responseSha256: probeResult.responseSha256 }, completedAt, target, actor.id, context.correlationId).catch(() => undefined);
    if (hasCode(error, "VERIFACTU_CREDENTIAL_VERSION_CHANGED") || error instanceof Prisma.PrismaClientKnownRequestError) {
      return failure(409, "VERIFACTU_CREDENTIAL_ACTIVATION_CONFLICT", "La version cambio durante la activacion.");
    }
    throw error;
  }
}

async function findActivationTarget(versionId: string, command: z.infer<typeof activateVerifactuCredentialSchema>) {
  return prisma.verifactuMtlsCredentialVersion.findFirst({
    where: { id: versionId },
    select: {
      id: true, version: true, status: true, allowProduction: true, validFrom: true, validUntil: true, pfxSha256: true, credentialId: true,
      credential: { select: { ref: true, companyId: true, status: true, versions: { where: { status: "ACTIVE" }, take: 1, select: { id: true } } } }
    }
  }).then(async (version) => {
    if (!version) return null;
    const singleton = await prisma.installation.findUnique({ where: { singletonKey: 1 }, select: { companyId: true } });
    if (!singleton?.companyId || singleton.companyId !== version.credential.companyId || version.credential.status !== "ACTIVE") return null;
    const installation = await prisma.verifactuSifInstallation.findFirst({ where: { id: command.sifInstallationId, companyId: singleton.companyId }, select: { id: true, environment: true, status: true, companyId: true } });
    if (!installation) return null;
    const productionInstallation = command.targetProductionSifInstallationId
      ? await prisma.verifactuSifInstallation.findFirst({ where: { id: command.targetProductionSifInstallationId, companyId: singleton.companyId, environment: "PRODUCTION", status: "ACTIVE" }, select: { id: true } })
      : null;
    if (command.targetProductionSifInstallationId && (!version.allowProduction || !productionInstallation)) return null;
    const record = await prisma.verifactuFiscalRecord.findFirst({ where: { id: command.fiscalRecordId, companyId: installation.companyId, sifInstallationId: installation.id }, select: { issuerName: true, issuerTaxId: true, invoiceNumber: true, invoiceIssueDate: true } });
    if (!record) return null;
    return { ...version, expectedActiveVersionId: version.credential.versions[0]?.id ?? null, companyId: version.credential.companyId, credentialRef: version.credential.ref, sifInstallation: installation, productionInstallation, fiscalKey: { issuerName: record.issuerName, issuerTaxId: record.issuerTaxId, invoiceNumber: record.invoiceNumber, issueDate: formatAeatDate(record.invoiceIssueDate) } };
  });
}

type ActivationTarget = NonNullable<Awaited<ReturnType<typeof findActivationTarget>>>;
type CredentialCycleFailure = { ok: false; status: 404 | 409 | 422 | 502 | 503; error: { code: string; message: string } };
function failure(status: CredentialCycleFailure["status"], code: string, message: string): CredentialCycleFailure { return { ok: false, status, error: { code, message } }; }
function probeFailure(outcome: string, stableCode: string): CredentialCycleFailure { return failure(outcome === "UNKNOWN" ? 503 : 502, stableCode, outcome === "UNKNOWN" ? "No se pudo determinar el resultado de la prueba AEAT." : "La credencial no supero la prueba AEAT TEST."); }
function hasCode(error: unknown, code: string): boolean { return error instanceof Error && error.message === code; }
function startedNow(dependencies: VerifactuCredentialCycleDependencies): Date { return dependencies.now?.() ?? new Date(); }
function formatAeatDate(value: Date): string { return `${String(value.getUTCDate()).padStart(2, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${value.getUTCFullYear()}`; }
function safeAuditPayload(target: ActivationTarget, actorUserId: string, correlationId: string | undefined, attemptId: string) { return { actorUserId, companyId: target.companyId, sifInstallationId: target.sifInstallation.id, ...(target.productionInstallation ? { targetProductionSifInstallationId: target.productionInstallation.id } : {}), mtlsRefId: target.credentialRef, mtlsVersionId: target.id, version: target.version, testAttemptId: attemptId, environment: "TEST", ...(correlationId ? { correlationId } : {}) }; }
function activeResponse(target: ActivationTarget, testedAt: Date, retiredVersionId: string | null) { return { ok: true as const, status: 200 as const, value: activeResponseValue(target, testedAt, retiredVersionId) }; }
function activeResponseValue(target: ActivationTarget, testedAt: Date, retiredVersionId: string | null) { return { credentialRef: target.credentialRef, versionId: target.id, version: target.version, status: "ACTIVE" as const, testedAt: testedAt.toISOString(), retiredVersionId }; }
async function completeFailedAttempt(attemptId: string, result: VerifactuCredentialProbeResult, completedAt: Date, target: ActivationTarget, actorUserId: string, correlationId?: string): Promise<void> {
  await prisma.$transaction([
    prisma.verifactuMtlsCredentialTestAttempt.update({ where: { id: attemptId }, data: { outcome: result.outcome, completedAt, stableCode: result.stableCode, responseSha256: result.responseSha256 } }),
    prisma.auditEvent.create({ data: { eventType: result.outcome === "FAILED" ? "VERIFACTU_MTLS_TEST_FAILED" : "VERIFACTU_MTLS_TEST_UNKNOWN", actorType: "USER", payload: { ...safeAuditPayload(target, actorUserId, correlationId, attemptId), stableCode: result.stableCode } } })
  ]);
}
async function expireStaleAttempts(versionId: string, now: Date, target: ActivationTarget, actorUserId: string, correlationId?: string): Promise<void> {
  const stale = await prisma.verifactuMtlsCredentialTestAttempt.findMany({ where: { versionId, outcome: "RUNNING", startedAt: { lte: new Date(now.getTime() - 5 * 60_000) } }, select: { id: true } });
  for (const attempt of stale) await expireRunningAttempt(attempt.id, now, target, actorUserId, correlationId);
}
async function expireRunningAttempt(attemptId: string, now: Date, target: ActivationTarget, actorUserId: string, correlationId?: string): Promise<void> {
  await completeFailedAttempt(attemptId, { outcome: "UNKNOWN", stableCode: "VERIFACTU_CREDENTIAL_TEST_EXPIRED" }, now, target, actorUserId, correlationId).catch(() => undefined);
}
const activationResponseSchema = z.object({ credentialRef: z.string(), versionId: z.string().uuid(), version: z.number().int().positive(), status: z.literal("ACTIVE"), testedAt: z.string().datetime(), retiredVersionId: z.string().uuid().nullable() }).strict();
