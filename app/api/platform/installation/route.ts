import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const installation = await prisma.installation.findFirst({
    select: {
      id: true,
      status: true,
      startedAt: true,
      completedAt: true,
      productVersion: true
    }
  });

  return NextResponse.json({
    initialized: installation?.status === "INITIALIZED",
    installation
  });
}
