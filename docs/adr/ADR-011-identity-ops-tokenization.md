# ADR-011 identity/ops split with tokens
**Status: Proposed** (implements PRD §6.1/§15.1). Separate `identity` schema, no FKs across, app-level AES-GCM + HMAC blind index in P1; KMS + RLS in P2. Evidence: DATA-MODEL.md §1, PGlite apply log.
