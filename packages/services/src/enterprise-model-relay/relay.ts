import { randomUUID } from "node:crypto";
import type {
  ZCodeEnterpriseModelRequestParams,
  ZCodeEnterpriseModelRequestResult,
} from "@zcode/shared";
import type {
  UWorkBackendModelStream,
  UWorkBackendScope,
  UWorkBackendSession,
} from "../enterprise-identity/backendSessionContract.js";
import { UWorkBackendSessionError } from "../enterprise-identity/backendSessionContract.js";
interface Binding {
  runtime: object;
  workspaceKey: string;
  sessionId: string;
}
interface Entry extends Binding {
  scope: UWorkBackendScope;
  stream: UWorkBackendModelStream;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  busy: boolean;
  openRequestId?: string;
  cleanup(): void;
}
export interface EnterpriseModelRelay {
  request(
    input: Binding & {
      request: ZCodeEnterpriseModelRequestParams["request"];
      signal?: AbortSignal;
      traceId?: string;
      requestId?: string;
    },
  ): Promise<ZCodeEnterpriseModelRequestResult>;
  cancelRequest(input: Binding & { requestId: string }): void;
  closeRuntime(runtime: object): void;
  dispose(): void;
}
const denied = (code: string): ZCodeEnterpriseModelRequestResult => ({ status: "denied", code });
export function createEnterpriseModelRelay(options: {
  backendSession: UWorkBackendSession;
}): EnterpriseModelRelay {
  const streams = new Map<string, Entry>();
  let pending = 0,
    disposed = false;
  const opening = new Map<AbortController, Binding & { requestId?: string }>();
  const close = (id: string) => {
    const entry = streams.get(id);
    if (!entry) return;
    streams.delete(id);
    clearTimeout(entry.timer);
    entry.cleanup();
    entry.controller.abort();
    entry.stream.close();
  };
  return {
    async request(input) {
      if (disposed || input.signal?.aborted) return denied("enterprise_authorization_cancelled");
      const request = input.request;
      if (request.kind === "open") {
        if (streams.size + pending >= 32) return denied("enterprise_model_limit");
        if (Buffer.byteLength(request.body) > 1024 * 1024)
          return denied("enterprise_request_limit");
        pending++;
        const controller = new AbortController();
        opening.set(controller, input);
        const abort = () => controller.abort();
        input.signal?.addEventListener("abort", abort, { once: true });
        let streamId: string | undefined;
        const timer = setTimeout(() => {
          controller.abort();
          if (streamId) close(streamId);
        }, 300000);
        timer.unref();
        try {
          const result = await options.backendSession.run(
            async (scope) => {
              if (
                !/^[a-f0-9]{64}$/.test(request.ownerKey ?? "") ||
                request.ownerKey !== scope.ownerKey
              )
                throw new UWorkBackendSessionError("enterprise_identity_changed");
              if (request.url !== `${scope.origin}/v1/chat/completions` || !scope.openModelStream)
                throw new UWorkBackendSessionError("enterprise_model_target_invalid");
              const stream = await scope.openModelStream(request.body, controller.signal);
              try {
                await scope.assertCurrent();
              } catch (error) {
                stream.close();
                throw error;
              }
              if (disposed || controller.signal.aborted) {
                stream.close();
                throw new Error("closed");
              }
              streamId = randomUUID();
              const onOwnerAbort = () => close(streamId!);
              scope.signal.addEventListener("abort", onOwnerAbort, { once: true });
              streams.set(streamId, {
                runtime: input.runtime,
                workspaceKey: input.workspaceKey,
                sessionId: input.sessionId,
                controller,
                timer,
                stream,
                scope,
                busy: false,
                openRequestId: input.requestId,
                cleanup: () => scope.signal.removeEventListener("abort", onOwnerAbort),
              });
              return {
                status: "ok" as const,
                streamId,
                httpStatus: stream.httpStatus,
                contentType: stream.contentType,
              };
            },
            { signal: controller.signal, traceId: input.traceId },
          );
          if (!result.managed) throw new UWorkBackendSessionError("enterprise_policy_unavailable");
          return result.value;
        } catch (error) {
          if (streamId) close(streamId);
          clearTimeout(timer);
          controller.abort();
          return denied(
            error instanceof UWorkBackendSessionError ? error.code : "enterprise_model_unavailable",
          );
        } finally {
          pending--;
          opening.delete(controller);
          input.signal?.removeEventListener("abort", abort);
        }
      }
      const entry = streams.get(request.streamId);
      if (!entry)
        return request.kind === "close"
          ? { status: "ok", done: true }
          : denied("enterprise_model_stream_closed");
      if (
        entry.runtime !== input.runtime ||
        entry.workspaceKey !== input.workspaceKey ||
        entry.sessionId !== input.sessionId
      )
        return denied("enterprise_model_binding_mismatch");
      if (request.kind === "close") {
        close(request.streamId);
        return { status: "ok", done: true };
      }
      if (entry.busy) return denied("enterprise_model_read_pending");
      entry.busy = true;
      const abort = () => close(request.streamId);
      input.signal?.addEventListener("abort", abort, { once: true });
      try {
        await entry.scope.assertCurrent();
        const result = await entry.stream.read();
        await entry.scope.assertCurrent();
        if (input.signal?.aborted || entry.controller.signal.aborted) throw new Error("cancelled");
        if (result.done) close(request.streamId);
        return {
          status: "ok",
          chunk: Buffer.from(result.chunk).toString("base64"),
          done: result.done,
        };
      } catch (error) {
        close(request.streamId);
        return denied(
          error instanceof UWorkBackendSessionError ? error.code : "enterprise_model_unavailable",
        );
      } finally {
        entry.busy = false;
        input.signal?.removeEventListener("abort", abort);
      }
    },
    cancelRequest(input) {
      const same = (entry: Binding) =>
        entry.runtime === input.runtime &&
        entry.workspaceKey === input.workspaceKey &&
        entry.sessionId === input.sessionId;
      for (const [controller, entry] of opening)
        if (same(entry) && entry.requestId === input.requestId) controller.abort();
      for (const [id, entry] of streams)
        if (same(entry) && entry.openRequestId === input.requestId) close(id);
    },
    closeRuntime(runtime) {
      for (const [controller, owner] of opening) if (owner.runtime === runtime) controller.abort();
      for (const [id, entry] of streams) if (entry.runtime === runtime) close(id);
    },
    dispose() {
      disposed = true;
      for (const controller of opening.keys()) controller.abort();
      for (const id of streams.keys()) close(id);
    },
  };
}
