import { SettingsManager } from "@/core/adminSettings/settingsManager";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  try {
    const settings = await SettingsManager.getPublicSettingsAsync();
    return NextResponse.json({ settings });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Settings read failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    await SettingsManager.updateSettingsAsync(body);
    const settings = await SettingsManager.getPublicSettingsAsync();
    return NextResponse.json({
      settings,
      success: true,
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Settings update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
