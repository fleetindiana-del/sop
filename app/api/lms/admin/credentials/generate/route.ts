import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { generateUniqueLmsUsername, generateAutoPassword } from '@/lib/lms-credentials';
import Employee from '@/models/Employee';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/lms/admin/credentials/generate
// For every employee that has no learning-module password yet, generate a
// username ("First.Last") and an auto password ("First@NNNN"), then return the
// plaintext credentials. The password is stored only as a bcrypt hash, so this
// response is the ONE time the admin can see/share it.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await connectDB();
    const pending = await Employee.find({
      isActive: { $ne: false },
      $or: [{ lmsPasswordHash: { $exists: false } }, { lmsPasswordHash: null }, { lmsPasswordHash: '' }],
    }).select('_id name lmsUsername');

    const credentials: Array<{ name: string; username: string; password: string }> = [];

    for (const emp of pending) {
      const id = emp._id.toString();
      // Give everyone the current "First.Last" handle; these accounts have no
      // password yet, so they've never been used — safe to (re)assign.
      const username = await generateUniqueLmsUsername(emp.name, id);
      const password = generateAutoPassword(emp.name);

      emp.lmsUsername = username;
      emp.lmsPasswordHash = await bcrypt.hash(password, 12);
      await emp.save();

      credentials.push({ name: emp.name, username, password });
    }

    return NextResponse.json({ generated: credentials.length, credentials });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
