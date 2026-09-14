import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { resolveLmsIdentity } from '@/lib/lmsIdentity';
import { sopIdentifierMatchFilter } from '@/lib/sopIdentifierNormalize';
import { signViewerToken } from '@/lib/viewerToken';
import SOP from '@/models/SOP';

export const dynamic = 'force-dynamic';

type AnnexureDoc = {
  fileName?: string;
  filePath?: string;
  language?: string;
  documentKind?: string;
  annexureLabel?: string;
  checksum?: string;
};

/** Roman numeral → integer so annexure labels (I, II, ... IX, X) sort in document order. */
function romanToInt(s: string): number {
  const map: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  const up = s.trim().toUpperCase();
  if (!up) return Number.MAX_SAFE_INTEGER;
  let total = 0;
  for (let i = 0; i < up.length; i++) {
    const cur = map[up[i]] || 0;
    const next = map[up[i + 1]] || 0;
    total += cur < next ? -cur : cur;
  }
  return total || Number.MAX_SAFE_INTEGER;
}

// GET /api/lms/sop-annexures?identifier=...&language=...
// Returns the annexures linked to an SOP, each with a short-lived view token
// (never the raw storage path) so the LMS journey viewer can render them
// below the main SOP document.
export async function GET(request: NextRequest) {
  const payload = await resolveLmsIdentity();
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const identifier = searchParams.get('identifier')?.trim();
  const language = searchParams.get('language') || 'English';
  if (!identifier) return NextResponse.json({ annexures: [] });

  await connectDB();
  const rows = (await SOP.find(sopIdentifierMatchFilter(identifier))
    .select('sopDocuments')
    .lean()) as Array<{ sopDocuments?: AnnexureDoc[] }>;

  const wantGuj = language === 'Gujarati';
  const seen = new Set<string>();
  const annexures: { label: string; fileName: string; fileType: 'pdf' | 'docx'; token: string }[] = [];

  for (const row of rows) {
    for (const doc of row.sopDocuments || []) {
      if (doc.documentKind !== 'annexure' || !doc.filePath?.trim()) continue;
      const key = doc.checksum || doc.filePath;
      if (seen.has(key)) continue;
      const docLang = String(doc.language || '').trim().toLowerCase();
      if (docLang === 'gujarati' && !wantGuj) continue;
      if (docLang && docLang !== 'gujarati' && wantGuj) continue;
      seen.add(key);
      const fileType: 'pdf' | 'docx' = /\.pdf($|\?)/i.test(doc.filePath) ? 'pdf' : 'docx';
      annexures.push({
        label: doc.annexureLabel?.trim() || '',
        fileName: doc.fileName?.trim() || 'Annexure',
        fileType,
        token: signViewerToken({ path: doc.filePath.trim() }),
      });
    }
  }

  annexures.sort((a, b) => romanToInt(a.label) - romanToInt(b.label));

  return NextResponse.json({ annexures });
}
