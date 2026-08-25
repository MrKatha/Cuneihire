import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Standalone CommonJS Node build scripts (see build-extension-zip.js's header) — not app source,
    // don't need the Next.js/React rule set (require() is intentional here, not a TS/ESM module).
    "scripts/**",
  ]),
]);

export default eslintConfig;
