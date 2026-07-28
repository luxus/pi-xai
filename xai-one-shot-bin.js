#!/usr/bin/env node

import { register } from "tsx/esm/api";

register();
const { main } = await import("./xai-one-shot-cli.ts");
await main();
