import { NextResponse } from 'next/server';

import { LegalAuthError, requireSession } from '@/lib/server/auth';
import type { SessionInfo } from '@/lib/types';

// Auth-gate every API route first, then NextResponse.json — the standing repo rule.
// Handlers wrap their body in withSession(); auth failures become JSON errors here.

// Thrown by server modules to surface a specific HTTP status + user-readable message.
export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function jsonError(error: unknown): NextResponse {
  if (error instanceof LegalAuthError || error instanceof ApiError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
  }
  console.error('[legal] API error:', error);
  return NextResponse.json({ ok: false, error: 'Internal error.' }, { status: 500 });
}

export async function withSession(
  handler: (session: SessionInfo) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const session = await requireSession();
    return await handler(session);
  } catch (error) {
    return jsonError(error);
  }
}
