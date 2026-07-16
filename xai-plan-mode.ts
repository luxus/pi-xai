/**
 * Grok Build plan mode for Pi (lean).
 *
 * Tools: enter_plan_mode / exit_plan_mode (official ids).
 * Command: /plan [on|off|status|show]
 * Plan file: .pi/plan.md (session cwd)
 *
 * Read-only tools while active; bash allowlist for safe commands.
 * Inspired by Pi plan-mode example + xai-org/grok-build plan tools.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PLAN_FILE = ".pi/plan.md";
const PLAN_DISABLED = new Set(["edit", "write"]);
const PLAN_PREFERRED = ["read", "bash", "grep", "find", "ls"];

const DESTRUCTIVE =
  /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|sudo|kill|reboot)\b|(^|[^<])>(?!>)|>>|\bnpm\s+(i|install|uninstall)\b|\bgit\s+(add|commit|push|reset)\b/i;
const SAFE_BASH =
  /^\s*(cat|head|tail|less|more|grep|rg|find|ls|pwd|echo|wc|sort|uniq|diff|file|stat|tree|which|env|git\s+(status|log|diff|show|branch|remote)|node\s+-e|python3?\s+-c)\b/i;

export function isSafePlanBash(command: string): boolean {
  const c = command.trim();
  if (!c || DESTRUCTIVE.test(c)) return false;
  // pipelines: each segment must be safe-ish
  return c.split("|").every((seg) => SAFE_BASH.test(seg.trim()) || !DESTRUCTIVE.test(seg));
}

export function planFilePath(cwd: string): string {
  return join(cwd, PLAN_FILE);
}

export function readPlanFile(cwd: string): string {
  const p = planFilePath(cwd);
  if (!existsSync(p)) return "";
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

export function seedPlanFile(cwd: string): { path: string; created: boolean } {
  const p = planFilePath(cwd);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(p)) {
    writeFileSync(
      p,
      "# Plan\n\n_Describe the implementation plan here. Exit plan mode when ready for review._\n",
      "utf8",
    );
    return { path: p, created: true };
  }
  return { path: p, created: false };
}

let planMode = false;
let toolsBefore: string[] | undefined;

function enablePlanTools(api: ExtensionAPI): void {
  if (toolsBefore === undefined) toolsBefore = api.getActiveTools();
  const base = toolsBefore ?? api.getActiveTools();
  const next = [
    ...base.filter((n) => !PLAN_DISABLED.has(n)),
    ...PLAN_PREFERRED,
    "enter_plan_mode",
    "exit_plan_mode",
  ];
  api.setActiveTools([...new Set(next)]);
}

function restoreTools(api: ExtensionAPI): void {
  if (toolsBefore) api.setActiveTools(toolsBefore);
  toolsBefore = undefined;
}

function setStatus(ctx: ExtensionContext | undefined, on: boolean): void {
  if (!ctx?.ui) return;
  try {
    ctx.ui.setStatus("xai-plan", on ? "⏸ plan" : undefined);
  } catch {
    /* ignore */
  }
}

export function isPlanModeActive(): boolean {
  return planMode;
}

