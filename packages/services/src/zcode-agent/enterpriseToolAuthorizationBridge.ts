import {
  zcodeEnterpriseToolAuthorizationParamsSchema,
  zcodeEnterpriseToolAuthorizationCancelledSchema,
  zcodeEnterpriseToolAuthorizationResultSchema,
  zcodeEnterpriseSkillsCatalogParamsSchema,
  zcodeEnterpriseConnectorParamsSchema,
  zcodeEnterpriseModelRequestParamsSchema,
  zcodeEnterpriseModelRequestResultSchema,
  type ZCodeEnterpriseModelRequestResult,
  zcodeEnterpriseConnectorResultSchema,
  enterpriseSkillsCatalogSchema,
  type EnterpriseSkillsCatalog,
  type ZCodeEnterpriseConnectorResult,
  type ZCodeEnterpriseToolAuthorizationParams,
  type ZCodeEnterpriseToolAuthorizationResult,
  type ZCodeProtocolRequestId,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import type { EnterpriseConnectorRelay } from "../enterprise-assets/connectorRelay.js";
import type { EnterpriseAssetsHost } from "../enterprise-assets/hostContract.js";

import type { EnterpriseModelRelay } from "../enterprise-model-relay/relay.js";

type Client = Pick<ZCodeProtocolClient, "respond" | "respondError" | "isDisposed" | "onClose"> &
  Partial<Pick<ZCodeProtocolClient, "disposeSignal">>;
export interface EnterpriseToolAuthorizationResolver {
  authorize(
    params: ZCodeEnterpriseToolAuthorizationParams,
    signal?: AbortSignal,
    traceId?: string,
  ): Promise<ZCodeEnterpriseToolAuthorizationResult>;
}
const denied = (code: string): ZCodeEnterpriseToolAuthorizationResult => ({ allowed: false, code });
interface RuntimeSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}
interface EnterpriseRequest {
  workspace: ZCodeWorkspaceRef;
  requestId: string;
  sessionId: string;
}
const modelWorkspaceKey = (workspace: ZCodeWorkspaceRef) =>
  JSON.stringify([
    workspace.workspaceIdentity?.trim() || workspace.workspacePath,
    workspace.workspaceKey,
    workspace.workspacePath,
  ]);
function sameWorkspace(left: ZCodeWorkspaceRef, right: ZCodeWorkspaceRef) {
  return (
    left.workspaceKey === right.workspaceKey &&
    left.workspacePath === right.workspacePath &&
    (left.workspaceIdentity?.trim() ?? "") === (right.workspaceIdentity?.trim() ?? "")
  );
}

