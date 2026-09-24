import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Exercise the complete suite against a separately installed host SDK.
const root = process.env.OPENCLAW_COMPAT_ROOT;
if (!root) throw new Error("Set OPENCLAW_COMPAT_ROOT to the host OpenClaw package directory");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const alias = Object.entries(manifest.exports as Record<string, { default?: string }>)
  .filter(([key, value]) => key.startsWith("./plugin-sdk/") && value.default)
  .map(([key, value]) => ({ find: `openclaw/${key.slice(2)}`, replacement: path.resolve(root, value.default!) }));
export default defineConfig({ resolve: { alias } });