export function registerXaiPlanMode(api: ExtensionAPI): void {
  api.registerTool(
    defineTool({
      name: "enter_plan_mode",
      label: "enter_plan_mode",
      description:
        "Enter read-only plan mode to explore the codebase and write an implementation plan. Use when the task is ambiguous or the user asks for a plan. Seeds .pi/plan.md.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const cwd = ctx?.cwd || process.cwd();
        const seed = seedPlanFile(cwd);
        planMode = true;
        enablePlanTools(api);
        setStatus(ctx as ExtensionContext, true);
        return {
          content: [
            {
              type: "text",
              text:
                `Plan mode ON (read-only tools).\n` +
                `Plan file: ${seed.path}${seed.created ? " (created)" : ""}\n` +
                `Explore, then write the plan to that file. Call exit_plan_mode when ready for user review.`,
            },
          ],
          details: { planMode: true, planFile: seed.path },
        };
      },
    }),
  );

  api.registerTool(
    defineTool({
      name: "exit_plan_mode",
      label: "exit_plan_mode",
      description:
        "Exit plan mode and present the plan file (.pi/plan.md) for user review. Call after finishing the plan.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const cwd = ctx?.cwd || process.cwd();
        const plan = readPlanFile(cwd).trim();
        planMode = false;
        restoreTools(api);
        setStatus(ctx as ExtensionContext, false);
        if (!plan) {
          return {
            content: [
              {
                type: "text",
                text: `Plan mode OFF. Plan file empty or missing (${planFilePath(cwd)}). User should review before implementation.`,
              },
            ],
            details: { planMode: false, empty: true },
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Plan mode OFF — ready for user approval.\n\n` +
                `--- plan (${planFilePath(cwd)}) ---\n${plan}\n--- end plan ---\n\n` +
                `Wait for the user to approve or request changes before implementing.`,
            },
          ],
          details: { planMode: false, plan },
        };
      },
    }),
  );

  api.registerCommand("plan", {
    description: "Plan mode: /plan [on|off|status|show] — Grok-style read-only planning",
    async handler(args, ctx) {
      const cwd = ctx.cwd || process.cwd();
      const sub = (args ?? "").trim().toLowerCase();

      const turnOn = () => {
        planMode = true;
        seedPlanFile(cwd);
        enablePlanTools(api);
        setStatus(ctx, true);
      };
      const turnOff = () => {
        planMode = false;
        restoreTools(api);
        setStatus(ctx, false);
      };

      if (!sub) {
        if (planMode) turnOff();
        else turnOn();
        ctx.ui.notify(planMode ? `Plan mode ON → ${planFilePath(cwd)}` : "Plan mode OFF.", "info");
        return;
      }
      if (sub === "on") {
        turnOn();
        ctx.ui.notify(`Plan mode ON → ${planFilePath(cwd)}`, "info");
        return;
      }
      if (sub === "off") {
        turnOff();
        ctx.ui.notify("Plan mode OFF.", "info");
        return;
      }
      if (sub === "status") {
        const plan = readPlanFile(cwd);
        ctx.ui.notify(
          planMode
            ? `Plan mode ON\nFile: ${planFilePath(cwd)}\n${plan ? plan.slice(0, 500) : "(empty plan)"}`
            : "Plan mode OFF. /plan on, or model may call enter_plan_mode.",
          "info",
        );
        return;
      }
      if (sub === "show") {
        const plan = readPlanFile(cwd);
        ctx.ui.notify(plan || `(no plan at ${planFilePath(cwd)})`, "info");
        return;
      }
      ctx.ui.notify("Usage: /plan [on|off|status|show]", "warning");
    },
  });

  api.on("tool_call", async (event) => {
    if (!planMode || event.toolName !== "bash") return;
    const command = String((event.input as { command?: string })?.command ?? "");
    if (!isSafePlanBash(command)) {
      return {
        block: true as const,
        reason: `Plan mode: bash blocked (not read-only allowlist).\nCommand: ${command}\n/plan off to disable.`,
      };
    }
  });

  api.on("before_agent_start", async () => {
    if (!planMode) return;
    return {
      message: {
        customType: "xai-plan-mode",
        content:
          `[PLAN MODE ACTIVE]\n` +
          `Read-only exploration. edit/write disabled; bash is allowlisted.\n` +
          `Write the plan to \`${PLAN_FILE}\`.\n` +
          `When finished, call exit_plan_mode (do not implement yet).\n` +
          `Or the user can /plan off to restore full tools.`,
        display: false,
      },
    };
  });

  api.on("session_start", (event) => {
    if (event.reason === "startup") return;
    planMode = false;
    toolsBefore = undefined;
  });
}
