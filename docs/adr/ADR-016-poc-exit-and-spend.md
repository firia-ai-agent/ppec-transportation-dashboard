# ADR-016 POC exit bar and spend alert
**Status: Decided by founder** (2026-10-14 11:23 ET).
- Exit: all AT-01–AT-18 and TEST-INF-01 pass on mocks, labelled "PASS (mock)". Mocks must be high fidelity (MOCKS-AND-DEMO.md). PRD live gates (Twilio SIDs, Teams ids, Traccar, AWS) are out of the POC exit.
- Spend: one $100/month alert across Vercel, Neon, OpenRouter; only OpenRouter expected to bill. Implement as OpenRouter key credit limit + Vercel/Neon usage notifications.
Alternatives considered: PRD live-gate exit (unreachable with founder-mocked vendors).
