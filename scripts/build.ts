import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import path from "path"

const root = path.resolve(import.meta.dir, "..")
const src = path.join(root, "src", "tui.tsx")
const outdir = path.join(root, "dist")

const result = await Bun.build({
  entrypoints: [src],
  target: "bun",
  outdir,
  external: [
    "@opentui/core",
    "@opentui/solid",
    "@opentui/keymap",
    "@opencode-ai/plugin",
    "@opencode-ai/sdk",
    "solid-js",
  ],
  plugins: [createSolidTransformPlugin({ moduleName: "@opentui/solid" })],
  naming: "tui.[ext]",
  minify: false,
  splitting: false,
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

for (const output of result.outputs) {
  const name = path.basename(output.path)
  console.log(`  ${name}  ${(output.size / 1024).toFixed(2)} KB`)
}
