import type { JWT } from "next-auth/jwt";

/**
 * ADR-004: the session token carries ONLY `uid` (plus iat/exp/jti added by Auth.js at encode time).
 * Auth.js's default token ({name, email, picture, sub}) is discarded, not extended.
 */
export function jwtCallback({ token, user }: { token: JWT; user?: { id?: string } | null }): JWT {
  const uid = user?.id ?? (typeof token.uid === "string" ? token.uid : undefined);
  return (uid ? { uid } : {}) as JWT;
}

/** Session exposes only the id; display name and roles are read from the DB per request. */
export function sessionCallback<S extends { user?: unknown }>({ session, token }: { session: S; token: JWT }): S {
  return { ...session, user: typeof token.uid === "string" ? { id: token.uid } : undefined } as S;
}
