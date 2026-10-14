import type { NextConfig } from "next";
import { assertBootEnv } from "./src/lib/env";

// Fail the build/boot closed if the data class is not SYNTHETIC (ADR-015).
assertBootEnv(process.env);

// `agentRules` writes an AGENTS.md into the repo root on every dev start and build. This
// project keeps its agent-facing docs in docs/, so the generated file is only noise.
const nextConfig: NextConfig = { poweredByHeader: false, agentRules: false };
export default nextConfig;
