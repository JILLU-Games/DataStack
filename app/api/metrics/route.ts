import { NextRequest, NextResponse } from 'next/server';
import { ApiEngine } from '@/core/apiEngine/apiService';
import { requireAdminApiSession } from '@/lib/adminAuth';

export async function GET(req: NextRequest) {
  const auth = await requireAdminApiSession(req);
  if (!auth.valid) {
    return auth.response;
  }

  try {
    const metrics = await ApiEngine.getDashboardMetrics();
    return NextResponse.json(metrics);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Metrics calculation failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
