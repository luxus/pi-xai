import { createPiGrokBuildAuth } from "./xai-one-shot-auth.ts";
import {
  DEFAULT_ONE_SHOT_PROVIDER,
  DEFAULT_ONE_SHOT_TRANSPORT,
  EXIT_INTERNAL_ERROR,
  EXIT_INVALID_INPUT,
  MAX_ONE_SHOT_REQUEST_BYTES,
  MAX_ONE_SHOT_RESULT_BYTES,
  parseStrictJson,
  runOneShot,
  validateOneShotRequest,
  type OneShotDependencies,
  type OneShotResultFrame,
  type OneShotRunResult,
} from "./xai-one-shot.ts";

interface InputStream extends AsyncIterable<string | Uint8Array> {}
interface OutputStream {
  write(chunk: string): unknown;
}

export interface OneShotCliIO {
  stdin: InputStream;
  stdout: OutputStream;
  stderr: OutputStream;
}

function inputFailure(): OneShotRunResult {
  return {
    exitCode: EXIT_INVALID_INPUT,
    frame: {
      ok: false,
      error: { code: "invalid_request", message: "stdin was not one valid bounded request." },
    },
  };
}

async function readBoundedStdin(stdin: InputStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stdin) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_ONE_SHOT_REQUEST_BYTES) throw new Error("request too large");
    chunks.push(buffer);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

function boundedFrame(frame: OneShotResultFrame): string {
  const line = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(line) > MAX_ONE_SHOT_RESULT_BYTES) {
    return `${JSON.stringify({
      ok: false,
      error: { code: "internal_error", message: "Result exceeded its output bound." },
    })}\n`;
  }
  return line;
}

export async function runOneShotCli(
  io: OneShotCliIO,
  dependencies: OneShotDependencies,
  argv: readonly string[] = [],
): Promise<number> {
  let result: OneShotRunResult;
  try {
    if (argv.length > 0) {
      result = inputFailure();
    } else {
      const raw = await readBoundedStdin(io.stdin);
      const parsed = parseStrictJson(raw);
      result = validateOneShotRequest(parsed)
        ? await runOneShot(parsed, dependencies)
        : inputFailure();
    }
  } catch {
    result = inputFailure();
  }

  const output = boundedFrame(result.frame);
  io.stdout.write(output);
  if (!result.frame.ok) io.stderr.write(`pi-xai-one-shot: ${result.frame.error.code}\n`);
  return output.includes('"code":"internal_error"') ? EXIT_INTERNAL_ERROR : result.exitCode;
}

export async function main(): Promise<void> {
  const exitCode = await runOneShotCli(
    { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
    {
      auth: createPiGrokBuildAuth(),
      provider: DEFAULT_ONE_SHOT_PROVIDER,
      transport: DEFAULT_ONE_SHOT_TRANSPORT,
    },
    process.argv.slice(2),
  );
  process.exitCode = exitCode;
}
