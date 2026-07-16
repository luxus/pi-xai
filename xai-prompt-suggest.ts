/**
 * Grok Build–style next-prompt ghost suggestions for Pi.
 *
 * After a turn settles, predict the user's likely next message (small model).
 * Shown as a widget above the editor; Tab accepts into the editor.
 *
 * Source: xai-org/grok-build prompt_suggest + prompt_suggestion controller.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getEffectiveXaiApiKey } from "./xai-oauth.ts";
import { resolveXaiConfig } from "./xai-config.ts";
import { xaiRequestHeaders } from "./xai-stream.ts";

const SUGGEST_SYSTEM =
  "You predict what the USER will type next into their coding agent CLI.\n" +
  "You are shown a transcript of the conversation so far. The agent's latest reply ends the transcript.\n\n" +
  "FIRST: look at the user's recent messages and original request.\n" +
  "Your job is to predict what THEY would type next — not what you think they should do.\n" +
  'THE TEST: would they think "I was just about to type that"?\n\n' +
  "EXAMPLES:\n" +
  '- User asked "fix the bug and run tests", bug is fixed -> "run the tests"\n' +
  '- After code was written -> "try it out"\n' +
  "- Agent offers options -> the option the user would likely pick\n" +
  '- Agent asks yes/no -> "yes" or "no"\n' +
  '- Task complete with obvious follow-up -> "commit this" or "push it"\n' +
  "- After an error or misunderstanding -> NONE\n\n" +
  'Be specific: "run the tests" beats "continue".\n' +
  'NEVER suggest rephrasing a request already handled, agent-voice ("Let me..."), or multi-sentence essays.\n' +
  "Stay silent if not obvious: reply with the single word NONE.\n" +
  "Format: 2-12 words, user style. ONLY the suggestion text or NONE.";

/** Fast text-only model — suggestion calls are throwaway, not session work. */
const DEFAULT_MODEL = "grok-composer-2.5-fast";
const MAX_CHARS = 120;
const MAX_WORDS = 16;
const TRANSCRIPT_BUDGET = 12_000;
const MSG_CAP = 800;

const ONE_WORD = new Set([
  "yes",
  "yeah",
  "yep",
  "no",
  "ok",
  "okay",
  "continue",
  "proceed",
  "push",
  "commit",
  "deploy",
  "stop",
  "check",
  "retry",
  "undo",
  "merge",
]);

let enabled = true;
let suggestion = "";
let generation = 0;
let dismissed = false;
let lastUi: ExtensionContext["ui"] | undefined;

export function isPromptSuggestEnabled(): boolean {
  if (process.env.XAI_PROMPT_SUGGESTIONS === "0" || process.env.GROK_PROMPT_SUGGESTIONS === "0") {
    return false;
  }
  if (process.env.XAI_PROMPT_SUGGESTIONS === "1" || process.env.GROK_PROMPT_SUGGESTIONS === "1") {
    return true;
  }
  return enabled;
}

export function setPromptSuggestEnabled(on: boolean): void {
  enabled = on;
  if (!on) clearSuggestion();
}

export function getSuggestion(): string {
  return suggestion;
}

export function clearSuggestion(): void {
  suggestion = "";
  dismissed = false;
  paintWidget(undefined);
}

export function ghostFor(editorText: string): string | undefined {
  if (!isPromptSuggestEnabled() || dismissed || !suggestion) return undefined;
  if (!suggestion.startsWith(editorText)) return undefined;
  const rest = suggestion.slice(editorText.length);
  return rest || undefined;
}

export function acceptSuggestion(editorText: string): string | undefined {
  const rest = ghostFor(editorText);
  if (rest === undefined) return undefined;
  const full = editorText + rest;
  clearSuggestion();
  return full;
}

export function filterSuggestion(raw: string): string | undefined {
  let s = raw.trim();
  if (!s || /^none$/i.test(s)) return undefined;
  s = s.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (s.includes("\n")) s = s.split("\n")[0]!.trim();
  if (s.length > MAX_CHARS) return undefined;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  if (words.length === 1 && !ONE_WORD.has(words[0]!.toLowerCase())) return undefined;
  if (words.length > MAX_WORDS) return undefined;
  if (/^(let me|i'll|i will|here's|here is)\b/i.test(s)) return undefined;
  return s;
}

