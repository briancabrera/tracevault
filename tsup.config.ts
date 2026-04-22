import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    query: "src/query/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  splitting: false,
  target: "node18",
  treeshake: true,
});
