import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

async function main() {
  loadEnv();
  const url = 'http://localhost:3000/api/training-matrix/manage-sop-view?year=all&refresh=1';
  const req = new NextRequest(url);
  const mod = await import('../app/api/training-matrix/manage-sop-view/route');
  const start = Date.now();
  try {
    const res = await mod.GET(req);
    const text = await res.text();
    console.log('status', res.status);
    console.log('elapsedMs', Date.now() - start);
    console.log('bodyStart', text.slice(0, 300));
  } catch (err) {
    console.error('THROWN', err);
    process.exitCode = 1;
  }
}

main();
