# ADR-014 Demo controls gating
**Status: Proposed.** Demo panel (reset/replay/fault/clock) renders and its APIs respond only when `DEMO_MODE=1` and `APP_DATA_CLASS=SYNTHETIC` and the user is DIRECTOR. Reset truncates ops tables and re-seeds in one transaction; never touches identity keys config. Tokos inferred demo mode from missing keys — avoided.