export function createEnterpriseToolAuthorizationBridge(options: {
  resolver?: EnterpriseToolAuthorizationResolver;
  isCurrent: (workspace: ZCodeWorkspaceRef, client: Client) => boolean;
  timeoutMs?: number;
  assets?: Pick<EnterpriseAssetsHost, "readCatalog"> &
    Partial<Pick<EnterpriseAssetsHost, "authorizeAsset">>;
  catalogTimeoutMs?: number;
  /** 连接器帧的唯一出口；缺失即整个连接器通道 fail closed。 */
  connectors?: EnterpriseConnectorRelay;
  connectorTimeoutMs?: number;
  models?: EnterpriseModelRelay;
}) {
  const clients = new WeakMap<
    Client,
    Map<string, { sessionId: string; controller: AbortController }>
  >();
  const handle = async <Request extends EnterpriseRequest, Result>(
    client: Client,
    workspace: ZCodeWorkspaceRef,
    id: ZCodeProtocolRequestId,
    input: unknown,
    settings: {
      params: RuntimeSchema<Request>;
      result: RuntimeSchema<Result>;
      deny: (code: string) => Result;
      timeoutMs: number;
      perform: (request: Request, signal: AbortSignal) => Promise<Result> | Result;
    },
  ) => {
    const parsed = settings.params.safeParse(input);
    if (!parsed.success) {
      await client.respondError(id, {
        code: -32602,
        message: "Invalid enterprise interaction request",
      });
      return;
    }
    const request = parsed.data;
    if (!sameWorkspace(request.workspace, workspace)) {
      await client.respond(id, settings.deny("enterprise_workspace_mismatch"));
      return;
    }
    if (client.isDisposed || !options.isCurrent(workspace, client)) {
      await client.respond(id, settings.deny("enterprise_runtime_obsolete"));
      return;
    }
    let pending = clients.get(client);
    if (!pending) {
      pending = new Map();
      clients.set(client, pending);
      const abortPending = () => {
        options.models?.closeRuntime(client);
        for (const entry of pending!.values()) entry.controller.abort("closed");
      };
      client.onClose(abortPending);
      client.disposeSignal?.addEventListener("abort", abortPending, { once: true });
    }
    if (pending.size >= 32 || pending.has(request.requestId)) {
      await client.respond(id, settings.deny("enterprise_policy_unavailable"));
      return;
    }
    const controller = new AbortController(),
      entry = { sessionId: request.sessionId, controller };
    pending.set(request.requestId, entry);
    const timer = setTimeout(() => controller.abort("deadline"), settings.timeoutMs);
    let abort!: () => void;
    const cancelled = new Promise<Result>((resolve) => {
      abort = () => resolve(settings.deny("enterprise_authorization_cancelled"));
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const work = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return settings.perform(request, controller.signal);
        })
        .catch(() => settings.deny("enterprise_policy_unavailable"));
      const result = await Promise.race([work, cancelled]);
      const valid = settings.result.safeParse(result);
      const response =
        client.isDisposed || !options.isCurrent(workspace, client)
          ? settings.deny("enterprise_runtime_obsolete")
          : controller.signal.aborted
            ? settings.deny("enterprise_authorization_cancelled")
            : valid.success
              ? valid.data
              : settings.deny("enterprise_policy_unavailable");
      if (client.isDisposed || !options.isCurrent(workspace, client))
        options.models?.closeRuntime(client);
      try {
        await client.respond(id, response);
      } catch (error) {
        // open回执写入失败时CLI拿不到streamId，须按原请求关闭，不能只等TTL。
        options.models?.cancelRequest({
          runtime: client,
          workspaceKey: modelWorkspaceKey(workspace),
          sessionId: request.sessionId,
          requestId: request.requestId,
        });
        throw error;
      }
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      if (pending.get(request.requestId) === entry) pending.delete(request.requestId);
    }
  };
  return {
    handle(
      client: Client,
      workspace: ZCodeWorkspaceRef,
      id: ZCodeProtocolRequestId,
      input: unknown,
      traceId?: string,
    ) {
      return handle(client, workspace, id, input, {
        params: zcodeEnterpriseToolAuthorizationParamsSchema,
        result: zcodeEnterpriseToolAuthorizationResultSchema,
        deny: denied,
        timeoutMs: options.timeoutMs ?? 12000,
        perform: (request, signal) => {
          if (request.phase === "asset_load") {
            if (!traceId || !/^[A-Za-z0-9._:-]{1,128}$/.test(traceId))
              return denied("enterprise_trace_required");
            return (
              options.assets?.authorizeAsset?.(request.asset, traceId, signal, request.ownerKey) ??
              denied("enterprise_policy_unavailable")
            );
          }
          return (
            options.resolver?.authorize(request, signal, traceId) ??
            denied("enterprise_policy_unavailable")
          );
        },
      });
    },
    handleCatalog(
      client: Client,
      workspace: ZCodeWorkspaceRef,
      id: ZCodeProtocolRequestId,
      input: unknown,
      traceId?: string,
    ) {
      const deny = (code: string): EnterpriseSkillsCatalog => ({ status: "denied", code });
      return handle(client, workspace, id, input, {
        params: zcodeEnterpriseSkillsCatalogParamsSchema,
        result: enterpriseSkillsCatalogSchema,
        deny,
        timeoutMs: options.catalogTimeoutMs ?? 60000,
        perform: (_request, signal) =>
          !traceId || !/^[A-Za-z0-9._:-]{1,128}$/.test(traceId)
            ? deny("enterprise_trace_required")
            : (options.assets?.readCatalog(traceId, signal) ??
              deny("enterprise_policy_unavailable")),
      });
    },
    cancel(client: Client, workspace: ZCodeWorkspaceRef, input: unknown) {
      const parsed = zcodeEnterpriseToolAuthorizationCancelledSchema.safeParse(input);
      if (!parsed.success || !sameWorkspace(parsed.data.workspace, workspace)) return;
      options.models?.cancelRequest({
        runtime: client,
        workspaceKey: modelWorkspaceKey(workspace),
        sessionId: parsed.data.sessionId,
        requestId: parsed.data.requestId,
      });
      const entry = clients.get(client)?.get(parsed.data.requestId);
      if (entry?.sessionId === parsed.data.sessionId) entry.controller.abort("cancelled");
    },
    handleModel(
      client: Client,
      workspace: ZCodeWorkspaceRef,
      id: ZCodeProtocolRequestId,
      input: unknown,
      traceId?: string,
    ) {
      const deny = (code: string): ZCodeEnterpriseModelRequestResult => ({
        status: "denied",
        code,
      });
      return handle(client, workspace, id, input, {
        params: zcodeEnterpriseModelRequestParamsSchema,
        result: zcodeEnterpriseModelRequestResultSchema,
        deny,
        timeoutMs: 300000,
        perform: (request, signal) =>
          options.models?.request({
            runtime: client,
            workspaceKey: modelWorkspaceKey(workspace),
            requestId: request.requestId,
            sessionId: request.sessionId,
            request: request.request,
            signal,
            traceId,
          }) ?? deny("enterprise_policy_unavailable"),
      });
    },
    handleConnector(
      client: Client,
      workspace: ZCodeWorkspaceRef,
      id: ZCodeProtocolRequestId,
      input: unknown,
      traceId?: string,
    ) {
      const deny = (code: string): ZCodeEnterpriseConnectorResult => ({ status: "denied", code });
      return handle(client, workspace, id, input, {
        params: zcodeEnterpriseConnectorParamsSchema,
        result: zcodeEnterpriseConnectorResultSchema,
        deny,
        timeoutMs: options.connectorTimeoutMs ?? 45000,
        perform: (request, signal) => {
          if (!traceId || !/^[A-Za-z0-9._:-]{1,128}$/.test(traceId))
            return deny("enterprise_trace_required");
          const relay = options.connectors;
          if (!relay) return deny("enterprise_policy_unavailable");
          const base = {
            ownerKey: request.ownerKey,
            connector: request.connector,
            signal,
            traceId,
          };
          return request.request.kind === "release"
            ? relay.release({ ...base, mcpSessionId: request.request.mcpSessionId })
            : relay.request({
                ...base,
                frame: request.request.frame,
                ...(request.request.mcpSessionId
                  ? { mcpSessionId: request.request.mcpSessionId }
                  : {}),
              });
        },
      });
    },
  };
}
