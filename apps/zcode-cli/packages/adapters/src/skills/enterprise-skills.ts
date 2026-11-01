import { join, resolve } from "node:path";
import {
  enterpriseSkillsCatalogSchema,
  type EnterpriseSkillReference,
  type EnterpriseSkillsCatalog,
} from "@zcode/shared";
import {
  CoreErrorType,
  createCoreError,
  type EnterpriseSkillsCatalogPort,
  type EnterpriseToolAuthorizationDecision,
  type EnterpriseToolAuthorizationPort,
  type SkillContent,
  type SkillDiscoverRequest,
  type SkillLoadOutcome,
  type SkillLoadRequest,
  type SkillMetadata,
  type SkillOperationOptions,
  type SkillPort,
  type SkillRoot,
  type TraceContext,
} from "@zcode/contracts";

const ENTERPRISE_PREFIX = "enterprise:",
  SKILL_FILE = "SKILL.md";
const SKILL_OPERATION_TIMEOUT_MS = 70000,
  MAX_SKILL_BYTES = 1024 * 1024;
interface Operation {
  signal?: AbortSignal;
  trace: TraceContext;
  sessionId: string;
  workingDirectory: string;
}
interface Entry {
  metadata: SkillMetadata;
  reference?: EnterpriseSkillReference;
  sourceName: string;
}
function fail(code: string, signal?: AbortSignal): never {
  throw createCoreError(
    signal?.aborted ? CoreErrorType.ToolCancelled : CoreErrorType.PermissionDenied,
    signal?.aborted ? "enterprise_authorization_cancelled" : code,
    { recoverable: true, context: { source: "enterprise-assets" } },
  );
}
const enterpriseRoot = (reference: EnterpriseSkillReference): SkillRoot => ({
  path: reference.directory,
  scope: "admin",
  source: "remote",
  priority: 0,
});
const samePath = (left: string, right: string) => resolve(left) === resolve(right);
function abortable<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return work();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
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
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
}

