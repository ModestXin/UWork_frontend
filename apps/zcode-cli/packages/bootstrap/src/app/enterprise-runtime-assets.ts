import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  EnterpriseToolAuthorizationPort,
  McpServerConfig,
  Model,
  TraceContext,
} from "@zcode/contracts";

interface RuntimeAssetContext {
  authorization?: EnterpriseToolAuthorizationPort;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  traceContext: TraceContext;
}
export type ModelDispatchGuard = ((
  url: string,
  signal?: AbortSignal | null,
) => Promise<boolean>) & {
  scope(): <T>(operation: () => T) => T;
  getOwnerKey(): string | undefined;
};

/** 唯一Host端口逐次裁决；这里不保存允许快照、身份或另一份Provider/MCP状态。 */
export function createRuntimeAssetGuards(context: RuntimeAssetContext) {
  if (!context.authorization) return undefined;
  const modelOwner = new AsyncLocalStorage<{ ownerKey?: string; managed?: boolean }>();
  const authorize = async (
    permission: "model_request" | "personal_connector" | "mcp",
    url?: string,
    signal?: AbortSignal | null,
  ) => {
    // 只传裁决所需origin/path；供应商查询参数可能含Key/OAuth code，不能进入反向RPC。
    let target: string | undefined;
    if (url !== undefined) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("enterprise_runtime_target_invalid");
      }
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      )
        throw new Error("enterprise_runtime_target_invalid");
      target = `${parsed.origin}${parsed.pathname}`;
    }
    const decision = await context.authorization!.authorize(
      {
        toolName: permission === "model_request" ? "ModelRequest" : "McpDispatch",
        toolCallId: randomUUID(),
        sessionId: context.sessionId,
        workspacePath: context.workspacePath,
        ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
        workingDirectory: context.workspacePath,
        phase: "before_dispatch",
        input: target ? { url: target } : {},
        capability: { permission, sideEffectScope: "network", readOnly: false, destructive: false },
        traceContext: context.traceContext,
      },
      signal ?? undefined,
    );
    signal?.throwIfAborted();
    if (!decision.allowed) throw new Error(decision.code);
    const managed = decision.code !== "not_managed";
    if (managed && permission !== "mcp" && !decision.ownerKey)
      throw new Error("enterprise_policy_unavailable");
    const bound = modelOwner.getStore();
    if (bound) {
      if (bound.managed !== undefined && bound.managed !== managed)
        throw new Error("enterprise_identity_changed");
      bound.managed = managed;
      if (bound.ownerKey && bound.ownerKey !== decision.ownerKey)
        throw new Error("enterprise_identity_changed");
      bound.ownerKey = decision.ownerKey;
    }
    return { managed, ownerKey: decision.ownerKey };
  };
  const model: ModelDispatchGuard = Object.assign(
    async (url: string, signal?: AbortSignal | null) =>
      (await authorize("model_request", url, signal)).managed,
    {
      scope: () => {
        const owner = {};
        return <T>(operation: () => T) => modelOwner.run(owner, operation);
      },
      getOwnerKey: () => {
        const owner = modelOwner.getStore();
        return owner?.managed === true ? owner.ownerKey : undefined;
      },
    },
  );
  return {
    model,
    connector: (config: McpServerConfig, url?: string, signal?: AbortSignal | null) =>
      // source只能由Host注册；公共文件/Renderer schema拒绝它，未知来源按个人服务器处理。
      authorize(config.source?.kind === "builtin" ? "mcp" : "personal_connector", url, signal),
  };
}

export function withModelResultAuthorization(
  model: Model,
  url: string,
  guard?: ModelDispatchGuard,
): Model {
  if (!guard) return model;
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    properties: model.properties,
    optionSpecs: model.optionSpecs,
    options: model.options,
    bind: (options) => withModelResultAuthorization(model.bind(options), url, guard),
    async generateText(request) {
      return guard.scope()(async () => {
        await guard(url, request.abortSignal);
        const result = await model.generateText(request);
        await guard(url, request.abortSignal);
        return result;
      });
    },
    async *streamText(request) {
      const scoped = guard.scope();
      await scoped(() => guard(url, request.abortSignal));
      const iterator = scoped(() => model.streamText(request)[Symbol.asyncIterator]());
      try {
        for (;;) {
          const next = await scoped(() => iterator.next());
          await scoped(() => guard(url, request.abortSignal));
          if (next.done) break;
          yield next.value;
        }
      } finally {
        await scoped(() => iterator.return?.());
      }
    },
  };
}
