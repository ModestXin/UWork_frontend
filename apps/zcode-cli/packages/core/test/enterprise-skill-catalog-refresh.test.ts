import assert from "node:assert/strict";
import { test } from "node:test";
import { createRootTraceContext, type SkillLoadOutcome } from "@zcode/contracts";
import { ensureContextInitialized, getSkillCatalog } from "../src/runtime/methods/context.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

function fixture(guarded: boolean) {
  const events: string[] = [];
  let discoveries = 0;
  const state = {
    config: {},
    contextInitialized: false,
    workingDirectory: "/controlled",
    skillPort: { enterpriseAssetGuarded: guarded },
    skillLoadOutcome: undefined,
    createConfigOnlyContextSnapshot: () => ({ workingDirectory: "/controlled" }),
    startMcpStartup: () => {
      events.push("mcp");
    },
    async discoverSkillsForContext(): Promise<SkillLoadOutcome> {
      discoveries++;
      events.push("skills");
      return { skills: [], diagnostics: [], totalDiscovered: 0 };
    },
    async loadProjectMemoryRoot() {
      events.push("memory");
      return undefined;
    },
    createContextBuilderFromSnapshot: () => ({}),
    initializeMessageHistoryFromContext: () => {},
    // 上下文初始化会保留既有运行条目再接回新历史；本夹具没有历史 owner，用空实现承接。
    messageHistory: {
      borrowReadOnlyRuntimeEntries: () => [],
      addEntries: () => {},
    },
    async ensureContextInitialized() {
      await ensureContextInitialized.call(runtime, trace);
    },
  };
  const runtime = state as unknown as AgentRuntimeInternal,
    trace = createRootTraceContext();
  return { runtime, trace, events, discoveries: () => discoveries };
}

test("a cold guarded composer catalog performs one discovery and later reads refresh once", async () => {
  for (const guarded of [false, true]) {
    const f = fixture(guarded);
    const first = await getSkillCatalog.call(f.runtime, f.trace);
    assert.equal(
      f.discoveries(),
      1,
      "initialization's current discovery is already this call's catalog",
    );
    assert.notEqual(first.skills, f.runtime.skillLoadOutcome!.skills);
    assert.deepEqual(f.events, guarded ? ["mcp", "memory", "skills"] : ["mcp", "skills", "memory"]);
    await getSkillCatalog.call(f.runtime, f.trace);
    assert.equal(f.discoveries(), guarded ? 2 : 1);
  }
});

test("guarded initial discovery follows other asynchronous context reads before becoming the catalog", async () => {
  const f = fixture(true);
  await getSkillCatalog.call(f.runtime, f.trace);
  assert.deepEqual(f.events, ["mcp", "memory", "skills"]);
});