export function withEnterpriseSkillAuthorization(
  port: SkillPort,
  context: {
    authorization?: EnterpriseToolAuthorizationPort;
    catalog?: EnterpriseSkillsCatalogPort;
    enterprisePort: SkillPort;
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    traceContext: TraceContext;
  },
): SkillPort {
  const { authorization, catalog, enterprisePort, sessionId, workspacePath, workspaceIdentity } =
    context;
  if (!authorization && !catalog) return port;
  const defaultTrace = { ...context.traceContext };
  const operation = (request: SkillDiscoverRequest, options?: SkillOperationOptions): Operation => {
    const signals = [options?.signal, options?.context?.abortSignal].filter(
      (value): value is AbortSignal => !!value,
    );
    const trace = { ...(request.trace ?? options?.context?.trace ?? defaultTrace) };
    return {
      signal: AbortSignal.any([AbortSignal.timeout(SKILL_OPERATION_TIMEOUT_MS), ...signals]),
      trace,
      sessionId: trace.sessionId ?? sessionId,
      workingDirectory: resolve(request.workingDirectory),
    };
  };
  const currentCatalog = async (op: Operation): Promise<EnterpriseSkillsCatalog> => {
    let value: EnterpriseSkillsCatalog;
    try {
      op.signal?.throwIfAborted();
      if (!catalog || !authorization) fail("enterprise_policy_unavailable", op.signal);
      value = enterpriseSkillsCatalogSchema.parse(
        await abortable(
          () =>
            catalog.readCatalog(
              { sessionId: op.sessionId, workspacePath, workspaceIdentity, traceContext: op.trace },
              op.signal,
            ),
          op.signal,
        ),
      );
      op.signal?.throwIfAborted();
    } catch {
      fail("enterprise_policy_unavailable", op.signal);
    }
    if (value.status === "denied") fail(value.code, op.signal);
    if (value.status === "ready" && !value.allowFilesystem)
      fail("enterprise_filesystem_denied", op.signal);
    return value;
  };
  const admit = async (
    reference: EnterpriseSkillReference | undefined,
    op: Operation,
    ownerKey: string,
  ) => {
    let decision: EnterpriseToolAuthorizationDecision | undefined;
    try {
      op.signal?.throwIfAborted();
      decision = await abortable(
        () =>
          authorization!.authorize(
            {
              toolName: "EnterpriseSkillLoad",
              toolCallId: crypto.randomUUID(),
              sessionId: op.sessionId,
              workspacePath,
              workspaceIdentity,
              workingDirectory: op.workingDirectory,
              phase: "asset_load",
              ownerKey,
              input: {},
              ...(reference ? { asset: structuredClone(reference) } : {}),
              capability: {
                permission: "skill",
                sideEffectScope: "none",
                readOnly: true,
                destructive: false,
                assetGuarded: true,
              },
              traceContext: { ...op.trace },
            },
            op.signal,
          ),
        op.signal,
      );
      op.signal?.throwIfAborted();
    } catch {
      fail("enterprise_policy_unavailable", op.signal);
    }
    if (decision?.allowed === true && decision.code === "allowed") return;
    // 受管目录后的未受管结果不能把中途换配置升级成旧资产允许。
    fail(
      decision?.code === "not_managed"
        ? "enterprise_configuration_changed"
        : decision && /^enterprise_[a-z_]{1,64}$/.test(decision.code)
          ? decision.code
          : "enterprise_policy_unavailable",
      op.signal,
    );
  };
  const read = async <T>(work: () => Promise<T>, op: Operation): Promise<T> => {
    try {
      op.signal?.throwIfAborted();
      return await abortable(work, op.signal);
    } catch {
      fail("enterprise_asset_read_failed", op.signal);
    }
  };
  const unmanagedRead = async <T>(work: () => Promise<T>, op: Operation): Promise<T> => {
    try {
      return await abortable(work, op.signal);
    } catch (error) {
      // 旧适配器保留结果/错误语义，但不能让未合作的读取绕过统一取消。
      if (op.signal?.aborted) fail("enterprise_authorization_cancelled", op.signal);
      throw error;
    }
  };
  const discover = async (
    value: Extract<EnterpriseSkillsCatalog, { status: "ready" }>,
    op: Operation,
    options?: SkillOperationOptions,
  ): Promise<{ entries: Entry[]; outcome: SkillLoadOutcome }> => {
    const entries: Entry[] = [],
      diagnostics: SkillLoadOutcome["diagnostics"] = [];
    for (const asset of value.assets) {
      const reference: EnterpriseSkillReference = {
        key: asset.key,
        asset: { ...asset.asset },
        directory: asset.directory,
      };
      await admit(reference, op, value.ownerKey);
      const outcome = await read(
        () =>
          enterprisePort.discoverSkills(
            {
              workingDirectory: op.workingDirectory,
              roots: [enterpriseRoot(reference)],
              trace: op.trace,
            },
            { ...options, signal: op.signal },
          ),
        op,
      );
      const roots = outcome.skills.filter(
        (item) =>
          samePath(item.path, join(reference.directory, SKILL_FILE)) &&
          samePath(item.directory, reference.directory),
      );
      if (roots.length !== 1) fail("enterprise_asset_scope_mismatch", op.signal);
      await admit(reference, op, value.ownerKey);
      const metadata = roots[0]!;
      entries.push({
        reference,
        sourceName: metadata.qualifiedName ?? metadata.name,
        metadata: {
          ...metadata,
          name: asset.name,
          qualifiedName: `${ENTERPRISE_PREFIX}${asset.asset.id}`,
          scope: "admin",
          source: "remote",
        },
      });
    }
    if (value.personalSkills && value.dangerousSkills) {
      await admit(undefined, op, value.ownerKey);
      const outcome = await read(
        () =>
          port.discoverSkills(
            { workingDirectory: op.workingDirectory, trace: op.trace },
            { ...options, signal: op.signal },
          ),
        op,
      );
      await admit(undefined, op, value.ownerKey);
      diagnostics.push(...outcome.diagnostics);
      for (const metadata of outcome.skills)
        if (
          !metadata.name.startsWith(ENTERPRISE_PREFIX) &&
          !metadata.qualifiedName?.startsWith(ENTERPRISE_PREFIX)
        )
          entries.push({ metadata, sourceName: metadata.qualifiedName ?? metadata.name });
    }
    return {
      entries,
      outcome: {
        skills: entries.map((entry) => entry.metadata),
        diagnostics,
        totalDiscovered: entries.length,
      },
    };
  };
  return {
    enterpriseAssetGuarded: true,
    async discoverSkills(request, options) {
      const op = operation(request, options),
        value = await currentCatalog(op);
      if (value.status === "unmanaged")
        return unmanagedRead(
          () => port.discoverSkills(request, { ...options, signal: op.signal }),
          op,
        );
      if (value.status !== "ready") fail("enterprise_policy_unavailable", op.signal);
      return (await discover(value, op, options)).outcome;
    },
    async loadSkill(request: SkillLoadRequest, options): Promise<SkillContent> {
      const op = operation(request, options),
        name = request.name,
        maxBytes = request.maxBytes;
      const value = await currentCatalog(op);
      if (value.status === "unmanaged")
        return unmanagedRead(() => port.loadSkill(request, { ...options, signal: op.signal }), op);
      if (value.status !== "ready") fail("enterprise_policy_unavailable", op.signal);
      if (
        maxBytes !== undefined &&
        (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SKILL_BYTES)
      )
        fail("enterprise_skill_size_invalid", op.signal);
      const { entries } = await discover(value, op, options);
      const matches = entries.filter(
        // 保留命名空间只按绑定 ID 匹配，不能被另一个资产的展示名称冒用。
        (entry) =>
          entry.metadata.qualifiedName === name ||
          (!name.startsWith(ENTERPRISE_PREFIX) && entry.metadata.name === name),
      );
      if (matches.length !== 1)
        fail(
          matches.length > 1 ? "enterprise_skill_ambiguous" : "enterprise_skill_not_found",
          op.signal,
        );
      const selected = matches[0]!;
      await admit(selected.reference, op, value.ownerKey);
      const root = selected.reference
        ? enterpriseRoot(selected.reference)
        : {
            path: selected.metadata.directory,
            scope: selected.metadata.scope,
            source: selected.metadata.source,
            priority: 0,
            ...(selected.metadata.pluginId ? { pluginId: selected.metadata.pluginId } : {}),
          };
      const loaded = await read(
        () =>
          (selected.reference ? enterprisePort : port).loadSkill(
            {
              name: selected.sourceName,
              workingDirectory: op.workingDirectory,
              roots: [root],
              maxBytes,
              trace: op.trace,
            },
            { ...options, signal: op.signal },
          ),
        op,
      );
      if (
        !samePath(loaded.metadata.path, selected.metadata.path) ||
        !samePath(loaded.metadata.directory, selected.metadata.directory) ||
        !samePath(loaded.baseDirectory, selected.metadata.directory)
      )
        fail("enterprise_asset_scope_mismatch", op.signal);
      await admit(selected.reference, op, value.ownerKey);
      return selected.reference
        ? {
            ...loaded,
            metadata: {
              ...loaded.metadata,
              name: selected.metadata.name,
              qualifiedName: selected.metadata.qualifiedName,
              scope: "admin",
              source: "remote",
            },
            baseDirectory: selected.reference.directory,
          }
        : loaded;
    },
  };
}
