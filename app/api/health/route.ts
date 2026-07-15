import { prisma } from "@/lib/prisma";
import { jsonResponse } from "@/modules/platform/application/http";
import { readPlatformEnvironment } from "@/modules/platform/application/environment";
import { classifyWorkerHealth, isVerifactuEnvironmentCoherent, readOperationalEnvironment } from "@/modules/platform/application/operationalEnvironment";
import { assertStagingRuntimeEnvironment } from "@/modules/platform/application/stagingEnvironment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type HealthState = "ok" | "degraded" | "unavailable";

export async function GET(request: Request) {
  const timestamp = new Date().toISOString();
  try {
    readPlatformEnvironment(process.env);
    const [database] = await prisma.$queryRaw<Array<{
      databaseName: string;
      databaseRole: string;
      serverAddress: string | null;
      serverPort: number | null;
    }>>`SELECT current_database() AS "databaseName", current_user AS "databaseRole",
      inet_server_addr()::text AS "serverAddress", inet_server_port() AS "serverPort"`;
    if (process.env.APP_ENV === "staging") assertStagingRuntimeEnvironment(process.env, database);
    const environment = readOperationalEnvironment(process.env);
    const databaseAligned = environment.isTestMode
      ? environment.databaseConfiguredAsTest && database?.databaseName === environment.expectedDatabaseName
      : environment.appEnvironment !== "PRODUCTION"
        || (database?.databaseName !== "crigestion_test" && database?.databaseName !== "crigestion_staging");
    if (!databaseAligned) {
      return healthResponse(request, 503, {
        status: "unavailable", database: "ok", verifactu: "degraded", worker: "not_required", timestamp
      });
    }

    let verifactu: "disabled" | "ok" | "degraded" = "disabled";
    let worker: "not_required" | "ok" | "degraded" = "not_required";
    if (!environment.configurationFlagsValid) {
      verifactu = "degraded";
    } else if (environment.verifactuEnabled) {
      const expectedEnvironment = environment.verifactuEnvironment;
      const environmentCoherent = isVerifactuEnvironmentCoherent(environment);
      const singleton = await prisma.installation.findUnique({ where: { singletonKey: 1 }, select: { companyId: true } });
      const now = new Date();
      const installation = singleton?.companyId && (expectedEnvironment === "TEST" || expectedEnvironment === "PRODUCTION")
        ? await prisma.verifactuSifInstallation.findFirst({
          where: {
            companyId: singleton.companyId,
            environment: expectedEnvironment,
            status: "ACTIVE",
            credentialRef: { not: null },
            credential: { is: {
              status: "ACTIVE",
              versions: { some: {
                status: "ACTIVE",
                validFrom: { lte: now },
                validUntil: { gt: now },
                ...(expectedEnvironment === "TEST" ? { allowTest: true } : { allowProduction: true })
              } }
            } }
          },
          select: { companyId: true }
        })
        : null;
      verifactu = environmentCoherent && installation ? "ok" : "degraded";
      if (verifactu === "ok" && installation) {
        const staleBefore = new Date(Date.now() - readWorkerStaleMs(process.env.VERIFACTU_WORKER_HEALTH_STALE_SECONDS));
        const latest = await prisma.verifactuWorkerRun.findFirst({
          where: { companyId: installation.companyId, environment: expectedEnvironment === "PRODUCTION" ? "PRODUCTION" : "TEST" },
          orderBy: [{ heartbeatAt: "desc" }, { id: "desc" }],
          select: { status: true, heartbeatAt: true, lastPollAt: true }
        });
        worker = classifyWorkerHealth(latest, staleBefore);
      }
    }
    const degraded = verifactu === "degraded" || worker === "degraded";
    const status: HealthState = degraded ? "degraded" : "ok";
    return healthResponse(request, degraded ? 503 : 200, { status, database: "ok", verifactu, worker, timestamp });
  } catch {
    return healthResponse(request, 503, {
      status: "unavailable", database: "unavailable", verifactu: "degraded", worker: "not_required", timestamp
    });
  }
}

function healthResponse(request: Request, statusCode: 200 | 503, body: {
  status: HealthState;
  database: "ok" | "unavailable";
  verifactu: "disabled" | "ok" | "degraded";
  worker: "not_required" | "ok" | "degraded";
  timestamp: string;
}) {
  return jsonResponse(request, body, { status: statusCode, headers: { "Cache-Control": "no-store" } });
}

function readWorkerStaleMs(raw: string | undefined): number {
  const seconds = Number(raw ?? "180");
  return Number.isInteger(seconds) && seconds >= 30 && seconds <= 3600 ? seconds * 1000 : 180_000;
}
