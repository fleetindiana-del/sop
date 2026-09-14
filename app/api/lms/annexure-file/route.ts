import { NextRequest, NextResponse } from 'next/server';
import { verifyViewerToken } from '@/lib/viewerToken';
import { loadStoredFileBuffer } from '@/lib/loadStoredFileBuffer';

// GET /api/lms/annexure-file?t=<token> — serves an SOP annexure's bytes for
// in-browser view-only rendering (docx-preview or PDF). Same signed-token
// pattern as /api/files/serve-docx; never exposes the storage path directly.
export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('t');
    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 });
    }

    const payload = verifyViewerToken(token);
    const path = payload?.path?.trim();
    if (!payload || !path) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 403 });
    }

    const buffer = await loadStoredFileBuffer(path, { trustedRemote: true });
    if (!buffer) {
      return NextResponse.json({ error: 'File not found on server' }, { status: 404 });
    }

    const isPdf = /\.pdf($|\?)/i.test(path);
    const contentType = isPdf
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="annexure.${isPdf ? 'pdf' : 'docx'}"`,
        'Cache-Control': 'private, max-age=60, must-revalidate',
      },
    });
  } catch (error) {
    console.error('annexure-file error:', error);
    return NextResponse.json({ error: 'Failed to serve file' }, { status: 500 });
  }
}
