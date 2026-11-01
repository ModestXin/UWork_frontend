import { Client, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";
import type {
  EnterpriseConnectorPort,
  EnterpriseConnectorReleaseRequest,
  EnterpriseSkillsCatalogPort,
  EnterpriseToolAuthorizationPort,
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpContentBlock,
  McpPort,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
  TraceContext,
} from "@zcode/contracts";
import type { EnterpriseConnectorReference } from "@zcode/shared";
import { normalizeMcpToolDescriptor } from "./descriptor.js";

/** 目录/准入/连接的统一上限；比 Host 的 45 秒晚，让 Host 先形成确定结果。 */
const OPERATION_TIMEOUT_MS = 70000;
const TOOL_TIMEOUT_MS = 60000;
/** 预留命名空间：企业连接器永远不出现在用户可配置的 server 名里。 */
const SERVER_PREFIX = "enterprise-";

export interface EnterpriseConnectorOwnerOptions {
  catalog?: EnterpriseSkillsCatalogPort;
  authorization?: EnterpriseToolAuthorizationPort;
  connectors?: EnterpriseConnectorPort;
  logger?: Logger;
  sessionId: string;
  signal?: AbortSignal;
  traceContext: TraceContext;
  workspaceIdentity?: string;
  workspacePath: string;
}

interface ConnectorState {
  client?: Client;
  error?: string;
  reference: EnterpriseConnectorReference;
  serverName: string;
  status: "connected" | "failed";
  tools: McpToolDescriptor[];
  transport?: EnterpriseConnectorTransport;
}

/**
 * 只承载 JSON-RPC 帧的单通道 transport：帧的唯一出口是企业连接器端口（反向 RPC）。
 * 这里不发任何网络请求，也没有远端地址或后端凭据。
 */
class EnterpriseConnectorTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: (message: JSONRPCMessage, extra?: unknown) => void;
  sessionId?: string | undefined;
  private closed = false;

  constructor(private readonly sendFrame: (frame: unknown) => Promise<unknown>) {}

  async start(): Promise<void> {
    /* 无连接步骤：帧按需发送。 */
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("enterprise_connector_closed");
    const outcome = (await this.sendFrame(message)) as
      | { status: "ok"; frame?: unknown; mcpSessionId?: string }
      | { status: "denied"; code: string };
    if (outcome.status !== "ok") throw new Error(outcome.code);
    if (outcome.mcpSessionId) this.sessionId = outcome.mcpSessionId;
    // 通知没有响应体；有响应时同步派发，SDK 按 JSON-RPC id 关联。
    if (outcome.frame !== undefined && !this.closed) this.onmessage?.(outcome.frame as JSONRPCMessage);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

/**
 * 企业连接器接入既有 MCP 所有者：同一个 `McpPort`，同一套工具命名/审批/权限路径。
 *
 * 目录、准入与帧通道任一缺失即返回原始 port（独立 CLI 保持原行为）；受管模式下
 * 拒绝/取消/超时只会少一个 server，不会回退到未受管语义，也不留描述缓存。
 */
export function withEnterpriseConnectorServers(
  port: McpPort,
  options: EnterpriseConnectorOwnerOptions,
): McpPort {
  const { authorization, catalog, connectors } = options;
  if (!authorization || !catalog || !connectors) return port;
  const logger = options.logger;
  const states = new Map<string, ConnectorState>();
  const rootTrace = options.traceContext;
  let ownerKey: string | undefined;
  let ready = false;
  let connectTask: Promise<void> | undefined;
  let disposed = false;

  const signalFor = (extra?: AbortSignal): AbortSignal =>
    AbortSignal.any([
      AbortSignal.timeout(OPERATION_TIMEOUT_MS),
      ...(options.signal ? [options.signal] : []),
      ...(extra ? [extra] : []),
    ]);
  const admit = (reference: EnterpriseConnectorReference, signal: AbortSignal) =>
    authorization.authorize(
      {
        toolName: "EnterpriseConnectorLoad",
        toolCallId: crypto.randomUUID(),
        sessionId: options.sessionId,
        workspacePath: options.workspacePath,
        ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
        workingDirectory: options.workspacePath,
        // 连接器没有可落盘正文：逐次准入即“当前目录绑定 + 当前身份”双查。
        phase: "asset_load",
        ownerKey: ownerKey!,
        input: {},
        asset: { asset: { ...reference.asset } },
        capability: {
          permission: "mcp",
          sideEffectScope: "none",
          readOnly: true,
          destructive: false,
          assetGuarded: true,
        },
        traceContext: { ...rootTrace },
      },
      signal,
    );
  const closeState = async (state: ConnectorState): Promise<void> => {
    const transport = state.transport;
    const client = state.client;
    state.client = undefined;
    state.transport = undefined;
    if (client) await client.close().catch(() => undefined);
    if (transport) await transport.close().catch(() => undefined);
  };
  const releaseState = async (state: ConnectorState): Promise<void> => {
    const mcpSessionId = state.transport?.sessionId;
    await closeState(state);
    if (!mcpSessionId || !ownerKey) return;
    // 释放失败不阻断本地清理：后端会话最长 1 小时自然过期，本地不再持有它。
    const request: EnterpriseConnectorReleaseRequest = {
      sessionId: options.sessionId,
      workspacePath: options.workspacePath,
      ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
      connector: state.reference,
      ownerKey,
      mcpSessionId,
      traceContext: { ...rootTrace },
    };
    await connectors.release(request, signalFor()).catch(() => undefined);
  };
  const dropAll = async (): Promise<void> => {
    const previous = [...states.values()];
    states.clear();
    await Promise.all(previous.map(releaseState));
  };
  const open = async (
    reference: EnterpriseConnectorReference,
    serverName: string,
    signal: AbortSignal,
  ): Promise<ConnectorState> => {
    const state: ConnectorState = { reference, serverName, status: "failed", tools: [] };
    const before = await admit(reference, signal);
    if (!before.allowed) return { ...state, error: before.code };
    let transport!: EnterpriseConnectorTransport;
    transport = new EnterpriseConnectorTransport((frame) =>
      connectors.request(
        {
          sessionId: options.sessionId,
          workspacePath: options.workspacePath,
          ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
          connector: reference,
          ownerKey: ownerKey!,
          frame,
          // 后端签发的会话标识由 transport 持有；每次往返原样回传。
          ...(transport.sessionId ? { mcpSessionId: transport.sessionId } : {}),
          traceContext: { ...rootTrace },
        },
        signalFor(),
      ),
    );
    // 后端代理只承载 legacy MCP 方法（initialize/tools/**），不做 modern era 探测。
    const client = new Client(
      { name: "uwork-enterprise-connector", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy" } },
    );
    state.client = client;
    state.transport = transport;
    try {
      await client.connect(transport as Transport);
      // 读取后再准入一次：连接期间被撤权的连接器不进入工具面。
      const after = await admit(reference, signal);
      if (!after.allowed) {
        await releaseState(state);
        return { ...state, error: after.code };
      }
      const listed = await client.listTools();
      state.tools = listed.tools
        .filter((tool) => typeof (tool as { name?: unknown })?.name === "string")
        .map((tool) => normalizeMcpToolDescriptor(serverName, tool, TOOL_TIMEOUT_MS, false));
      state.status = "connected";
      return state;
    } catch (error) {
      await releaseState(state);
      return { ...state, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const ensure = async (configured: Record<string, McpServerConfig>, extra?: AbortSignal) => {
    if (disposed) return;
    const signal = signalFor(extra);
    let value;
    try {
      value = await catalog.readCatalog(
        {
          sessionId: options.sessionId,
          workspacePath: options.workspacePath,
          ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
          traceContext: { ...rootTrace },
        },
        signal,
      );
    } catch {
      // 目录不可用不是“连接器为空”：保留已准入的连接，不把一次抖动当成撤权。
      return;
    }
    if (value.status !== "ready") {
      if (value.status === "denied")
        logger?.warn("Enterprise connector catalog denied", {
          code: value.code,
          module: "adapters.mcp.enterprise-connectors",
        });
      // 受管拒绝或未受管都不能沿用上一次的允许结果。
      ownerKey = undefined;
      await dropAll();
      return;
    }
    ownerKey = value.ownerKey;
    const desired = new Map<string, EnterpriseConnectorReference>();
    for (const reference of value.connectors) {
      const serverName = `${SERVER_PREFIX}${reference.asset.id}`;
      if (configured[serverName] !== undefined) {
        logger?.warn("Enterprise connector name collides with a configured server", {
          code: "enterprise_connector_name_conflict",
          module: "adapters.mcp.enterprise-connectors",
        });
        continue;
      }
      desired.set(serverName, reference);
    }
    const changed =
      desired.size !== states.size ||
      [...desired].some(([serverName, reference]) => {
        const state = states.get(serverName);
        return (
          !state ||
          state.status !== "connected" ||
          state.reference.asset.version !== reference.asset.version ||
          state.reference.asset.checksum !== reference.asset.checksum
        );
      });
    if (!changed) return;
    const previous = [...states.values()];
    states.clear();
    await Promise.all(previous.map(releaseState));
    for (const [serverName, reference] of desired) {
      const state = await open(reference, serverName, signal);
      if (disposed) {
        await releaseState(state);
        return;
      }
      states.set(serverName, state);
      if (state.status !== "connected")
        logger?.warn("Enterprise connector unavailable", {
          code: state.error ?? "enterprise_connector_unavailable",
          module: "adapters.mcp.enterprise-connectors",
        });
    }
  };
  const withConnect = async (
    configured: Record<string, McpServerConfig>,
    extra?: AbortSignal,
  ): Promise<void> => {
    if (disposed) return;
    if (connectTask) return connectTask;
    const task = ensure(configured, extra).finally(() => {
      if (connectTask === task) connectTask = undefined;
      ready = true;
    });
    connectTask = task;
    return task;
  };
  const statusSnapshot = (statuses: Record<string, McpServerStatus>) => {
    const next = { ...statuses };
    for (const [serverName, state] of states) {
      if (state.status !== "connected" || next[serverName]) continue;
      next[serverName] = {
        status: "connected",
        transport: "http",
        toolCount: state.tools.length,
        updatedAt: new Date().toISOString(),
      };
    }
    return next;
  };
  const connectedTools = (): McpToolDescriptor[] =>
    [...states.values()]
      .filter((state) => state.status === "connected")
      .flatMap((state) => state.tools);
  return {
    async connectConfiguredServers(servers, connectOptions) {
      // 连接器发现与用户 MCP 连接并行：慢的 stdio server 不能把企业目录读取拖到后面。
      const [result] = await Promise.all([
        port.connectConfiguredServers(servers, connectOptions),
        withConnect(servers, connectOptions?.signal),
      ]);
      // 连接器工具必须随连接快照一起返回：运行时就靠这份 tools 注册到 registry。
      return {
        statuses: statusSnapshot(result.statuses),
        tools: [...result.tools, ...connectedTools()],
      };
    },
    async connectServer(name, config, connectOptions) {
      const [status] = await Promise.all([
        port.connectServer(name, config, connectOptions),
        withConnect({ [name]: config }, connectOptions?.signal),
      ]);
      return statusSnapshot({ [name]: status })[name]!;
    },
    async disconnectServer(name) {
      const state = states.get(name);
      if (!state) return port.disconnectServer(name);
      states.delete(name);
      await releaseState(state);
      return {
        status: "disconnected",
        transport: "http",
        toolCount: 0,
        updatedAt: new Date().toISOString(),
      };
    },
    async pingServer(name, pingOptions) {
      const state = states.get(name);
      if (state) {
        if (state.status !== "connected" || !state.client) return false;
        try {
          await state.client.ping({ timeout: pingOptions?.timeoutMs ?? 5000 });
          return true;
        } catch {
          return false;
        }
      }
      return port.pingServer ? port.pingServer(name, pingOptions) : true;
    },
    async status() {
      const statuses = await port.status();
      if (!ready) await withConnect({});
      return statusSnapshot(statuses);
    },
    async listTools() {
      const tools = await port.listTools();
      if (!ready) await withConnect({});
      return [...tools, ...connectedTools()];
    },
    async callTool(request: McpCallToolRequest, callOptions?: McpCallToolOptions) {
      const state = states.get(request.serverName);
      if (!state || state.status !== "connected" || !state.client) {
        return port.callTool(request, callOptions);
      }
      const signal = callOptions?.signal
        ? signalFor(callOptions.signal)
        : signalFor();
      // 逐次准入：目录/身份/发布版本在两次调用之间变化都会被拒绝，不留允许缓存。
      const before = await admit(state.reference, signal);
      if (!before.allowed) throw new Error(before.code);
      const result: McpToolCallResult = await state.client.callTool(
        { name: request.toolName, arguments: request.arguments ?? {} },
        { signal, timeout: callOptions?.timeoutMs ?? TOOL_TIMEOUT_MS },
      );
      const after = await admit(state.reference, signal);
      if (!after.allowed) throw new Error(after.code);
      return {
        content: Array.isArray(result.content)
          ? (result.content as McpContentBlock[])
          : [{ type: "text", text: "" }],
        structuredContent: result.structuredContent,
        isError: typeof result.isError === "boolean" ? result.isError : undefined,
      };
    },
    async close() {
      disposed = true;
      await dropAll();
      await port.close();
    },
  };
}
