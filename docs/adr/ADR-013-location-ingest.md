# ADR-013 Location ingest
**Status: Proposed.** `LocationIngest` accepts `{device_id, recorded_at, lat, lon, speed, heading}` batches; P1 source is the simulator replaying fixture routes (1 point / 5 s simulated). Dedupe on `(device_id, recorded_at)`; unbound devices stored with `bound=false` and never displayed. AWS later: Amazon Location trackers feed the same seam. Evidence: PRD §8, LOC-01.
