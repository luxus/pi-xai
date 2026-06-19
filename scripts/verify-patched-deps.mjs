import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(resolve(root, "node_modules/@earendil-works/pi-coding-agent/package.json"));

const min = { undici: "8.5.0", ws: "8.21.0", protobufjs: "7.6.4" };
for (const [pkg, want] of Object.entries(min)) {
  const v = req(`${pkg}/package.json`).version;
  if (v !== want && pkg === "undici" && v < "8.5.0") {
    throw new Error(`${pkg}@${v} from pi-coding-agent context (want >=${want})`);
  }
  if (pkg === "ws" && v < "8.21.0") throw new Error(`${pkg}@${v} (want >=${want})`);
  if (pkg === "protobufjs" && v < "7.6.4") throw new Error(`${pkg}@${v} (want >=${want})`);
}
console.log("patched deps ok:", Object.fromEntries(Object.keys(min).map((p) => [p, req(`${p}/package.json`).version])));