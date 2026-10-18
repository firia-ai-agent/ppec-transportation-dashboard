-- Migration 0010 — the reply as a coordinator edited it before approving (Edit = message text,
-- user ruling 2026-10-18). Additive and nullable: a row approved as drafted keeps NULL.
ALTER TABLE "ops"."approval_request" ADD COLUMN "edited_text" text;