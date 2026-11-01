import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSessionId,
  type EnterpriseToolAuthorizationRequest,
  type SkillPort,
} from "@zcode/contracts";
import { createToolRegistry } from "../src/tool/registry.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { skillToolEntry } from "../src/tool/handlers/skill.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";

test("core derives the Skill guard from the injected port, never from model input or MCP presentation", async () => {
  for (const mode of ["guarded", "raw", "mcp"] as const) {
    let reads = 0,
      hooks = 0;
    const observed: EnterpriseToolAuthorizationRequest[] = [];
    const port: SkillPort = {
      enterpriseAssetGuarded: mode !== "raw",
      async discoverSkills() {
        return { skills: [], diagnostics: [], totalDiscovered: 0 };
      },
      async loadSkill() {
        reads++;
        return {
          metadata: {
            name: "Controlled",
            qualifiedName: "enterprise:controlled",
            description: "Controlled",
            path: "/controlled/SKILL.md",
            directory: "/controlled",
            rootPath: "/controlled",
            scope: "admin",
            source: "remote",
            safeToAutoLoad: true,
            frontmatterKeys: [],
          },
          content: "Controlled body",
          baseDirectory: "/controlled",
          bytesRead: 15,
          sizeBytes: 15,
          truncated: false,
        };
      },
    };
    const registry = createToolRegistry();
    registry.register({
      ...skillToolEntry,
      metadata: {
        ...skillToolEntry.metadata,
        ...(mode === "mcp"
          ? { mcpPresentation: { serverName: "untrusted", toolName: "Skill" } }
          : {}),
      },
    });
    const executor = createToolExecutor({
      registry,
      skillPort: port,
      sessionId: createSessionId("controlled"),
      workingDirectory: "/controlled",
      workspaceRoot: "/controlled",
      mode: "yolo",
      emitEvent: async () => {},
      hookRunner: {
        async run() {
          hooks++;
          return { additionalContexts: [], permissionBehavior: "allow" };
        },
      },
      permissionService: new PermissionService(defaultPermissionConfig, {
        async authorize(request) {
          observed.push(request);
          return request.capability.assetGuarded === true &&
            request.capability.permission === "skill"
            ? { allowed: true, code: "allowed" }
            : { allowed: false, code: "enterprise_capability_unsupported" };
        },
      }),
    });
    const result = await executor.execute({
      id: "controlled",
      name: "Skill",
      input: { skill: "enterprise:controlled", assetGuarded: true },
    });
    assert.equal(result.success, mode === "guarded");
    assert.equal(reads, mode === "guarded" ? 1 : 0);
    assert.equal(hooks > 0, mode === "guarded");
    assert.equal(observed[0]!.capability.assetGuarded, mode === "guarded");
    if (mode === "mcp") assert.equal(observed[0]!.capability.permission, "mcp");
  }
});
