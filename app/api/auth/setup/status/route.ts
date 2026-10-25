import { isAdminSetupComplete } from "@/core/auth/adminUsers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(
      { setupComplete: await isAdminSetupComplete() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Admin setup status is unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
