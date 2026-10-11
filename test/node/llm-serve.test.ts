// The local model for the schema-drift triage (SPEC.md section 5): llama-server with the spec's flags on 127.0.0.1:8170,
// refused with a fix when the binary, the model or the port is missing, and wrangler dev switched to it per run.
import { describe, expect, it } from "vitest";
import { AI_MODES, wranglerDevArgs } from "../../scripts/dev.ts";
import { LOCAL_PORTS } from "../../scripts/lib/pids.ts";
import { DEFAULT_MODEL, llamaArgs, llmProblems } from "../../scripts/llm-serve.ts";

describe("npm run llm:serve", () => {
  it("starts llama-server with -np 1 -c 8192 -ngl 99 on 127.0.0.1:8170", () => {
    expect(LOCAL_PORTS.llm).toBe(8170);
    expect(llamaArgs("/m.gguf")).toEqual(["-np", "1", "-c", "8192", "-ngl", "99", "--host", "127.0.0.1", "--port", "8170", "-m", "/m.gguf"]);
    expect(DEFAULT_MODEL).toMatch(/Developer\/projects\/_models\/Qwen3-1\.7B-Q4_0-rtn\.gguf$/);
  });

  it("names every problem with its fix", () => {
    expect(llmProblems("/nowhere.gguf", false, true)).toEqual([
      "llama-server is not on PATH (brew install llama.cpp)",
      "model file not found: /nowhere.gguf (set PV_LLM_MODEL to its path)",
      "port 8170 is already in use; run `npm run stop:local`",
    ]);
  });
});

describe("wrangler dev AI mode", () => {
  it("keeps wrangler.jsonc's AI_MODE by default and overrides it for one run with --var", () => {
    expect(wranglerDevArgs()).not.toContain("--var");
    expect(wranglerDevArgs("llama-server").slice(-2)).toEqual(["--var", "AI_MODE:llama-server"]);
    expect(AI_MODES).toEqual(["stub", "llama-server"]);
  });
});
