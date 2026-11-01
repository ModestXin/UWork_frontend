import { useEffect } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { ClientSceneConfig, IClientScenesService } from "@zcode/services";
import { createClientScenesVisibilityRecovery } from "@/hooks/clientScenesVisibilityRecovery.js";
import { useClientExperienceScope } from "./useClientExperienceScope.js";

const CLIENT_SCENES_RESOURCE_KEY = "client-scenes";
export const CLIENT_SCENES_DEDUPING_INTERVAL_MS = 10 * 60 * 1000;

const EMPTY_SCENES: ClientSceneConfig[] = [];
const serviceAuthorityIds = new WeakMap<IClientScenesService, number>();
let nextServiceAuthorityId = 1;
interface ClientScenesResourceAuthority {
  readers: Map<string, number>;
}
const visibilityAuthorities = new WeakMap<
  IClientScenesService,
  WeakMap<object, ClientScenesResourceAuthority>
>();
let visibilityRecovery: ReturnType<typeof createClientScenesVisibilityRecovery> | null = null;

function getServiceAuthorityId(service: IClientScenesService): number {
  const existing = serviceAuthorityIds.get(service);
  if (existing !== undefined) return existing;
  const next = nextServiceAuthorityId;
  nextServiceAuthorityId += 1;
  serviceAuthorityIds.set(service, next);
  return next;
}

function getVisibilityAuthority(
  service: IClientScenesService,
  cache: object,
): ClientScenesResourceAuthority {
  let cacheAuthorities = visibilityAuthorities.get(service);
  if (!cacheAuthorities) {
    cacheAuthorities = new WeakMap<object, ClientScenesResourceAuthority>();
    visibilityAuthorities.set(service, cacheAuthorities);
  }
  const existing = cacheAuthorities.get(cache);
  if (existing) return existing;
  const authority: ClientScenesResourceAuthority = { readers: new Map() };
  cacheAuthorities.set(cache, authority);
  return authority;
}

function getClientScenesVisibilityRecovery() {
  if (typeof document === "undefined") return null;
  visibilityRecovery ??= createClientScenesVisibilityRecovery(document);
  return visibilityRecovery;
}

export class ClientScenesBusinessError extends Error {
  readonly code: number;
  readonly responseMessage: string;

  constructor(code: number, responseMessage: string) {
    super(`Client Scenes returned business error ${code}: ${responseMessage}`);
    this.name = "ClientScenesBusinessError";
    this.code = code;
    this.responseMessage = responseMessage;
  }
}

export function isClientScenesBusinessError(error: unknown): error is ClientScenesBusinessError {
  return error instanceof ClientScenesBusinessError;
}

interface UseClientScenesResourceOptions {
  enabled?: boolean;
}

export function useClientScenesResource(
  clientScenesService: IClientScenesService,
  options: UseClientScenesResourceOptions = {},
) {
  const enabled = options.enabled ?? true;
  const authorityId = getServiceAuthorityId(clientScenesService);
  const scope = useClientExperienceScope("scenes");
  const { cache, mutate } = useSWRConfig();
  const visibilityAuthority = getVisibilityAuthority(clientScenesService, cache as object);
  const resource = useSWR<ClientSceneConfig[], Error>(
    enabled ? [CLIENT_SCENES_RESOURCE_KEY, authorityId, scope] : null,
    async () => {
      const response = await clientScenesService.list();
      if (response.code !== 0) {
        throw new ClientScenesBusinessError(response.code, response.msg);
      }
      return response.data;
    },
    {
      dedupingInterval: CLIENT_SCENES_DEDUPING_INTERVAL_MS,
      focusThrottleInterval: CLIENT_SCENES_DEDUPING_INTERVAL_MS,
      keepPreviousData: false,
      refreshInterval: 0,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      shouldRetryOnError: false,
    },
  );

  useEffect(() => {
    if (!enabled) return;
    const readers = visibilityAuthority.readers;
    readers.set(scope, (readers.get(scope) ?? 0) + 1);
    return () => {
      const remaining = (readers.get(scope) ?? 1) - 1;
      if (remaining > 0) {
        readers.set(scope, remaining);
        return;
      }
      readers.delete(scope);
      // 同一提交中的重挂/StrictMode 可能马上注册新 reader；不能由旧组件清掉共享数据。
      queueMicrotask(() => {
        if (readers.has(scope)) return;
        // 只在最后一个 reader 退休时清理原 scope。revalidate=false 会留下 FETCH 去重标记，
        // 导致新页面复用已被 mutation 退休的旧 promise，十分钟内既无数据也不重新请求。
        void mutate([CLIENT_SCENES_RESOURCE_KEY, authorityId, scope], undefined, {
          revalidate: true,
        });
      });
    };
  }, [authorityId, enabled, mutate, scope, visibilityAuthority]);

  useEffect(() => {
    if (!enabled) return;
    // macOS 点击关闭只 hide BrowserWindow，renderer 与 SWR 缓存不会销毁；
    // 重新 show 时若仍在去重窗口内，内建 focus revalidate 会继续复用旧 Scene。
    // hidden -> visible 必须绕过去重窗口强制重验，同时按 Service/cache authority 合并并发消费方。
    return getClientScenesVisibilityRecovery()?.subscribe(visibilityAuthority, () => {
      void resource.mutate().catch(() => undefined);
    });
  }, [enabled, resource.mutate, scope, visibilityAuthority]);

  return {
    scenes: enabled ? (resource.data ?? EMPTY_SCENES) : EMPTY_SCENES,
    loading: enabled && resource.data === undefined && resource.isLoading,
    revalidating: resource.isValidating,
    error: resource.error,
    revalidate: resource.mutate,
  };
}
