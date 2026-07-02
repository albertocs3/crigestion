import { prisma } from "@/lib/prisma";
import { jsonResponse } from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  await prisma.$queryRaw`SELECT 1`;

  return jsonResponse(request, {
    status: "ok",
    database: "ok",
    timestamp: new Date().toISOString()
  });
}
