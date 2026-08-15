import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import { connectDB } from '@/lib/mongodb';
import { createLmsToken, LMS_COOKIE } from '@/lib/lms-session';
import { escapeRegex } from '@/lib/lms-credentials';
import { toLmsClientEmployee } from '@/lib/employeeTrainer';
import Employee from '@/models/Employee';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/lms/auth/login — employee learning-module sign in.
export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();
    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password are required' }, { status: 400 });
    }

    await connectDB();
    const employee = await Employee.findOne({
      lmsUsername: new RegExp(`^${escapeRegex(String(username).trim())}$`, 'i'),
    }).select('+lmsPasswordHash');

    // Uniform error so we don't reveal whether the username exists.
    const invalid = NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
    if (!employee || !employee.lmsPasswordHash) return invalid;
    if (!employee.isActive) {
      return NextResponse.json({ error: 'This account is inactive. Contact your administrator.' }, { status: 403 });
    }

    const ok = await bcrypt.compare(String(password), employee.lmsPasswordHash);
    if (!ok) return invalid;

    const { token, maxAge } = createLmsToken(employee._id.toString(), employee.name);
    const jar = await cookies();
    jar.set(LMS_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge,
    });

    return NextResponse.json({
      employee: toLmsClientEmployee(employee),
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
