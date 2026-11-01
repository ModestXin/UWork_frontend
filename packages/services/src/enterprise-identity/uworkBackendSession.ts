import type {
  UWorkBackendRequestOptions,
  UWorkBackendScope,
  UWorkBackendSession,
  UWorkBackendSessionOptions,
} from "./backendSessionContract.js";
import type { ApiRequestInit } from "@zcode/shared";
import { createUWorkModelStream } from "./uworkModelStream.js";
import { uworkShareRequestLimits } from "./uworkShareRequests.js";
import { createHash } from "node:crypto";
import { UWorkBackendSessionError } from "./backendSessionContract.js";
import type { EnterpriseIdentityAuthority } from "./identityServiceLifecycle.js";

const TIMEOUT_MS = 10000;
// 连接器 MCP 往返要等远端工具执行；仍封顶在 Host 与 CLI 各自时限之下。
const CONNECTOR_TIMEOUT_MS = 40000;
const SMALL_RESPONSE_BYTES = 65536;
const ASSET_BYTES = 1024 * 1024;
const CONNECTOR_BYTES = 1024 * 1024 + 65536;
const MAX_BODY_BYTES = 65536;
const CONNECTOR_BODY_BYTES = 262144;
const CONSOLE_BODY_BYTES = 600256;
const CONNECTOR_PATH = /^\/api\/client\/connectors\/[A-Za-z0-9_-]{1,80}\/rpc$/;
const CONNECTOR_SESSION_ID = /^[\x21-\x7e]{1,200}$/;
const fingerprint = (value: unknown) => JSON.stringify(value);
const error = (code = "enterprise_policy_unavailable") => new UWorkBackendSessionError(code);
function responseLimit(path: string): number {
  if (path === "/api/client/configuration") return ASSET_BYTES;
  if (path === "/api/client/assets") return ASSET_BYTES;
  if (/^\/api\/client\/assets\/[A-Za-z0-9_-]{1,80}\/download\?version=[1-9][0-9]{0,15}$/.test(path))
    return ASSET_BYTES + 4096;
  // 连接器没有可安装正文，只能经后端代理转发 MCP 帧；该路径的出口同样有界。
  if (CONNECTOR_PATH.test(path)) return CONNECTOR_BYTES;
  if (["/api/client/authorize", "/api/client/events"].includes(path)) return SMALL_RESPONSE_BYTES;
  if (/^\/api\/client\/menus\/(?:[A-Za-z0-9_.~-]|%[A-F0-9]{2}){1,1800}\/authorize$/.test(path))
    return SMALL_RESPONSE_BYTES;
  if (
    path === "/api/client/agents" ||
    path === "/api/client/runs" ||
    /^\/api\/client\/runs\?page=[1-9][0-9]{0,5}&pageSize=25$/.test(path)
  )
    return ASSET_BYTES;
  if (/^\/api\/client\/runs\/[A-Za-z0-9_-]{1,80}(?:\/cancel)?$/.test(path)) return ASSET_BYTES * 2;
  throw error();
}
function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return work();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (reason) => {
          signal.removeEventListener("abort", abort);
          reject(reason);
        },
      );
  });
}
async function readJson(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<unknown> {
  // 连接器会话回收是 204；空正文按 undefined 返回，由调用方按各自契约判断。
  if (!response.body) return undefined;
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const chunk = await abortable(() => reader.read(), signal);
      if (chunk.done) break;
      if ((bytes += chunk.value.byteLength) > maximum) {
        cancel();
        throw error("enterprise_response_limit");
      }
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    return bytes === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", cancel);
    try {
      reader.releaseLock();
    } catch {
      /* 未合作的 reader 不得延迟取消结果。 */
    }
  }
}

