import { z } from "zod";
import type {
  UWorkBackendSession,
  UWorkBackendScope,
} from "../enterprise-identity/backendSessionContract.js";
import { uworkShareRequestLimits } from "../enterprise-identity/uworkShareRequests.js";
import {
  uworkSecuritySchema,
  UWorkBackendSessionError,
} from "../enterprise-identity/backendSessionContract.js";
import { ConversationShareClientError } from "./conversationShareHttpClient.js";

/** 仅 Host 内部能力：不携带 Token，也不提供任意 URL 或自定义头。 */
export interface ConversationShareManagedScope {
  readonly origin: string;
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
  request(
    path: string,
    body?: unknown,
    options?: { method?: "GET" | "POST" | "DELETE" },
  ): Promise<{ status: number; body: unknown }>;
}
export interface ConversationShareManagedTransport {
  run<T>(
    operation: (scope: ConversationShareManagedScope) => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<{ managed: false } | { managed: true; value: T }>;
}
export interface ConversationSharePublicationAuthorization {
  authorize(files: boolean, target?: string): Promise<AbortSignal | undefined>;
  /** 同一次 publication.run 的原 scope；不允许在中途重新捕获新身份。 */
  readonly managedScope?: ConversationShareManagedScope;
}
export interface ConversationSharePublicationPolicy {
  run<T>(
    operation: (authorization: ConversationSharePublicationAuthorization) => Promise<T>,
  ): Promise<T>;
}
const decisionSchema = z.object({
  allowed: z.literal(true),
  tenantId: z.string().min(1).max(256),
  security: uworkSecuritySchema,
  sharing: z
    .object({
      publish: z.enum(["disabled", "organization", "internet"]),
      collaborate: z.enum(["disabled", "organization", "internet"]),
      files: z.boolean(),
      wechat: z.boolean(),
      wecom: z.boolean(),
    })
    .strict(),
});
function denied(): never {
  throw new ConversationShareClientError({
    kind: "feature_disabled",
    message: "Enterprise sharing authorization is unavailable",
  });
}

/** 分享沿用同一身份所有者，不能把旧允许或 private 模式当成组织隔离证据。 */
function createPolicy(
  backend: UWorkBackendSession,
  organization: boolean,
): ConversationSharePublicationPolicy {
  return {
    async run(operation) {
      try {
        const result = await backend.run(async (scope) => {
          const authorization: ConversationSharePublicationAuthorization = {
            ...(organization ? { managedScope: bindShareScope(scope) } : {}),
            async authorize(files, target) {
              const response = await scope.request("/api/client/authorize", {
                action: "share",
                target: organization ? "organization" : "internet",
              });
              const parsed = decisionSchema.safeParse(response.body);
              if (
                response.status !== 200 ||
                !parsed.success ||
                parsed.data.tenantId !== scope.tenantId ||
                (organization
                  ? parsed.data.sharing.publish === "disabled"
                  : parsed.data.sharing.publish !== "internet") ||
                (files &&
                  (!parsed.data.sharing.files ||
                    (organization && !parsed.data.security.allowFilesystem)))
              )
                denied();
              if (target !== undefined) {
                let url: URL;
                try {
                  url = new URL(target);
                } catch {
                  denied();
                }
                if (
                  !["https:", "http:"].includes(url.protocol) ||
                  url.username ||
                  url.password ||
                  url.hash ||
                  (organization
                    ? url.origin !== scope.origin
                    : !parsed.data.security.allowNetwork ||
                      (parsed.data.security.allowedDomains.length > 0 &&
                        !parsed.data.security.allowedDomains.includes(url.hostname)))
                )
                  denied();
              }
              await scope.assertCurrent();
              return scope.signal;
            },
          };
          await authorization.authorize(false);
          const value = await operation(authorization);
          if (organization) await authorization.authorize(false);
          return value;
        });
        if (result.managed) return result.value;
        return await operation({
          async authorize() {
            // 未受管状态也逐次重查；发布中途切换到受管配置必须重新开始。
            const latest = await backend.run(async () => denied());
            if (latest.managed) denied();
            return undefined;
          },
        });
      } catch (error) {
        if (error instanceof UWorkBackendSessionError) denied();
        throw error;
      }
    },
  };
}

/** 既有公网受控 helper 保持原意；生产受管组织分享由下方单一 factory 组合。 */
export function createUWorkPublicationPolicy(
  backend: UWorkBackendSession,
): ConversationSharePublicationPolicy {
  return createPolicy(backend, false);
}
function bindShareScope(scope: UWorkBackendScope): ConversationShareManagedScope {
  return {
    origin: scope.origin,
    signal: scope.signal,
    assertCurrent: () => scope.assertCurrent(),
    request(path, body, options = {}) {
      const method = options.method ?? (body === undefined ? "GET" : "POST");
      if (!uworkShareRequestLimits(path, method)) denied();
      return scope.request(path, body, { method });
    },
  };
}
/** 原身份 owner 的两种生命周期端口，不存另一份会话或已接受策略。 */
export function createUWorkSharePorts(backend: UWorkBackendSession): {
  publicationPolicy: ConversationSharePublicationPolicy;
  managedTransport: ConversationShareManagedTransport;
} {
  return {
    publicationPolicy: createPolicy(backend, true),
    managedTransport: {
      async run(operation, options) {
        try {
          return await backend.run((scope) => operation(bindShareScope(scope)), options);
        } catch (error) {
          if (error instanceof UWorkBackendSessionError) {
            throw new ConversationShareClientError({
              kind:
                error.code === "enterprise_identity_changed"
                  ? "authentication_required"
                  : error.code.includes("limit")
                    ? "limit_exceeded"
                    : "feature_disabled",
              message: "Enterprise sharing is unavailable",
            });
          }
          throw error;
        }
      },
    },
  };
}
