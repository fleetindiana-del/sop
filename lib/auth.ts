import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { ensureDefaultAdmin } from "@/lib/ensure-admin";
import { connectDB } from "@/lib/mongodb";
import User from "@/models/User";

/** On Vercel, ignore localhost NEXTAUTH_URL so CSRF/cookies use the real host. */
function ensureNextAuthUrl(): void {
  const current = (process.env.NEXTAUTH_URL || "").trim();
  const looksLocal = !current || /localhost|127\.0\.0\.1/i.test(current);
  const onVercel = process.env.VERCEL === "1" || Boolean(process.env.VERCEL_URL);

  if (onVercel && looksLocal) {
    const host =
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      process.env.VERCEL_URL;
    if (host) {
      process.env.NEXTAUTH_URL = host.startsWith("http") ? host : `https://${host}`;
    }
    return;
  }

  if (!current && process.env.VERCEL_URL) {
    process.env.NEXTAUTH_URL = `https://${process.env.VERCEL_URL}`;
  }
}
ensureNextAuthUrl();

export type AppRole = "admin" | "sop_admin" | "trainer" | "viewer";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name: string;
      username: string;
      role: AppRole;
      department?: string;
      pageAccess?: string[];
      email?: string | null;
    };
  }

  interface User {
    username: string;
    role: AppRole;
    department?: string;
    pageAccess?: string[];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    username: string;
    role: AppRole;
    department?: string;
    pageAccess?: string[];
    /** Epoch ms of the last refresh of role/department/pageAccess from the DB. */
    accessSyncedAt?: number;
  }
}

/** How long a token may serve cached access data before re-reading the user. */
const ACCESS_SYNC_INTERVAL_MS = 60_000;

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      id: "credentials",
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        try {
          if (!credentials?.username || !credentials?.password) {
            console.error("[auth] Missing username or password");
            return null;
          }

          await connectDB();
          await ensureDefaultAdmin();

          const username = credentials.username.toLowerCase().trim();
          const user = await User.findOne({ username });

          if (!user) {
            console.error("[auth] No user found for username:", username);
            return null;
          }

          if (!user.passwordHash) {
            console.error("[auth] User has no passwordHash:", username);
            return null;
          }

          const valid = await bcrypt.compare(credentials.password, user.passwordHash);
          if (!valid) {
            console.error("[auth] Password mismatch for username:", username);
            return null;
          }

          return {
            id: user._id.toString(),
            name: user.name,
            username: user.username,
            role: user.role,
            department: user.department,
            pageAccess: user.pageAccess,
          };
        } catch (error) {
          console.error("[auth] authorize error:", error);
          return null;
        }
      },
    }),
  ],
  session: {
    strategy: "jwt",
    maxAge: 24 * 60 * 60,
  },
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async jwt({ token, user, trigger }) {
      if (user) {
        token.id = user.id;
        token.username = user.username;
        token.role = user.role;
        token.department = user.department;
        token.pageAccess = user.pageAccess;
        token.accessSyncedAt = Date.now();
        return token;
      }

      // Re-read role/department/page access so permission changes take effect
      // without forcing the user to sign out.
      const stale =
        trigger === "update" ||
        Date.now() - (token.accessSyncedAt ?? 0) > ACCESS_SYNC_INTERVAL_MS;
      if (stale && token.id) {
        try {
          await connectDB();
          const fresh = await User.findById(token.id)
            .select("role department pageAccess")
            .lean();
          if (fresh) {
            token.role = fresh.role;
            token.department = fresh.department;
            token.pageAccess = fresh.pageAccess;
          }
        } catch (error) {
          console.error("[auth] failed to refresh access claims:", error);
        }
        token.accessSyncedAt = Date.now();
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id;
        session.user.username = token.username;
        session.user.role = token.role;
        session.user.department = token.department;
        session.user.pageAccess = token.pageAccess;
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
  debug: process.env.NEXTAUTH_DEBUG === "true",
};
