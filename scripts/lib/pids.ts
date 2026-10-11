// Process groups for local servers (SPEC.md section 5): each child is started detached (its own process group),
// recorded in .dev/pids/<name>.json, and stopped by signalling the whole group. No lsof: ports are checked with a TCP
// connect probe, so this behaves the same on macOS and on ubuntu-latest.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { REPO_ROOT } from "./run.ts";

export const PIDS_DIR = path.join(REPO_ROOT, ".dev", "pids");
export const LOGS_DIR = path.join(REPO_ROOT, ".dev", "logs");
export const LOCAL_PORTS = { worker: 8793, inspector: 9243, shim: Number(process.env.PV_SHIM_PORT ?? 8893), llm: 8170 } as const;

export interface PidFile {
  name: string;
  pid: number;
  pgid: number;
  port: number | null;
  startedAt: string;
}

export function startGroup(name: string, cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; port?: number | null; cwd?: string } = {}): ChildProcess {
  mkdirSync(PIDS_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
  const log = openSync(path.join(LOGS_DIR, `${name}.log`), "a");
  const child = spawn(cmd, args, { cwd: opts.cwd ?? REPO_ROOT, env: opts.env ?? process.env, detached: true, stdio: ["ignore", log, log] });
  if (!child.pid) throw new Error(`could not start ${name}`);
  const rec: PidFile = { name, pid: child.pid, pgid: child.pid, port: opts.port ?? null, startedAt: new Date().toISOString() };
  writeFileSync(path.join(PIDS_DIR, `${name}.json`), JSON.stringify(rec) + "\n");
  child.unref();
  return child;
}

export function readPidFiles(): PidFile[] {
  if (!existsSync(PIDS_DIR)) return [];
  return readdirSync(PIDS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(PIDS_DIR, f), "utf8")) as PidFile);
}

function alive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM, then SIGKILL after a grace period, for every recorded process group (or only the named ones); removes
 * their pidfiles. */
export async function stopAll(graceMs = 5000, only: string[] | null = null): Promise<string[]> {
  const stopped: string[] = [];
  for (const p of readPidFiles()) {
    if (only && !only.includes(p.name)) continue;
    if (alive(p.pgid)) {
      try {
        process.kill(-p.pgid, "SIGTERM");
      } catch {
        // already gone
      }
      const until = Date.now() + graceMs;
      while (alive(p.pgid) && Date.now() < until) await sleep(100);
      if (alive(p.pgid)) {
        try {
          process.kill(-p.pgid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      stopped.push(p.name);
    }
    rmSync(path.join(PIDS_DIR, `${p.name}.json`), { force: true });
  }
  return stopped;
}

/** True when something accepts TCP connections on 127.0.0.1:<port>. */
export function portOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export async function waitForHttp(url: string, timeoutMs = 60000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  return false;
}
