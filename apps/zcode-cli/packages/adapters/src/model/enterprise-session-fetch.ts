import type { EnterpriseModelRelayPort, EnterpriseModelRelayRequest } from "@zcode/contracts";
import { zcodeEnterpriseModelRequestResultSchema } from "@zcode/shared";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 65536;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
type Context = Omit<EnterpriseModelRelayRequest, "request">;

/** 将SDK HTTP语义桥接到私有Host；原始字节交SDK解码，不转发任何鉴权头。 */
export function createEnterpriseSessionFetch(
  input: Context & { relay: EnterpriseModelRelayPort; getOwnerKey: () => string | undefined },
): typeof fetch {
  return async (url, init) => {
    const request = new Request(url, init);
    if (request.method !== "POST" || !["https:", "http:"].includes(new URL(request.url).protocol))
      throw new Error("enterprise_model_request_invalid");
    const body = await request.text();
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("enterprise_input_limit");
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("enterprise_model_request_invalid");
    const parentSignal = init?.signal ?? (url instanceof Request ? url.signal : undefined);
    parentSignal?.throwIfAborted();
    // 只读模型调用最初的私有 owner；缺失不能改为在 open 时认领当前新身份。
    const ownerKey = input.getOwnerKey();
    if (!/^[a-f0-9]{64}$/.test(ownerKey ?? "")) throw new Error("enterprise_model_owner_required");
    const controller = new AbortController();
    let streamId: string | undefined;
    let closed = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const context: Context = {
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      traceContext: input.traceContext,
      ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
    };
    const perform = async (frame: EnterpriseModelRelayRequest["request"], signal?: AbortSignal) => {
      const value = zcodeEnterpriseModelRequestResultSchema.parse(
        await input.relay.request({ ...context, request: frame }, signal),
      );
      if (value.status === "denied") throw new Error(value.code);
      return value;
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      parentSignal?.removeEventListener("abort", abort);
      if (!controller.signal.aborted)
        controller.abort(new Error("Enterprise model response closed"));
      if (streamId) await perform({ kind: "close", streamId }).catch(() => {});
    };
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(parentSignal?.reason);
      try {
        streamController?.error(controller.signal.reason);
      } catch {
        /* 已关闭的consumer无新结果。 */
      }
      void close();
    };
    parentSignal?.addEventListener("abort", abort, { once: true });
    try {
      const opened = await perform(
        { kind: "open", url: request.url, body, ownerKey: ownerKey! },
        controller.signal,
      );
      streamId = opened.streamId;
      if (!streamId || opened.httpStatus === undefined || !opened.contentType)
        throw new Error("enterprise_model_response_invalid");
      if (controller.signal.aborted || closed) {
        // open回包迟于取消时仍要回收刚返回的句柄，不能暴露旧身份的Response。
        await perform({ kind: "close", streamId }).catch(() => {});
        throw controller.signal.reason;
      }
      let received = 0;
      const responseBody = new ReadableStream<Uint8Array>({
        start(target) {
          streamController = target;
        },
        async pull(target) {
          try {
            const next = await perform({ kind: "read", streamId: streamId! }, controller.signal);
            if (closed || controller.signal.aborted) return;
            if (typeof next.done !== "boolean")
              throw new Error("enterprise_model_response_invalid");
            const chunk = Buffer.from(next.chunk ?? "", "base64");
            received += chunk.length;
            if (chunk.length > MAX_CHUNK_BYTES || received > MAX_RESPONSE_BYTES)
              throw new Error("enterprise_input_limit");
            if (chunk.length) target.enqueue(chunk);
            if (next.done) {
              target.close();
              await close();
            }
          } catch (error) {
            try {
              target.error(error);
            } finally {
              await close();
            }
          }
        },
        cancel: close,
      });
      return new Response(responseBody, {
        status: opened.httpStatus,
        headers: { "content-type": opened.contentType },
      });
    } catch (error) {
      await close();
      throw error;
    }
  };
}
