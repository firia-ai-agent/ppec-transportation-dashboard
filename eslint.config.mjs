import next from "eslint-config-next";

const config = [{ ignores: [".next/**", "node_modules/**", "docs/**", "next-env.d.ts"] }, ...next];
export default config;
