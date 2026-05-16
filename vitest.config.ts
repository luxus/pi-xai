import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "**/*.test.ts"],
    // Supports the project's explicit `.ts` imports in source files
    // (e.g. `import from "./foo.ts"`) thanks to Vite's resolver + "moduleResolution": "bundler" in tsconfig.
    // Vitest (via esbuild) handles the explicit `.ts` extension imports (Bun/Deno/Vite "bundler" style) required by the Pi runtime.
    globals: false, // we use explicit imports from 'vitest'
    isolate: true,
  },
});
