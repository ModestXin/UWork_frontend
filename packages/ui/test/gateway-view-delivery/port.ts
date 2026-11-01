import { Emitter } from "@zcode/rpc";
import type { IUcasGatewayService } from "@zcode/services";
import {
  ucasGatewaySyncResultSchema,
  ucasGatewayViewSchema,
  type UcasGatewayUsageRequest,
  type UcasGatewayView,
} from "@zcode/shared";

export type CaseName =
  | "initial-late"
  | "sync-late"
  | "selection-retired"
  | "service-replaced"
  | "service-replaced-layout"
  | "service-busy-replaced"
  | "cold-sync-null-usage"
  | "usage-return-before-event"
  | "usage-return-old-revision"
  | "usage-rejected";
export const CASE_NAMES: readonly CaseName[] = [
  "initial-late",
  "sync-late",
  "selection-retired",
  "service-replaced",
  "service-replaced-layout",
  "service-busy-replaced",
  "cold-sync-null-usage",
  "usage-return-before-event",
  "usage-return-old-revision",
  "usage-rejected",
];
function deferred<T>() {
  let settle: ((value: T) => void) | undefined;
  let reject: ((reason: Error) => void) | undefined;
  let pending = true;
  const promise = new Promise<T>((resolve, fail) => {
    settle = resolve;
    reject = fail;
  });
  return {
    promise,
    get pending() {
      return pending;
    },
    resolve(value: T) {
      if (!settle || !pending) throw Error("Duplicate fixture delivery");
      pending = false;
      settle(value);
    },
    reject(reason: Error) {
      if (!reject || !pending) throw Error("Duplicate fixture rejection");
      pending = false;
      reject(reason);
    },
  };
}
export function ready(
  revision: number,
  owner: "A" | "B",
  period: "month" | "7d" | "30d" = "month",
): UcasGatewayView {
  const n = owner === "A" ? 2 : 4;
  return ucasGatewayViewSchema.parse({
    revision,
    status: "ready",
    configured: true,
    authMode: "enterprise-session",
    user: {
      id: "owned-user-" + owner,
      orgId: "owned-org-" + owner,
      name: "OWNED_OWNER_" + owner,
      role: "member",
      wecomUserId: null,
      email: null,
      avatar: null,
      department: "Owned department " + owner,
      position: null,
      monthlyBudgetUsd: null,
    },
    endpoint: {
      baseUrl: "https://gateway.example.invalid/v1",
      publicBaseUrl: "https://gateway.example.invalid/v1",
      internalBaseUrl: null,
      source: "public",
    },
    key: null,
    subscriptions: [
      {
        planId: "owned-plan-" + owner,
        planTitle: "OWNED_PLAN_" + owner,
        amountTotal: 1000 * n,
        amountUsed: 22 * n,
        nextResetTime: null,
        status: "active",
        unit: "credits",
        effectiveAllowance: {
          application: "uwork",
          period: "owned-period",
          amountRemaining: 978 * n,
          blocked: false,
          reason: null,
        },
      },
    ],
    usage: {
      unit: "credits",
      period,
      metric: "requests",
      from: "2026-10-01",
      until: "2026-10-18",
      summary: {
        requestCount: n,
        successCount: n,
        successRate: 1,
        cost: 22 * n,
        averageCost: 22,
        promptTokens: n * 10,
        completionTokens: n * 2,
        totalTokens: n * 12,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      trend: [],
      models: [],
    },
    models: {
      available: ["owned-model-" + owner],
      unrestricted: false,
      hasSubscription: true,
      appliedCount: 1,
      pendingCount: 0,
    },
    lastSyncedAt: 1,
    error: null,
  });
}
function signedOut(revision: number): UcasGatewayView {
  return ucasGatewayViewSchema.parse({
    revision,
    status: "signed-out",
    configured: true,
    authMode: "enterprise-session",
    user: null,
    endpoint: null,
    key: null,
    subscriptions: [],
    usage: null,
    models: null,
    lastSyncedAt: null,
    error: null,
  });
}
function usageView(
  revision: number,
  owner: "A" | "B",
  input: UcasGatewayUsageRequest,
  marker: string,
): UcasGatewayView {
  const base = ready(revision, owner, input.period);
  if (!base.usage) throw Error("Fixture usage required");
  return ucasGatewayViewSchema.parse({
    ...base,
    usage: {
      ...base.usage,
      metric: input.metric,
      models: [{ model: marker, requestCount: 107, cost: 22, share: 1 }],
    },
  });
}
export function createPort(caseName: CaseName, notify: () => void, owner: "A" | "B" = "A") {
  const changed = new Emitter<UcasGatewayView>();
  const initial =
    caseName === "cold-sync-null-usage"
      ? ucasGatewayViewSchema.parse({ ...signedOut(10), status: "idle" })
      : ready(owner === "A" ? 10 : 1, owner);
  let latest = initial;
  let getViewCalls = 0,
    syncCalls = 0;
  const requests: UcasGatewayUsageRequest[] = [];
  const deliveries: Array<{
    type: string;
    revision: number;
    status: string;
    owner: string | null;
  }> = [];
  const heldInitial = deferred<UcasGatewayView>();
  const heldSync = deferred<ReturnType<typeof ucasGatewaySyncResultSchema.parse>>();
  const heldUsage = deferred<UcasGatewayView>();
  let capturedSync: UcasGatewayView | null = null;
  let capturedUsage: UcasGatewayView | null = null;
  const log = (type: string, view: UcasGatewayView) => {
    deliveries.push({
      type,
      revision: view.revision,
      status: view.status,
      owner: view.user?.name ?? null,
    });
    notify();
  };
  const event = (view: UcasGatewayView) => {
    if (view.revision < latest.revision) throw Error("Producer cannot regress current revision");
    latest = ucasGatewayViewSchema.parse(view);
    log("event", latest);
    changed.fire(structuredClone(latest));
  };
  const result = (view: UcasGatewayView) =>
    ucasGatewaySyncResultSchema.parse({
      view,
      committed: true,
      apiKeyApplied: false,
      apiKeyReused: false,
      providerHasApiKey: false,
      modelsAdded: 0,
      modelsSkipped: 0,
    });
  const service: IUcasGatewayService = {
    onDidChange: changed.event,
    getView() {
      getViewCalls++;
      log("getView-captured", initial);
      return caseName === "initial-late" ||
        caseName === "service-replaced" ||
        caseName === "service-replaced-layout" ||
        owner === "B"
        ? heldInitial.promise
        : Promise.resolve(structuredClone(initial));
    },
    sync() {
      if (syncCalls) throw Error("Only one bounded sync per producer");
      syncCalls++;
      event({ ...latest, revision: latest.revision + 1, status: "syncing" });
      capturedSync = ready(latest.revision + 1, owner);
      if (caseName !== "cold-sync-null-usage") event(capturedSync);
      log("sync-return-captured", capturedSync);
      return heldSync.promise;
    },
    refreshUsage(input: UcasGatewayUsageRequest) {
      if (requests.length) throw Error("Only one bounded usage request per producer");
      requests.push(structuredClone(input));
      if (caseName === "usage-return-before-event" || caseName === "usage-return-old-revision") {
        capturedUsage = usageView(latest.revision + 1, owner, input, "OWNED_RETURN_SEVEN");
        latest = capturedUsage;
        log("usage-return-captured-event-withheld", capturedUsage);
      }
      notify();
      return heldUsage.promise;
    },
    refreshModels: async () => {
      throw Error("Not part of finite fixture");
    },
    applyModels: async () => {
      throw Error("Not part of finite fixture");
    },
    replaceApiKey: async () => {
      throw Error("No key capability in this fixture");
    },
  };
  return {
    service,
    facts: () => ({
      caseName,
      owner,
      getViewCalls,
      syncCalls,
      requests,
      latest: {
        revision: latest.revision,
        status: latest.status,
        owner: latest.user?.name ?? null,
        period: latest.usage?.period ?? null,
      },
      deliveries,
      initialPending: heldInitial.pending,
      syncPending: heldSync.pending,
      usagePending: heldUsage.pending,
    }),
    emitCurrent: () => event(initial),
    emitSignedOut: () => event(signedOut(latest.revision + 1)),
    emitB: () => event(ready(latest.revision + 1, "B")),
    deliverInitial() {
      log("getView-response", initial);
      heldInitial.resolve(structuredClone(initial));
    },
    deliverSync() {
      if (!capturedSync) throw Error("No bounded sync to deliver");
      if (caseName === "cold-sync-null-usage") event(capturedSync);
      log("sync-response", capturedSync);
      heldSync.resolve(result(capturedSync));
    },
    deliverUsage() {
      log("old-usage-operation-retired", latest);
      heldUsage.resolve(structuredClone(latest));
    },
    deliverCapturedUsage() {
      if (!capturedUsage) throw Error("No captured usage");
      log("captured-usage-response", capturedUsage);
      heldUsage.resolve(structuredClone(capturedUsage));
    },
    deliverCapturedUsageEvent() {
      if (!capturedUsage) throw Error("No captured usage");
      event(capturedUsage);
    },
    emitNewerUsage() {
      event(
        usageView(
          latest.revision + 1,
          owner,
          { period: "30d", metric: "requests" },
          "OWNED_NEWER_THIRTY",
        ),
      );
    },
    rejectUsage() {
      event({ ...latest, revision: latest.revision + 1, status: "error", error: "network" });
      log("usage-rejected", latest);
      heldUsage.reject(Error("Owned finite usage rejection"));
    },
  };
}
