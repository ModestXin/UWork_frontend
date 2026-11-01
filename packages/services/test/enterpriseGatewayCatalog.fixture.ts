import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { createProviderRuntime } from "../src/model-provider/providerRuntime.js";
import { providerSettingsTrustedGatewayProvisioning } from "../src/model-provider/providerFacadeServices.js";
import {
  createEnterpriseIdentityService,
  disposeEnterpriseIdentityService,
} from "../src/enterprise-identity/enterpriseIdentityService.js";
import { readEnterpriseIdentityAuthority } from "../src/enterprise-identity/identityServiceLifecycle.js";
import { createUcasGatewayService } from "../src/ucas-gateway/ucasGatewayService.js";
import { gatewayCatalogAuthority } from "../src/ucas-gateway/gatewayCatalogLifecycle.js";
import type { UcasGatewayProvisioningTarget } from "../src/ucas-gateway/contract.js";

export const ORIGIN = "https://gateway.example.test";
export const MODEL = (slot: string) => `controlled-model-${slot}`;
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

/** Real Identity/Gateway/Writer/Registry; only credentials, HTTP and clock-independent replies are finite ports. */
export async function gatewayFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "uwork-catalog-revoke-"));
  const path = join(root, "personal.json");
  let runtime: ReturnType<typeof createProviderRuntime>;
  let slot = "A";
  const values = new Map<string, string>();
  const session = () => ({
    token: `synthetic-${slot}`,
    expiresAt: Date.now() + 300_000,
    issuerOrigin: ORIGIN,
    profile: {
      id: `member-${slot}`,
      tenantId: `tenant-${slot}`,
      provider: "wecom" as const,
      displayName: `Member ${slot}`,
    },
  });
  const identity = createEnterpriseIdentityService({
    credentials: {
      load: async (key) => values.get(key) ?? null,
      save: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
    },
    adapter: {
      listOrganizations: () => [{ id: "tenant-A" }, { id: "tenant-B" }],
      resolveOrganization: () => ({ id: `tenant-${slot}` }),
      start: async () => ({
        id: `attempt-${slot}`,
        authorizationUrl: `${ORIGIN}/login`,
        expiresAt: Date.now() + 60_000,
      }),
      poll: async () => ({ status: "authenticated", session: session() }),
      restore: async (current) => current,
      revoke: async () => {},
    },
  });
  type ApplyInput = Parameters<UcasGatewayProvisioningTarget["apply"]>[0];
  let beforeApply: (input: ApplyInput) => Promise<void | ApplyInput> = async () => {};
  let beforeModels: (slot: string) => Promise<void> = async () => {};
  let clearFailed = false;
  let completedClears = 0;
  const applied: Array<Parameters<UcasGatewayProvisioningTarget["apply"]>[0]> = [];
  const target: UcasGatewayProvisioningTarget = {
    async apply(input) {
      applied.push(input);
      const forwarded = (await beforeApply(input)) ?? input;
      try {
        if (clearFailed && input.clearManagedCatalog) throw Error("controlled-clear-failure");
        return await runtime.providerSettings[providerSettingsTrustedGatewayProvisioning](
          forwarded,
        );
      } finally {
        if (input.clearManagedCatalog) completedClears++;
      }
    },
    async listModels() {
      return (
        (await runtime.modelSelection.getView()).providers
          .find((p) => p.providerId === "ucas")
          ?.models.map((m) => m.modelId) ?? []
      );
    },
  };
  const gateway = createUcasGatewayService({
    store: { read: async () => null, write: async () => {} },
    provisioning: target,
    readIdentitySession: async () => readEnterpriseIdentityAuthority(identity)?.session ?? null,
    readIdentityAuthority: () => readEnterpriseIdentityAuthority(identity),
    subscribeIdentityChanges: (listener) => identity.onDidChange(listener),
    resolveBackend: async () => "uwork",
    resolveApiBaseUrl: async () => ORIGIN,
    fetchImpl: async (input, init) => {
      const key = String(new Headers(init?.headers).get("authorization")).endsWith("-B")
        ? "B"
        : "A";
      const pathname = new URL(String(input)).pathname;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (pathname === "/api/auth/me")
        return json({
          user: { id: `member-${key}`, name: `Member ${key}`, email: null },
          tenant: { id: `tenant-${key}` },
          role: "member",
        });
      if (pathname === "/v1/models") {
        await beforeModels(key);
        return json({
          data: [
            {
              id: MODEL(key),
              name: `Model ${key}`,
              context_window: 128000,
              max_output_tokens: 16,
              supports_vision: false,
              supports_reasoning: false,
              supports_tools: false,
            },
          ],
        });
      }
      if (pathname === "/api/client/entitlement")
        return json({
          unit: "credits",
          planId: key,
          planTitle: `Plan ${key}`,
          amountTotal: 100,
          amountUsed: 0,
          nextResetTime: null,
          status: "active",
        });
      if (pathname === "/api/client/usage")
        return json({
          unit: "credits",
          period: "month",
          metric: "requests",
          from: "2026-10-01",
          until: "2026-10-19",
          summary: {
            requestCount: 0,
            successCount: 0,
            successRate: 0,
            cost: 0,
            averageCost: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
          trend: [],
          models: [],
        });
      throw Error("Unexpected controlled Gateway request");
    },
  });
  const runtimeOptions = {
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath: path,
    personalPollingIntervalMs: false as const,
    watch: false,
    modelSelectionCatalogAuthority: gateway[gatewayCatalogAuthority],
  };
  runtime = createProviderRuntime(runtimeOptions);
  await runtime.start();
  t.after(async () => {
    gateway.disposeAll();
    await disposeEnterpriseIdentityService(identity);
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const login = async (next = "A") => {
    slot = next;
    const attempt = await identity.beginLogin();
    assert.equal((await identity.pollLogin(attempt.id)).status, "authenticated");
  };
  const models = async () =>
    (await runtime.modelSelection.getView()).providers
      .find((p) => p.providerId === "ucas")
      ?.models.map((m) => m.modelId) ?? [];
  return {
    root,
    path,
    runtime,
    gateway,
    identity,
    applied,
    login,
    models,
    raw: () => readFile(path, "utf8"),
    holdApply: (callback: typeof beforeApply) => {
      beforeApply = callback;
    },
    holdModels: (callback: typeof beforeModels) => {
      beforeModels = callback;
    },
    failClear: () => {
      clearFailed = true;
    },
    completedClears: () => completedClears,
  };
}
