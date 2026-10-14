import type { NextConfig } from "next";
import { assertBootEnv } from "./src/lib/env";

// Fail the build/boot closed if the data class is not SYNTHETIC (ADR-015).
assertBootEnv(process.env);

const nextConfig: NextConfig = { poweredByHeader: false };
export default nextConfig;
