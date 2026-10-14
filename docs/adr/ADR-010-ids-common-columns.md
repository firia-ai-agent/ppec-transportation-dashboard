# ADR-010 UUIDv7 ids and common columns
**Status: Proposed.** App-generated UUIDv7 (`uuidv7` 1.2.1) for time-ordered inserts; common columns version/created/updated/source_mode on every mutable ops table; optimistic concurrency via `version`. Alternative: randomUUID (Tokos) — index locality worse. Evidence: schema-draft.ts tsc pass.
