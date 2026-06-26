import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await prisma.$queryRaw`SELECT 1`;

  return NextResponse.json({
    status: "ok",
    database: "ok",
    timestamp: new Date().toISOString()
  });
}
