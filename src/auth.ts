import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { verifyCredentials } from "@/auth/core";
import { getExec } from "@/auth/exec";

const creds = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

// ADR-004: Credentials provider, seeded synthetic staff users, JWT session carrying userId only.
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const p = creds.safeParse(raw);
        if (!p.success) return null;
        return verifyCredentials(getExec(), p.data.email, p.data.password);
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    session({ session, token }) {
      if (session.user && typeof token.uid === "string") session.user.id = token.uid;
      return session;
    },
  },
});
