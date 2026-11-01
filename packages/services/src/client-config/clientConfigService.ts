import {
  buildZCodeEndpointUrls,
  clientConfigReadOptionsSchema,
  parseClientConfigSnapshot,
  type ApiClient,
  type ClientConfigSnapshot,
  type UWorkClientPresentation,
} from "@zcode/shared";
import type { IClientConfigService } from "./clientConfig.js";

const CACHE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

interface RequestContext {
  endpointOrigin: string;
  appVersion: string;
  platform: string;
}

interface CacheEntry {
  snapshot?: ClientConfigSnapshot;
  expiresAt: number;
  pending?: Promise<ClientConfigSnapshot>;
}

/** 首期仅公开配置；账户灰度不得通过此实例或缓存复用。 */
export function createClientConfigService(dependencies: {
  apiClient: ApiClient;
  resolveRequestContext: () => RequestContext | Promise<RequestContext>;
  /**
   * 企业托管时用已发布的插件商店排序覆盖公开配置；未托管/未发布时保持公开配置，
   * 读取失败也不能让公开配置整体不可用。
   */
  readClientPresentation?: () => Promise<UWorkClientPresentation>;
}): IClientConfigService {
  const entries = new Map<string, CacheEntry>();

  async function withManagedOverlay(snapshot: ClientConfigSnapshot): Promise<ClientConfigSnapshot> {
    if (!dependencies.readClientPresentation) return snapshot;
    try {
      const view = await dependencies.readClientPresentation();
      if (view.status !== "ready" || view.pluginStore.status !== "ready") return snapshot;
      return {
        ...snapshot,
        pluginStoreOrder: structuredClone(view.pluginStore.data.order),
      };
    } catch {
      return snapshot;
    }
  }

  async function fetchSnapshot(url: URL): Promise<ClientConfigSnapshot> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Public client config request timed out"));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await dependencies.apiClient.request(url, {
            method: "GET",
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Public client config HTTP ${response.status}`);
          // 设置中的 endpoint 可能在两次 await 之间变化；不能把新地址的响应缓存到旧地址。
          if (response.url && response.url !== url.toString()) {
            throw new Error("Public client config request context changed");
          }
          return parseClientConfigSnapshot(await response.json());
        })(),
        timedOut,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    async getSnapshot(options = {}) {
      const { forceRefresh } = clientConfigReadOptionsSchema.parse(options);
      const context = await dependencies.resolveRequestContext();
      const url = new URL(
        "/api/v1/client/configs",
        buildZCodeEndpointUrls(context.endpointOrigin).origin,
      );
      url.searchParams.set("app_version", context.appVersion);
      url.searchParams.set("platform", context.platform);
      const key = url.toString();
      const entry = entries.get(key) ?? { expiresAt: 0 };
      entries.set(key, entry);
      if (!forceRefresh && entry.snapshot && entry.expiresAt > Date.now()) {
        return withManagedOverlay(structuredClone(entry.snapshot));
      }
      if (!entry.pending) {
        entry.pending = fetchSnapshot(url)
          .then((snapshot) => {
            entry.snapshot = snapshot;
            entry.expiresAt = Date.now() + CACHE_TTL_MS;
            return snapshot;
          })
          .finally(() => {
            entry.pending = undefined;
          });
      }
      return withManagedOverlay(structuredClone(await entry.pending));
    },
  };
}
