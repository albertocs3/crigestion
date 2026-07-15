import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";
import { productVersion } from "@/modules/platform/application/version";
import {
  supportedVerifactuManifestSha256,
  supportedVerifactuManifestVersion
} from "../infrastructure/verifactu/aeatF1Preparer";

const xmlText = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(value), "El texto contiene caracteres no validos para XML.");

const normalizedUppercase = (max: number) => z.string().trim().min(1).max(max).transform((value) => value.toUpperCase());

export const createVerifactuSifInstallationSchema = z.object({
  installationCode: normalizedUppercase(80).pipe(z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,79}$/, "Usa letras, numeros, punto, guion o guion bajo.")),
  producerTaxId: normalizedUppercase(32).transform((value) => value.replace(/[\s-]/g, "")).pipe(z.string().regex(/^[A-Z0-9]{9}$/, "El NIF del productor debe tener 9 caracteres alfanumericos.")),
  producerName: xmlText(120),
  systemName: xmlText(30),
  systemId: normalizedUppercase(2).pipe(z.string().regex(/^[A-Z0-9]{2}$/, "El identificador del sistema debe tener 2 caracteres alfanumericos.")),
  systemVersion: xmlText(40),
  installationNumber: xmlText(100)
}).strict();

export type CreateVerifactuSifInstallationCommand = z.infer<typeof createVerifactuSifInstallationSchema>;

const responseSchema = z.object({
  id: z.string().uuid(),
  installationCode: z.string(),
  environment: z.literal("TEST"),
  status: z.literal("ACTIVE"),
  contractVersion: z.literal("VF_V1"),
  schemaVersion: z.literal("tikeV1.0"),
  artifactManifestVersion: z.string(),
  activatedAt: z.string().datetime()
}).strict();

export type VerifactuSifInstallationManagement = Awaited<ReturnType<typeof getVerifactuSifInstallationManagement>>;
export type CreateVerifactuSifInstallationResult =
  | { ok: true; status: 200 | 201; value: z.infer<typeof responseSchema> }
  | { ok: false; status: 404 | 409; error: { code: string; message: string } };

export async function getVerifactuSifInstallationManagement() {
  const installation = await prisma.installation.findUnique({
    where: { singletonKey: 1 },
    select: { company: { select: { legalName: true, taxId: true } }, companyId: true }
  });
  if (!installation?.companyId || !installation.company) return null;
  const installations = await prisma.verifactuSifInstallation.findMany({
    where: { companyId: installation.companyId },
    orderBy: [{ environment: "asc" }, { installationCode: "asc" }],
    select: {
      id: true, installationCode: true, environment: true, status: true, contractVersion: true,
      schemaVersion: true, artifactManifestVersion: true, producerName: true, producerTaxId: true,
      systemName: true, systemId: true, systemVersion: true, installationNumber: true, activatedAt: true,
      credential: { select: { alias: true } }
    }
  });
  return {
    company: installation.company,
    suggestedSystemVersion: productVersion,
    installations: installations.map(({ credential, ...item }) => ({
      ...item,
      activatedAt: item.activatedAt.toISOString(),
      credentialAlias: credential?.alias ?? null
    }))
  };
}

export async function createVerifactuSifInstallation(
  command: CreateVerifactuSifInstallationCommand,
  actor: Pick<SessionUser, "id">,
  context: { idempotencyKey: string; requestHash: string; correlationId?: string; now?: Date }
): Promise<CreateVerifactuSifInstallationResult> {
  const replay = await prisma.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  if (replay) return replayResponse(replay.requestHash, replay.responseBody, context.requestHash);
  const singleton = await prisma.installation.findUnique({ where: { singletonKey: 1 }, select: { companyId: true } });
  if (!singleton?.companyId) return failure(404, "VERIFACTU_COMPANY_NOT_AVAILABLE", "No hay una empresa configurada.");
  const companyId = singleton.companyId;
  const now = context.now ?? new Date();
  try {
    const value = await prisma.$transaction(async (tx) => {
      const existingActive = await tx.verifactuSifInstallation.findFirst({
        where: { companyId, environment: "TEST", status: "ACTIVE" },
        select: { id: true }
      });
      if (existingActive) throw new Error("VERIFACTU_TEST_INSTALLATION_ALREADY_ACTIVE");
      const existingCode = await tx.verifactuSifInstallation.findUnique({
        where: { companyId_installationCode_environment: { companyId, installationCode: command.installationCode, environment: "TEST" } },
        select: { id: true }
      });
      if (existingCode) throw new Error("VERIFACTU_SIF_INSTALLATION_CODE_EXISTS");
      const created = await tx.verifactuSifInstallation.create({
        data: {
          companyId,
          installationCode: command.installationCode,
          environment: "TEST",
          status: "ACTIVE",
          contractVersion: "VF_V1",
          schemaVersion: "tikeV1.0",
          artifactManifestVersion: supportedVerifactuManifestVersion,
          artifactManifestSha256: supportedVerifactuManifestSha256,
          producerTaxId: command.producerTaxId,
          producerName: command.producerName,
          systemName: command.systemName,
          systemId: command.systemId,
          systemVersion: command.systemVersion,
          installationNumber: command.installationNumber,
          activatedAt: now
        },
        select: { id: true, installationCode: true, environment: true, status: true, contractVersion: true, schemaVersion: true, artifactManifestVersion: true, activatedAt: true }
      });
      const response = responseSchema.parse({ ...created, activatedAt: created.activatedAt.toISOString() });
      await tx.auditEvent.create({ data: {
        eventType: "VERIFACTU_SIF_INSTALLATION_CREATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id, companyId, sifInstallationId: created.id, environment: "TEST",
          contractVersion: created.contractVersion, schemaVersion: created.schemaVersion,
          artifactManifestVersion: created.artifactManifestVersion,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      } });
      await tx.idempotencyRecord.create({ data: { key: context.idempotencyKey, requestHash: context.requestHash, responseStatus: 201, responseBody: response } });
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { ok: true, status: 201, value };
  } catch (error) {
    if (error instanceof Error && error.message === "VERIFACTU_TEST_INSTALLATION_ALREADY_ACTIVE") return failure(409, error.message, "Ya existe una instalacion SIF TEST activa.");
    if (error instanceof Error && error.message === "VERIFACTU_SIF_INSTALLATION_CODE_EXISTS") return failure(409, error.message, "El codigo de instalacion TEST ya existe.");
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) {
      const concurrentReplay = await prisma.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
      if (concurrentReplay) return replayResponse(concurrentReplay.requestHash, concurrentReplay.responseBody, context.requestHash);
      return failure(409, error.code === "P2002" ? "VERIFACTU_TEST_INSTALLATION_ALREADY_ACTIVE" : "VERIFACTU_SIF_INSTALLATION_CONFLICT", "La instalacion SIF cambio durante el alta. Recarga la pagina.");
    }
    throw error;
  }
}

export function hashVerifactuSifInstallationBody(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function replayResponse(storedHash: string, body: Prisma.JsonValue, requestHash: string): CreateVerifactuSifInstallationResult {
  if (storedHash !== requestHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
  return { ok: true, status: 200, value: responseSchema.parse(body) };
}

function failure(status: 404 | 409, code: string, message: string) {
  return { ok: false as const, status, error: { code, message } };
}
