import type { GatewayIdentitySource } from "./gatewayIdentityScope.js";
import type { UcasGatewayStore } from "./ucasGatewayStore.js";
import type { UcasGatewayProvisioningTarget } from "./contract.js";
import type {
  IdentitySessionRecord,
  IdentitySessionStore,
} from "../enterprise-identity/identitySessionStore.js";

export interface UcasGatewayServiceOptions extends Omit<GatewayIdentitySource, "readIdentitySession"> {
  readonly store: UcasGatewayStore;
  /**
   * 会话读取：新装配走 readIdentitySession；主干的 identitySessionStore 装配也继续支持，
   * 两者都不改身份 owner，只决定本次操作绑定哪个会话。
   */
  readonly readIdentitySession?: GatewayIdentitySource["readIdentitySession"];
  readonly provisioning: UcasGatewayProvisioningTarget;
  /**
   * 身份 owner 的写入闸门：本机副作用（Provider 写入）必须在锁内以最新会话提交，
   * 换账号/退出后的迟到结果不得写入（与 enterprise-gateway-provisioning 的既有口径一致）。
   */
  readonly identitySessionStore?: Pick<IdentitySessionStore, "read" | "withCurrentSession">;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly onDiagnostic?: (event: { readonly code: string; readonly reason: string }) => void;
}

type SessionStore = Pick<IdentitySessionStore, "read" | "withCurrentSession">;

/**
 * 网关服务的身份会话入口：新装配直接给 readIdentitySession，主干的 identitySessionStore
 * 装配也继续支持；两者都不改身份 owner，只决定本次操作绑定哪个会话。
 */
export function createGatewayIdentitySource(
  options: UcasGatewayServiceOptions,
): UcasGatewayServiceOptions & GatewayIdentitySource {
  return {
    ...options,
    readIdentitySession: async () =>
      options.readIdentitySession
        ? options.readIdentitySession()
        : ((await options.identitySessionStore?.read())?.session ?? null),
  };
}

export interface GatewayWriteAdmission {
  /** 读取本机身份记录；没有注入 store（测试/单 Host）时返回 null。 */
  readIdentityRecord(): Promise<IdentitySessionRecord | null>;
  /**
   * 本机写入（Provider 配置）在身份 owner 的锁内、以开始时捕获的会话提交：
   * 换账号/退出后的迟到结果不写入，返回 undefined 表示写入被拒绝。
   */
  admitWrite<T>(
    expected: IdentitySessionRecord | null,
    operation: () => Promise<T>,
  ): Promise<T | undefined>;
}

export function createGatewayWriteAdmission(
  store: SessionStore | undefined,
  isDisposed: () => boolean,
  now: () => number,
): GatewayWriteAdmission {
  return {
    readIdentityRecord: async () => (await store?.read()) ?? null,
    admitWrite(expected, operation) {
      if (!store || !expected) return operation();
      return store.withCurrentSession(expected, async (current) => {
        if (isDisposed() || !current.session || current.session.expiresAt <= now())
          return undefined;
        return operation();
      });
    },
  };
}
