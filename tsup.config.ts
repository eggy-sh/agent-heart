import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      cli: "src/cli/index.ts",
    },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: true,
    target: "node20",
    splitting: false,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    entry: {
      index: "src/index.ts",
      client: "src/core/client.ts",
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    target: "node20",
    splitting: true,
  },
]);
