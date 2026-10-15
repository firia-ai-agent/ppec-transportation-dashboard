-- Founder decision, DECISION-LEDGER row 59: the three synthetic demo logins share one password,
-- which /login prints next to each demo email (src/auth/demo-accounts.ts DEMO_SHARED_PASSWORD).
-- Data-only migration: it brings the one production database (Neon `main`, single-DB directive,
-- DECISION-LEDGER #43) in line with what the sign-in page now says, because production is never
-- seeded from a build (scripts/vercel-seed.ts) and `pnpm seed:demo-users` is a manual step.
--
-- The value below is the bcrypt hash of that password at cost 12 — the same algorithm and cost
-- src/auth/seed.ts uses — precomputed once so the plain password never appears in a migration.
-- Idempotent: it writes one constant to one column, so a second run writes the same bytes.
-- It touches no other row (three literal emails), no other column, and inserts nothing: on a
-- database where those users do not exist yet (a fresh PGlite, a new branch) it updates 0 rows
-- and the seed creates them with the same hash.
UPDATE "ops"."app_user" SET "password_hash" = '$2b$12$vVTkLAnkcoO2zyvItO4cwuh3GdEKh7MX9JMavx0q0Uh9DXI8AU.5u'
WHERE "email" IN ('director@example.com', 'coordinator@example.com', 'frontdesk@example.com');