export function buildTranscript(
  messages: Array<{ role?: string; content?: unknown }>,
): string | undefined {
  const lines: string[] = [];
  let used = 0;
  let sawAssistant = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const role = m.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = flattenContent(m.content).trim();
    if (!text) continue;
    const clipped = text.length > MSG_CAP ? text.slice(0, MSG_CAP) : text;
    const label = role === "user" ? "User" : "Agent";
    const line = `${label}: ${clipped}`;
    if (used + line.length > TRANSCRIPT_BUDGET) break;
    lines.push(line);
    used += line.length;
    if (role === "assistant") sawAssistant = true;
  }

  if (!sawAssistant || lines.length === 0) return undefined;
  return lines.reverse().join("\n");
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (!p || typeof p !== "object") return "";
      const o = p as { type?: string; text?: string };
      return typeof o.text === "string" ? o.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function paintWidget(lines: string[] | undefined): void {
  if (!lastUi) return;
  try {
    lastUi.setWidget("xai-prompt-suggest", lines, { placement: "aboveEditor" });
  } catch {
    /* ignore */
  }
}

function showSuggestion(text: string): void {
  suggestion = text;
  dismissed = false;
  // Outside the textbox (Grok-style ghost lives above input until Tab accepts).
  paintWidget([`💡  ${text}`, `   Tab to use · Esc-style: /xai-suggest clear`]);
}

async function fetchSuggestion(transcript: string): Promise<string | undefined> {
  const effective = await getEffectiveXaiApiKey();
  if (!effective?.apiKey) return undefined;
  const config = resolveXaiConfig();
  const baseUrl = config.xai.baseUrl;
  const model =
    process.env.XAI_PROMPT_SUGGESTIONS_MODEL ||
    process.env.GROK_PROMPT_SUGGESTIONS_MODEL ||
    DEFAULT_MODEL;

  const url = `${baseUrl.replace(/\/+$/, "")}/responses`;
  const body = {
    model,
    stream: false,
    store: false,
    max_output_tokens: 64,
    temperature: 0.4,
    instructions: SUGGEST_SYSTEM,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: `Transcript:\n${transcript}\n\nNext user message:` }],
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${effective.apiKey}`,
      "Content-Type": "application/json",
      ...xaiRequestHeaders(model, baseUrl, null),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return undefined;
  const json = (await res.json()) as { output?: Array<{ type?: string; content?: unknown }> };
  const texts: string[] = [];
  for (const item of json.output ?? []) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const p of item.content as Array<{ type?: string; text?: string }>) {
      if (typeof p.text === "string") texts.push(p.text);
    }
  }
  return filterSuggestion(texts.join(" ").trim());
}

export function registerXaiPromptSuggest(api: ExtensionAPI): void {
  api.registerCommand("xai-suggest", {
    description: "Prompt ghost: on | off | status | clear (predict next user message)",
    async handler(args, ctx) {
      lastUi = ctx.ui;
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "off") {
        setPromptSuggestEnabled(false);
        ctx.ui.notify("Prompt suggestions OFF", "info");
        return;
      }
      if (sub === "on") {
        setPromptSuggestEnabled(true);
        ctx.ui.notify("Prompt suggestions ON (after each turn)", "info");
        return;
      }
      if (sub === "clear") {
        clearSuggestion();
        ctx.ui.notify("Suggestion cleared", "info");
        return;
      }
      ctx.ui.notify(
        `Prompt suggestions: ${isPromptSuggestEnabled() ? "on" : "off"}` +
          (suggestion ? `\nCurrent: ${suggestion}` : "\nNo active suggestion"),
        "info",
      );
    },
  });

  api.registerShortcut("tab", {
    description: "Accept predicted next prompt (ghost)",
    handler: async (ctx) => {
      lastUi = ctx.ui;
      if (!isPromptSuggestEnabled() || !suggestion) return;
      const editor = ctx.ui.getEditorText?.() ?? "";
      const accepted = acceptSuggestion(editor);
      if (accepted === undefined) return;
      ctx.ui.setEditorText(accepted);
    },
  });

  api.on("agent_end", async (event, ctx) => {
    lastUi = ctx.ui;
    if (!isPromptSuggestEnabled()) return;

    const messages = (event as { messages?: Array<{ role?: string; content?: unknown }> }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const transcript = buildTranscript(messages as Array<{ role?: string; content?: unknown }>);
    if (!transcript) return;

    const gen = ++generation;
    try {
      const next = await fetchSuggestion(transcript);
      if (gen !== generation) return;
      if (next) showSuggestion(next);
      else clearSuggestion();
    } catch {
      if (gen === generation) clearSuggestion();
    }
  });

  api.on("session_start", () => {
    clearSuggestion();
    lastUi = undefined;
  });
}
