import { z } from "zod";
import {
  wecomIdentityConfigSchema,
  resolveWeComIdentityOrganization,
  type EnterpriseIdentitySession,
} from "@zcode/shared";
import type { EnterpriseIdentityAdapter } from "./contract.js";
import { readAuthResponse } from "./wecomIdentityAdapter.js";

export function createUWorkIdentityAdapter(
  rawConfig: unknown,
  fetchImpl: typeof fetch = fetch,
): EnterpriseIdentityAdapter {
  const config = wecomIdentityConfigSchema.parse(rawConfig);
  const issuerOrigin = new URL(config.apiBaseUrl).origin;
  const attempts = new Map<string, { proof: string; orgId: string }>();
  const send = async (
    path: string,
    method: string,
    signal: AbortSignal,
    body?: unknown,
    token?: string,
  ) => {
    const response = await fetchImpl(new URL(path, config.apiBaseUrl), {
      method,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Enterprise backend rejected request (${response.status})`);
    return response.status === 204 ? undefined : readAuthResponse(response);
  };
  const session = async (
    token: string,
    signal: AbortSignal,
    expectedOrg: string,
  ): Promise<EnterpriseIdentitySession> => {
    const me = z
      .object({
        user: z.object({ id: z.string(), name: z.string() }),
        tenant: z.object({ id: z.string() }),
        expiresAt: z.number().int().positive(),
      })
      .parse(await send("/api/auth/me", "GET", signal, undefined, token));
    if (me.tenant.id !== expectedOrg || me.expiresAt <= Date.now())
      throw new Error("Enterprise identity changed or expired");
    return {
      token,
      issuerOrigin,
      expiresAt: me.expiresAt,
      profile: {
        id: me.user.id,
        tenantId: me.tenant.id,
        provider: "wecom",
        displayName: me.user.name,
      },
    };
  };
  const claim = async (attemptId: string, signal: AbortSignal) => {
    const attempt = attempts.get(attemptId);
    if (!attempt) return null;
    const raw = z
      .object({ status: z.string(), token: z.string().optional() })
      .parse(
        await send(
          `/api/auth/wecom/attempts/${encodeURIComponent(attemptId)}/claim`,
          "POST",
          signal,
          { proof: attempt.proof },
        ),
      );
    if (!raw.token) return null;
    const result = await session(raw.token, signal, attempt.orgId);
    attempts.delete(attemptId);
    return result;
  };
  return {
    listOrganizations: () => config.organizations.map((o) => ({ id: o.orgId, label: o.label })),
    resolveOrganization: (orgId) => {
      const o = resolveWeComIdentityOrganization(config, orgId);
      return o ? { id: o.orgId, label: o.label } : undefined;
    },
    async start(signal, orgId) {
      const org = resolveWeComIdentityOrganization(config, orgId);
      if (!org) throw new Error("Enterprise organization not configured");
      // 新尝试替代旧尝试，避免过期记录按组织命中后遮蔽新二维码的回调。
      const previous = [...attempts.entries()];
      attempts.clear();
      await Promise.allSettled(
        previous.map(([id, attempt]) =>
          send(`/api/auth/wecom/attempts/${encodeURIComponent(id)}/cancel`, "POST", signal, {
            proof: attempt.proof,
          }),
        ),
      );
      signal.throwIfAborted();
      const raw = z
        .object({
          id: z.string(),
          proof: z.string(),
          authorizeUrl: z.string().url(),
          expiresAt: z.number().int(),
        })
        .parse(await send("/api/auth/wecom/attempts", "POST", signal, { tenantId: org.orgId }));
      const callbackUrl = new URL("/api/auth/wecom/callback", config.apiBaseUrl).href;
      const authorize = new URL(raw.authorizeUrl);
      // 生产只接受企微官方授权域；本机回环控制面允许它自己托管授权页（开发态合成登录），
      // state 与 redirect_uri 的绑定、以及后续换 code 的会话签发仍按原合同校验。
      const controlPlane = new URL(config.apiBaseUrl);
      const devLoopback =
        controlPlane.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(controlPlane.hostname);
      const trustedOrigin =
        authorize.origin === "https://login.work.weixin.qq.com" ||
        (devLoopback && authorize.origin === controlPlane.origin);
      if (
        !trustedOrigin ||
        authorize.searchParams.get("state") !== raw.id ||
        authorize.searchParams.get("redirect_uri") !== callbackUrl
      )
        throw new Error("Enterprise authorization binding mismatch");
      attempts.set(raw.id, { proof: raw.proof, orgId: org.orgId });
      // 开发态合成授权由后台自己托管授权页并直接完成，没有可拦截的原生回调；
      // 省略 callbackUrl 让界面走"外部浏览器 + 轮询"路径，而不是挂起扫码视图。
      const syntheticAuthorize = devLoopback && authorize.origin === controlPlane.origin;
      return {
        id: raw.id,
        authorizationUrl: raw.authorizeUrl,
        ...(syntheticAuthorize ? {} : { callbackUrl }),
        expiresAt: raw.expiresAt,
      };
    },
    async poll(attemptId, signal) {
      const result = await claim(attemptId, signal);
      return result ? { status: "authenticated", session: result } : { status: "pending" };
    },
    async complete(code, signal, orgId) {
      const entry = [...attempts.entries()].find(([, a]) => a.orgId === orgId);
      if (!entry) throw new Error("Enterprise attempt missing");
      await send(
        `/api/auth/wecom/attempts/${encodeURIComponent(entry[0])}/complete`,
        "POST",
        signal,
        { proof: entry[1].proof, code },
      );
      const result = await claim(entry[0], signal);
      if (!result) throw new Error("Enterprise verification incomplete");
      return result;
    },
    async restore(previous, signal) {
      // 不透明会话不能像 JWT 那样自证 issuer；缺失绑定的旧会话须重新登录，不能试发给新地址。
      if (previous.issuerOrigin !== issuerOrigin) return null;
      try {
        return await session(previous.token, signal, previous.profile.tenantId);
      } catch (error) {
        if (error instanceof Error && /\(401\)|\(403\)/.test(error.message)) return null;
        throw error;
      }
    },
    async revoke(previous) {
      if (previous.issuerOrigin !== issuerOrigin) return;
      await send(
        "/api/auth/logout",
        "POST",
        new AbortController().signal,
        { revokeDevices: true },
        previous.token,
      );
    },
    async cancel(attemptId) {
      const attempt = attempts.get(attemptId);
      if (!attempt) return;
      attempts.delete(attemptId);
      await send(
        `/api/auth/wecom/attempts/${encodeURIComponent(attemptId)}/cancel`,
        "POST",
        new AbortController().signal,
        { proof: attempt.proof },
      );
    },
  };
}