export function createUWorkBackendSession(
  options: UWorkBackendSessionOptions,
): UWorkBackendSession {
  const fetchImpl = options.fetchImpl ?? fetch;
  // 此 latch 不缓存允许结果，只阻止受管配置消失后回退为未受管。
  let managedProfileObserved = false;
  const capture = async (
    parent?: AbortSignal,
    traceId?: string,
  ): Promise<UWorkBackendScope | null> => {
    const captureSignal = AbortSignal.any([
      AbortSignal.timeout(TIMEOUT_MS),
      ...(parent ? [parent] : []),
    ]);
    let authority: EnterpriseIdentityAuthority | undefined;
    let token: string | undefined,
      tenantId: string | undefined,
      memberId: string | undefined,
      origin: string | undefined;
    const current = () => {
      try {
        const value = options.readAuthority();
        return (
          !!authority &&
          !!value &&
          !authority.signal.aborted &&
          !value.signal.aborted &&
          value.generation === authority.generation &&
          value.revision === authority.revision &&
          value.session?.token === token &&
          value.session?.issuerOrigin === origin &&
          value.session?.profile.tenantId === tenantId &&
          value.session?.profile.id === memberId &&
          (value.session?.expiresAt ?? 0) > Date.now()
        );
      } catch {
        return false;
      }
    };
    const sanitize = (reason: unknown) =>
      parent?.aborted
        ? error("enterprise_authorization_cancelled")
        : reason instanceof UWorkBackendSessionError
          ? reason
          : authority && !current()
            ? error("enterprise_identity_changed")
            : error();
    try {
      parent?.throwIfAborted();
      if (traceId !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(traceId)) throw error();
      const config = await abortable(options.resolveConfig, captureSignal);
      parent?.throwIfAborted();
      if (!config && managedProfileObserved) throw error("enterprise_configuration_changed");
      if (config?.backend !== "uwork") return null;
      managedProfileObserved = true;
      const endpoint = new URL(config.apiBaseUrl);
      if (
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.pathname !== "/" ||
        (endpoint.protocol !== "https:" &&
          !(
            endpoint.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
          ))
      )
        throw error();
      origin = endpoint.origin;
      authority = options.readAuthority();
      token = authority?.session?.token;
      tenantId = authority?.session?.profile.tenantId;
      memberId = authority?.session?.profile.id;
      if (
        !token ||
        !tenantId ||
        !memberId ||
        !current() ||
        (config.organizations &&
          !config.organizations.some((organization) => organization.orgId === tenantId))
      )
        throw error("enterprise_identity_changed");
      const configFingerprint = fingerprint(config);
      const signal = AbortSignal.any([authority!.signal, ...(parent ? [parent] : [])]);
      const assertCurrent = async (
        deadline = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      ) => {
        try {
          parent?.throwIfAborted();
          if (!current()) throw error("enterprise_identity_changed");
          if (fingerprint(await abortable(options.resolveConfig, deadline)) !== configFingerprint)
            throw error("enterprise_configuration_changed");
          const record = await abortable(options.readPersistedSession, deadline);
          if (
            record.revision !== authority!.revision ||
            record.session?.token !== token ||
            record.session?.issuerOrigin !== origin ||
            record.session?.profile.tenantId !== tenantId ||
            record.session?.profile.id !== memberId
          )
            throw error("enterprise_identity_changed");
          parent?.throwIfAborted();
          if (!current()) throw error("enterprise_identity_changed");
        } catch (reason) {
          throw sanitize(reason);
        }
      };
      await assertCurrent(AbortSignal.any([captureSignal, signal]));
      return {
        ownerKey: createHash("sha256")
          .update(
            JSON.stringify([
              origin,
              tenantId,
              memberId,
              authority!.generation,
              authority!.revision,
              configFingerprint,
            ]),
          )
          .digest("hex"),
        origin,
        tenantId,
        memberId,
        signal,
        isCurrent: () => !signal.aborted && current(),
        assertCurrent: () => assertCurrent(),
        async openModelStream(body, operationSignal) {
          if (Buffer.byteLength(body) > ASSET_BYTES) throw error("enterprise_request_limit");
          const requestSignal = AbortSignal.any([signal, operationSignal]);
          await assertCurrent(requestSignal);
          const response = await abortable(async () => {
            const target = new URL("/v1/chat/completions", endpoint);
            const init: ApiRequestInit = {
              method: "POST",
              redirect: "error",
              signal: requestSignal,
              // 代理/CA读取可等待；真实Host末端派发前再次检查同一身份，禁止迟到出口。
              beforeDispatch: async (url) => {
                if (url !== target.href) throw error("enterprise_model_target_invalid");
                await assertCurrent(requestSignal);
              },
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                ...(traceId ? { "x-zcode-trace-id": traceId } : {}),
              },
              body,
            };
            const value = await fetchImpl(target, init);
            if (requestSignal.aborted) {
              void value.body?.cancel().catch(() => {});
              requestSignal.throwIfAborted();
            }
            return value;
          }, requestSignal);
          try {
            await assertCurrent(requestSignal);
            return createUWorkModelStream({
              response,
              token: token!,
              signal: requestSignal,
              assertCurrent: () => assertCurrent(requestSignal),
            });
          } catch (reason) {
            void response.body?.cancel().catch(() => {});
            throw sanitize(reason);
          }
        },
        async request(path, body, options = {}) {
          try {
            const connector = CONNECTOR_PATH.test(path);
            const inboundSession = options.mcpSessionId;
            if (inboundSession !== undefined && !connector) throw error();
            if (inboundSession !== undefined && !CONNECTOR_SESSION_ID.test(inboundSession))
              throw error("enterprise_request_limit");
            const timeout = connector
              ? Math.min(options.timeoutMs ?? CONNECTOR_TIMEOUT_MS, CONNECTOR_TIMEOUT_MS)
              : TIMEOUT_MS;
            const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
            const method = options.method ?? (body === undefined ? "GET" : "POST");
            const shareLimits = uworkShareRequestLimits(path, method);
            const maximum = shareLimits?.responseBytes ?? responseLimit(path);
            const encoded = body === undefined ? undefined : JSON.stringify(body);
            if (
              encoded !== undefined &&
              Buffer.byteLength(encoded) >
                (shareLimits
                  ? shareLimits.requestBytes
                  : connector
                    ? CONNECTOR_BODY_BYTES
                    : path === "/api/client/runs"
                      ? CONSOLE_BODY_BYTES
                      : MAX_BODY_BYTES)
            )
              throw error("enterprise_request_limit");
            await assertCurrent(requestSignal);
            const response = await abortable(async () => {
              const value = await fetchImpl(new URL(path, endpoint), {
                method,
                redirect: "error",
                signal: requestSignal,
                headers: {
                  authorization: `Bearer ${token}`,
                  ...(encoded === undefined ? {} : { "content-type": "application/json" }),
                  ...(traceId ? { "x-zcode-trace-id": traceId } : {}),
                  // 连接器会话标识由后端签发，只允许恰好一个白名单请求头。
                  ...(inboundSession ? { "mcp-session-id": inboundSession } : {}),
                },
                body: encoded,
              });
              if (requestSignal.aborted) {
                void value.body?.cancel().catch(() => {});
                requestSignal.throwIfAborted();
              }
              return value;
            }, requestSignal);
            const outboundSession = response.headers.get("mcp-session-id") ?? undefined;
            if (outboundSession !== undefined && !CONNECTOR_SESSION_ID.test(outboundSession))
              throw error("enterprise_response_limit");
            const result = await readJson(response, maximum, requestSignal);
            // 空正文（连接器通知的 202/204）没有可回显的内容；
            // JSON.stringify(undefined) 会返回 undefined，不能直接当字符串判定。
            const serialized = result === undefined ? "" : JSON.stringify(result);
            // 私有身份 Token 不能因服务端回显进入资产内容、调用者或日志边界。
            if (token && serialized.includes(token)) throw error("enterprise_response_private");
            if (inboundSession && serialized.includes(inboundSession))
              throw error("enterprise_response_private");
            await assertCurrent(requestSignal);
            return {
              status: response.status,
              body: result,
              ...(outboundSession ? { mcpSessionId: outboundSession } : {}),
            };
          } catch (reason) {
            throw sanitize(reason);
          }
        },
      };
    } catch (reason) {
      throw sanitize(reason);
    }
  };
  return {
    async run(operation, context = {}) {
      const scope = await capture(context.signal, context.traceId);
      if (!scope) return { managed: false };
      const value = await operation(scope);
      await scope.assertCurrent();
      return { managed: true, value };
    },
  };
}
