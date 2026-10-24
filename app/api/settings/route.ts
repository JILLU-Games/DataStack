import { SettingsManager } from "@/core/adminSettings/settingsManager";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  try {
    const settings = SettingsManager.getPublicSettings();
    return NextResponse.json({ settings });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Settings read failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    SettingsManager.updateSettings(body);
    return NextResponse.json({
      settings: SettingsManager.getPublicSettings(),
      success: true,
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Settings update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
