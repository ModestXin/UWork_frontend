import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRootTraceContext,
  createSessionId,
  type MessageWithParts,
  type SessionProjection,
} from "@zcode/contracts";
import { zcodeSessionMessagesResultSchema } from "@zcode/shared";
import { mapSessionInfo } from "../../bootstrap/src/zcode-protocol/session-mapper.js";
import { readMessages } from "../../bootstrap/src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../../bootstrap/src/zcode-protocol/server-types.js";

const sessionId = createSessionId("controlled-session");
const workspace = { workspacePath: "/controlled", workspaceKey: "controlled" };
const projection = {
  mode: "build",
  status: "idle",
  createdAt: new Date(1),
  updatedAt: new Date(2),
} as SessionProjection;

test("active session mode follows the actual runtime instead of an empty event projection", () => {
  const mapped = mapSessionInfo({
    app: {
      sessionId,
      traceId: createRootTraceContext({ sessionId }).traceId,
      getMode: () => "yolo",
      getModel: () => "ucas/controlled$high",
    },
    projection,
    workspace,
  });
  assert.equal(mapped.mode, "yolo");
});

test("cold session mode still uses its stored projection without constructing a runtime", () => {
  assert.equal(
    mapSessionInfo({ projection: { ...projection, mode: "edit" }, workspace }).mode,
    "edit",
  );
  assert.equal(mapSessionInfo({ workspace }).mode, "build");
});

function context() {
  const messages = [
    {
      info: {
        id: "user-1",
        sessionID: sessionId,
        role: "user",
        agent: "controlled",
        time: { created: 1 },
      },
      parts: [
        {
          type: "text",
          id: "part-user-1",
          sessionID: sessionId,
          messageID: "user-1",
          text: "controlled original input",
        },
      ],
    },
    {
      info: {
        id: "assistant-1",
        sessionID: sessionId,
        role: "assistant",
        agent: "controlled",
        parentID: "user-1",
        providerId: "ucas",
        modelId: "controlled",
        mode: "yolo",
        path: { cwd: "/controlled", root: "/controlled" },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 2 },
      },
      parts: [
        {
          type: "tool",
          id: "part-tool",
          sessionID: sessionId,
          messageID: "assistant-1",
          callID: "controlled-call",
          tool: "CronCreate",
          state: {
            status: "completed",
            input: {},
            output: "controlled created",
            title: "controlled",
            time: { start: 2, end: 3 },
          },
        },
      ],
    },
    {
      info: {
        id: "user-2",
        sessionID: sessionId,
        role: "user",
        agent: "controlled",
        time: { created: 4 },
      },
      parts: [
        {
          type: "text",
          id: "part-user-2",
          sessionID: sessionId,
          messageID: "user-2",
          text: "controlled next input",
        },
      ],
    },
  ] as unknown as MessageWithParts[];
  return {
    sessions: new Map([
      [sessionId, { app: { sessionId }, eventStore: { getEvents: async () => [] } }],
    ]),
    deps: { sessionStore: { messages: async () => messages, getSession: async () => null } },
  } as unknown as ZCodeProtocolAgentServerContext;
}

test("session/messages exposes the existing strict wire contract for stored Core user and tool messages", async () => {
  const result = zcodeSessionMessagesResultSchema.parse(
    await readMessages(context(), { sessionId }),
  );
  assert.deepEqual(
    result.messages.map((message) => message.info.messageId),
    ["user-1", "assistant-1", "user-2"],
  );
  const part = result.messages[1]!.parts[0]!;
  assert.equal(part.type, "tool");
  assert.ok(part.type === "tool");
  assert.equal(part.callId, "controlled-call");
  assert.deepEqual(part.state, {
    status: "completed",
    input: {},
    output: "controlled created",
    title: "controlled",
    metadata: {},
    startedAt: 2,
    completedAt: 3,
  });
  assert.ok(
    result.messages.every(
      (message) => !Object.hasOwn(message.info, "sessionID") && !Object.hasOwn(message.info, "id"),
    ),
  );
});

test("wire mapping preserves afterMessageId and trailing limit pagination", async () => {
  const result = zcodeSessionMessagesResultSchema.parse(
    await readMessages(context(), { sessionId, afterMessageId: "user-1", limit: 1 }),
  );
  assert.deepEqual(
    result.messages.map((message) => message.info.messageId),
    ["user-2"],
  );
});
