import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { createLmsToken, LMS_COOKIE } from '@/lib/lms-session';
import { toLmsClientEmployee } from '@/lib/employeeTrainer';
import {
  findEmployeeForLmsLogin,
  passwordMatchesLmsLogin,
} from '@/lib/sharedLoginLookup';

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
    const identity = await findEmployeeForLmsLogin(String(username));

    // Uniform error so we don't reveal whether the username exists.
    const invalid = NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
    if (!identity) return invalid;
    const { employee } = identity;
    if (!employee.isActive) {
      return NextResponse.json({ error: 'This account is inactive. Contact your administrator.' }, { status: 403 });
    }

    const ok = await passwordMatchesLmsLogin(identity, String(password));
    if (!ok) return invalid;

    // Bind the cookie to the application login (if any) that created it, so it
    // stops being honoured once somebody else signs in on this browser.
    const session = await getServerSession(authOptions);
    const { token, maxAge } = createLmsToken(
      employee._id.toString(),
      employee.name,
      session?.user?.id || null,
    );
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
