import { SettingsManager } from '@/core/adminSettings/settingsManager';
import { AuthService } from '@/core/auth/jwt';
import { DataBufferEngine } from '@/core/data/buffer';
import { SDKManager } from '@/core/sdk/sdkManager';
import { isClientIpAllowed, isClientTokenExpired } from '@/core/Security/ipAllowlist';
import { extractClientIp } from '@/lib/adminAuth';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  try {
    const settings = await SettingsManager.getSettingsAsync();
    const authHeader = req.headers.get('authorization');

    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      const rawToken = authHeader.slice(7).trim();
      const verified = AuthService.verifyClientToken(rawToken);
      if (!verified.valid || !verified.payload) {
        return NextResponse.json(
          {
            status: 'error',
            code: 'AUTH_INVALID',
            error: verified.error || 'Invalid client JWT token.',
          },
          { status: 401 },
        );
      }

      const clientId = SDKManager.normalizeClientId(
        String(verified.payload.clientId || ''),
      );
      if (await SDKManager.isClientDeletedAsync(clientId)) {
        return NextResponse.json(
          {
            status: 'error',
            code: 'CLIENT_REVOKED',
            error: `CLIENT_REVOKED: Client '${clientId}' has been deleted by administrator.`,
          },
          { status: 403 },
        );
      }
      const registeredClient = await SDKManager.getClientAsync(clientId);
      if (!registeredClient) {
        return NextResponse.json(
          {
            status: 'error',
            code: 'CLIENT_REVOKED',
            error: `CLIENT_REVOKED: Client '${clientId}' registration not found or has been deleted.`,
          },
          { status: 403 },
        );
      }
      if (registeredClient.status === 'revoked') {
        return NextResponse.json(
          {
            status: 'error',
            code: 'CLIENT_REVOKED',
            error: `CLIENT_REVOKED: Client '${clientId}' access has been revoked by administrator.`,
          },
          { status: 403 },
        );
      }
      if (registeredClient.token && registeredClient.token !== rawToken) {
        return NextResponse.json(
          {
            status: 'error',
            code: 'TOKEN_ROTATED',
            error: 'TOKEN_ROTATED: Client credentials have been rotated. Use the latest token.',
          },
          { status: 401 },
        );
      }
      if (isClientTokenExpired(registeredClient.expiresAt)) {
        return NextResponse.json(
          {
            status: 'error',
            code: 'CLIENT_TOKEN_EXPIRED',
            error: `CLIENT_TOKEN_EXPIRED: Client '${clientId}' token has expired (${registeredClient.expiresAt}).`,
          },
          { status: 401 },
        );
      }
      const clientIp = extractClientIp(req);
      if (!isClientIpAllowed(clientIp, registeredClient.allowedIps)) {
        return NextResponse.json(
          {
            status: 'error',
            code: 'CLIENT_IP_FORBIDDEN',
            error: `CLIENT_IP_FORBIDDEN: IP '${clientIp}' is not in the allowlist for client '${clientId}'.`,
          },
          { status: 403 },
        );
      }
    }

    const bufferStats = await DataBufferEngine.getBufferStatsAsync();

    return NextResponse.json({
      status: 'online',
      service: 'DataStack Web API',
      maxEventsPerSec: settings.maxEventsPerSec,
      maxPayloadSizeKb: settings.maxPayloadSizeKb,
      maxPayloadSizeBytes: settings.maxPayloadSizeKb * 1024,
      bufferSize: bufferStats.currentBufferSize,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Health check failed';
    return NextResponse.json(
      { status: 'error', error: message },
      { status: 500 },
    );
  }
}
