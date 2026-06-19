import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ponytail: pi-coding-agent nests vulnerable undici/ws/protobufjs; hoist to root devDeps after install
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nested = resolve(root, "node_modules/@earendil-works/pi-coding-agent/node_modules");
for (const pkg of ["undici", "ws", "protobufjs"]) {
  const p = resolve(nested, pkg);
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}