import type { IEnterpriseIdentityService } from "./contract.js";
import type { EnterpriseIdentitySession } from "@zcode/shared";
import type { ClientTurnPresentation } from "./clientPresentation.js";
import { UWorkBackendSessionError } from "./backendSessionContract.js";

const disposers = new WeakMap<IEnterpriseIdentityService, () => Promise<void>>();
export interface EnterpriseIdentityAuthority {
  readonly generation: number;
  readonly revision: number;
  readonly session: EnterpriseIdentitySession | null;
  readonly signal: AbortSignal;
}
const authorities = new WeakMap<IEnterpriseIdentityService, () => EnterpriseIdentityAuthority>();
const turnPresentationReaders = new WeakMap<
  IEnterpriseIdentityService,
  (signal?: AbortSignal) => Promise<ClientTurnPresentation>
>();

/** 原身份 owner 的有限私有读取能力，不存储配置、凭据，也不暴露为 Renderer RPC。 */
export function registerIdentityServiceTurnPresentationReader(
  service: IEnterpriseIdentityService,
  read: (signal?: AbortSignal) => Promise<ClientTurnPresentation>,
): void {
  turnPresentationReaders.set(service, read);
}

export async function readEnterpriseIdentityTurnPresentation(
  service: IEnterpriseIdentityService,
  signal?: AbortSignal,
): Promise<ClientTurnPresentation> {
  const read = turnPresentationReaders.get(service);
  const before = authorities.get(service)?.();
  if (!read || !before) throw new UWorkBackendSessionError("enterprise_identity_changed");
  const assertCurrent = () => {
    const current = authorities.get(service)?.();
    if (
      !current ||
      turnPresentationReaders.get(service) !== read ||
      before.generation !== current.generation ||
      before.revision !== current.revision ||
      before.signal !== current.signal ||
      before.signal.aborted
    )
      throw new UWorkBackendSessionError("enterprise_identity_changed");
    signal?.throwIfAborted();
  };
  assertCurrent();
  const combinedSignal = signal ? AbortSignal.any([before.signal, signal]) : before.signal;
  try {
    // 公共展示 getter 会把 issuer/config 失效降级为 unavailable；turn 必须借原私有 reader 保留失败。
    const presentation = await read(combinedSignal);
    assertCurrent();
    return presentation;
  } catch (error) {
    assertCurrent();
    throw error;
  }
}

/** Node 内部端口：同步读取所有者的撤销代际，不经过可能仍待写入的持久化会话。 */
export function registerIdentityServiceAuthority(
  service: IEnterpriseIdentityService,
  read: () => EnterpriseIdentityAuthority,
): void {
  authorities.set(service, read);
}
export function readEnterpriseIdentityAuthority(
  service: IEnterpriseIdentityService,
): EnterpriseIdentityAuthority | undefined {
  return authorities.get(service)?.();
}

/** 只释放仍属于该 promise 的单次操作引用，不让迟到任务清掉较新的操作。 */
export function releaseIdentityOperation<T>(task: Promise<T>, release: () => void): Promise<T> {
  void task.finally(release).catch(() => {});
  return task;
}

/** 注册 Node owner 的资源回收，不能暴露为 Renderer RPC。 */
export function registerIdentityServiceDisposer(
  service: IEnterpriseIdentityService,
  dispose: () => Promise<void>,
): void {
  disposers.set(service, dispose);
}

export async function disposeEnterpriseIdentityService(
  service: IEnterpriseIdentityService,
): Promise<void> {
  // 先关闭新读取；原 disposer 同步撤销 owner signal，再等待持久化队列等资源释放。
  turnPresentationReaders.delete(service);
  try {
    await disposers.get(service)?.();
  } finally {
    disposers.delete(service);
    authorities.delete(service);
  }
}
