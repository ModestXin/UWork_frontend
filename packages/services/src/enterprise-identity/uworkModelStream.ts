import { UWorkBackendSessionError } from "./backendSessionContract.js";
import type { UWorkBackendModelStream } from "./backendSessionContract.js";
const failure = (code: string) => new UWorkBackendSessionError(code);
/** 空行分隔SSE事件，CRLF作为一个换行；网络chunk边界不具有协议含义。 */
function eventEnd(buffer: Buffer, ended: boolean): number {
  let line = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 10 && buffer[i] !== 13) continue;
    if (buffer[i] === 13 && i + 1 === buffer.length && !ended) return 0;
    const end = i + (buffer[i] === 13 && buffer[i + 1] === 10 ? 2 : 1);
    if (line === i) return end;
    line = end;
    i = end - 1;
  }
  return ended ? buffer.length : 0;
}
/** 仅Host持有reader/token；检查JSON语义以及跨SSE delta拼接，不能只搜原始bytes。 */
export function createUWorkModelStream(input: {
  response: Response;
  token: string;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
}): UWorkBackendModelStream {
  const contentType = input.response.headers.get("content-type")?.split(";")[0]?.trim();
  const reader = input.response.body?.getReader();
  if (!reader || (contentType !== "application/json" && contentType !== "text/event-stream")) {
    void reader?.cancel().catch(() => {});
    throw failure("enterprise_model_response_invalid");
  }
  const prefixes = new Map<string, string>();
  let pending = Buffer.alloc(0),
    ready = Buffer.alloc(0),
    held = Buffer.alloc(0);
  let ended = false,
    total = 0,
    busy = false;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  input.signal.addEventListener("abort", cancel, { once: true });
  const close = () => {
    input.signal.removeEventListener("abort", cancel);
    cancel();
  };
  const rawTails = new Map<string, string>();
  const inspectString = (text: string, path: string) => {
    const rolling = path.includes(".delta.");
    const candidate = (rolling ? (rawTails.get(path) ?? "") : "") + text;
    let decoded = candidate;
    // 工具arguments会由CLI再次JSON.parse；最多解四层JSON反斜杠/Unicode，不承诺任意编码解密。
    for (let depth = 0; depth < 4; depth++) {
      if (decoded.includes(input.token)) throw failure("enterprise_response_private");
      const next = decoded
        .replace(/\\\\/g, "\\")
        .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        );
      if (next === decoded) break;
      decoded = next;
    }
    if (decoded.includes(input.token)) throw failure("enterprise_response_private");
    if (!rolling) return;
    rawTails.set(path, candidate.slice(-Math.min(65536, input.token.length * 128 + 64)));
    let prefix = "";
    for (let size = Math.min(decoded.length, input.token.length - 1); size > 0; size--) {
      if (decoded.endsWith(input.token.slice(0, size))) {
        prefix = input.token.slice(0, size);
        break;
      }
    }
    // 尚未收全的JSON escape同样不能先交给工具参数拼接者。
    if (/\\(?:u[0-9a-fA-F]{0,3})?$/.test(decoded)) prefix = "pending-json-escape";
    if (prefix) prefixes.set(path, prefix);
    else prefixes.delete(path);
  };
  const inspect = (value: unknown, path = "$") => {
    if (typeof value === "string") inspectString(value, path);
    else if (Array.isArray(value))
      value.forEach((item, index) => inspect(item, `${path}.${index}`));
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        if (key.includes(input.token)) throw failure("enterprise_response_private");
        inspect(item, `${path}.${key}`);
      }
  };
  const verify = (frame: Buffer) => {
    const text = frame.toString("utf8");
    if (text.includes(input.token)) throw failure("enterprise_response_private");
    if (contentType === "application/json") inspect(JSON.parse(text));
    else {
      const data = text
        .split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data && data !== "[DONE]") inspect(JSON.parse(data));
    }
    held = Buffer.concat([held, frame]);
    // 可能是token前缀的完整事件也先保留；下一delta若补齐不能先泄漏前半段。
    if (prefixes.size === 0 || ended) {
      ready = Buffer.concat([ready, held]);
      held = Buffer.alloc(0);
    }
  };
  return {
    httpStatus: input.response.status,
    contentType,
    close,
    async read() {
      if (busy) throw failure("enterprise_model_read_pending");
      busy = true;
      try {
        input.signal.throwIfAborted();
        await input.assertCurrent();
        while (!ready.length) {
          const boundary =
            contentType === "application/json"
              ? ended
                ? pending.length
                : 0
              : eventEnd(pending, ended);
          if (boundary) {
            const frame = pending.subarray(0, boundary);
            pending = pending.subarray(boundary);
            verify(frame);
            continue;
          }
          if (ended) {
            ready = held;
            held = Buffer.alloc(0);
            break;
          }
          const chunk = await new Promise<{ done: boolean; value?: Uint8Array }>(
            (resolve, reject) => {
              const abort = () => {
                input.signal.removeEventListener("abort", abort);
                reject(failure("enterprise_authorization_cancelled"));
              };
              input.signal.addEventListener("abort", abort, { once: true });
              if (input.signal.aborted) abort();
              else
                void reader
                  .read()
                  .then(resolve, reject)
                  .finally(() => input.signal.removeEventListener("abort", abort));
            },
          );
          if (chunk.done) ended = true;
          else {
            total += chunk.value!.byteLength;
            if (total > 8 * 1024 * 1024) throw failure("enterprise_response_limit");
            pending = Buffer.concat([pending, chunk.value!]);
          }
        }
        input.signal.throwIfAborted();
        await input.assertCurrent();
        const chunk = ready.subarray(0, 65536);
        ready = ready.subarray(chunk.length);
        const done = ended && !ready.length && !pending.length && !held.length;
        if (done) input.signal.removeEventListener("abort", cancel);
        return { chunk, done };
      } catch (error) {
        close();
        throw error;
      } finally {
        busy = false;
      }
    },
  };
}
