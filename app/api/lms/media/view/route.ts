import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyLmsToken, LMS_COOKIE } from '@/lib/lms-session';
import { signLmsMediaToken, verifyLmsMediaToken } from '@/lib/lmsMediaToken';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST { url } → { viewUrl } (LMS-auth only).
 * GET  ?t=token → streams the file inline (no attachment) for iframe preview.
 */
export async function POST(req: NextRequest) {
  const jar = await cookies();
  const payload = verifyLmsToken(jar.get(LMS_COOKIE)?.value);
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  try {
    const body = (await req.json()) as { url?: string };
    const url = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return NextResponse.json({ error: 'Invalid media URL' }, { status: 400 });
    }
    const token = signLmsMediaToken(url);
    return NextResponse.json({
      viewUrl: `/api/lms/media/view?t=${encodeURIComponent(token)}`,
      token,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  const jar = await cookies();
  const payload = verifyLmsToken(jar.get(LMS_COOKIE)?.value);
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const token = req.nextUrl.searchParams.get('t') || '';
  const url = verifyLmsMediaToken(token);
  if (!url) return NextResponse.json({ error: 'Invalid or expired view token' }, { status: 403 });

  try {
    const upstream = await fetch(url, {
      headers: { Accept: '*/*' },
      redirect: 'follow',
    });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: 'Media file could not be loaded' }, { status: 502 });
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const lower = url.toLowerCase();
    const filename = lower.includes('.pptx')
      ? 'slides.pptx'
      : lower.includes('.ppt')
        ? 'slides.ppt'
        : lower.includes('.pdf')
          ? 'document.pdf'
          : 'document';

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
