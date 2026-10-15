import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authorizeCredentials } from "@/auth/credentials";
import { getExec } from "@/auth/exec";
import { jwtCallback, sessionCallback } from "@/auth/callbacks";

// ADR-004: Credentials provider, seeded synthetic staff users, JWT session carrying userId only.
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      // The schema and the compare live in src/auth/credentials.ts, so the path /login takes
      // is the path the tests take (src/auth/auth.test.ts, against PGlite).
      authorize: (raw) => authorizeCredentials(getExec(), raw),
    }),
  ],
  callbacks: {
    jwt: jwtCallback,
    session: sessionCallback as never,
  },
});
