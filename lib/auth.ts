import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { ensureDefaultAdmin } from "@/lib/ensure-admin";
import { connectDB } from "@/lib/mongodb";
import User from "@/models/User";

export type AppRole = "admin" | "trainer" | "viewer";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name: string;
      username: string;
      role: AppRole;
      department?: string;
      email?: string | null;
    };
  }

  interface User {
    username: string;
    role: AppRole;
    department?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    username: string;
    role: AppRole;
    department?: string;
  }
}

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
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.username = user.username;
        token.role = user.role;
        token.department = user.department;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id;
        session.user.username = token.username;
        session.user.role = token.role;
        session.user.department = token.department;
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
  debug: process.env.NEXTAUTH_DEBUG === "true",
};
