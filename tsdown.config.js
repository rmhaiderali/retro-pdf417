import { defineConfig } from "tsdown"

export default defineConfig({
  format: ["cjs", "esm"],
  entry: ["./src/index.js"],
  shims: true,
  clean: true,
})
