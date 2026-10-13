// npm run llm:serve [-- --detach]: llama-server with Qwen3-1.7B Q4_0 on 127.0.0.1:8170 for the local schema-drift
// triage (SPEC.md section 5: `-np 1 -c 8192 -ngl 99`), started as a detached process group with a pidfile, so
// `npm run stop:local` stops it. The model path can be overridden with PV_LLM_MODEL. Without --detach it waits for
// Ctrl+C and then stops the server.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOCAL_PORTS, portOpen, startGroup, stopAll, waitForHttp, waitForSignal } from "./lib/pids.ts";

export const DEFAULT_MODEL = path.join(os.homedir(), "Developer", "projects", "_models", "Qwen3-1.7B-Q4_0-rtn.gguf");

export function llamaArgs(model: string, port = LOCAL_PORTS.llm): string[] {
  return ["-np", "1", "-c", "8192", "-ngl", "99", "--host", "127.0.0.1", "--port", String(port), "-m", model];
}

/** Problems that stop llama-server from starting; empty when it can start. */
export function llmProblems(model: string, binaryFound: boolean, portBusy: boolean): string[] {
  const out: string[] = [];
  if (!binaryFound) out.push("llama-server is not on PATH (brew install llama.cpp)");
  if (!existsSync(model)) out.push(`model file not found: ${model} (set PV_LLM_MODEL to its path)`);
  if (portBusy) out.push(`port ${LOCAL_PORTS.llm} is already in use; run \`npm run stop:local\``);
  return out;
}

function onPath(bin: string): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir && existsSync(path.join(dir, bin)));
}

async function main(): Promise<void> {
  const model = process.env.PV_LLM_MODEL ?? DEFAULT_MODEL;
  const problems = llmProblems(model, onPath("llama-server"), await portOpen(LOCAL_PORTS.llm));
  if (problems.length) {
    for (const p of problems) console.error(`[llm:serve] ${p}`);
    process.exit(1);
  }
  startGroup("llama-server", "llama-server", llamaArgs(model), { port: LOCAL_PORTS.llm });
  if (!(await waitForHttp(`http://127.0.0.1:${LOCAL_PORTS.llm}/health`, 180_000))) {
    await stopAll(5000, ["llama-server"]);
    console.error("[llm:serve] llama-server did not become healthy; see .dev/logs/llama-server.log");
    process.exit(1);
  }
  console.log(`[llm:serve] Qwen3-1.7B Q4_0 on http://127.0.0.1:${LOCAL_PORTS.llm} (stop with npm run stop:local)`);
  if (process.argv.includes("--detach")) return;
  const stop = async () => {
    await stopAll(5000, ["llama-server"]);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await waitForSignal();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
