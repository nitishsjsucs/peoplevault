// Spawn helper: never uses a shell, captures output, optional retries. Same behavior on macOS and Linux.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  allowFail?: boolean;
  quiet?: boolean;
  retries?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  readonly cmd: string;
  readonly result: RunResult;
  constructor(cmd: string, result: RunResult) {
    super(`${cmd} exited with ${result.code}`);
    this.name = "CommandError";
    this.cmd = cmd;
    this.result = result;
  }
}

function runOnce(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? REPO_ROOT,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** Runs a command (no shell). The display string never includes arguments, so secrets in argv are not logged. */
export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const attempts = (opts.retries ?? 0) + 1;
  let last: RunResult = { code: 1, stdout: "", stderr: "" };
  for (let i = 0; i < attempts; i++) {
    last = await runOnce(cmd, args, opts);
    if (last.code === 0) return last;
  }
  if (!opts.allowFail) throw new CommandError(path.basename(cmd), last);
  return last;
}

/** Local wrangler binary (no global wrangler is assumed). */
export function wranglerBin(): string {
  const bin = path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  if (!existsSync(bin)) throw new Error("wrangler is not installed; run `npm ci`");
  return bin;
}

/** Every Worker var and secret name of wrangler.jsonc (both configs declare the same var names). */
export function workerEnvNames(): Set<string> {
  const text = readFileSync(path.join(REPO_ROOT, "wrangler.jsonc"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  const cfg = JSON.parse(text) as { vars?: Record<string, string>; secrets?: { required?: string[] } };
  return new Set([...Object.keys(cfg.vars ?? {}), ...(cfg.secrets?.required ?? [])]);
}

/** Environment for wrangler children: drops every Worker var or secret name so wrangler dev never reads them
 * from process.env (with `secrets` defined, wrangler dev reads listed keys from the environment). */
export function wranglerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const blocked = workerEnvNames();
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!blocked.has(k)) out[k] = v;
  return { ...out, WRANGLER_SEND_METRICS: "false", CI: "true", ...extra };
}

export async function wrangler(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(wranglerBin(), args, { ...opts, env: opts.env ?? wranglerEnv() });
}

export async function pv(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run("uv", ["run", "--project", "pipelines", "pv", ...args], opts);
}

export function parseJsonOutput<T>(stdout: string): T {
  const start = stdout.search(/[[{]/);
  if (start < 0) throw new Error("no JSON in command output");
  return JSON.parse(stdout.slice(start)) as T;
}
