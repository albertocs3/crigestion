import { NextResponse } from "next/server";
import { getInstallationState } from "@/modules/platform/application/installation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getInstallationState());
}
