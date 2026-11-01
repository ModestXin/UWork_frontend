import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface WebSocketConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
}

function wrapBrowserWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  let disposed = false;
  const handleMessage = (event: MessageEvent) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(event.data as ArrayBuffer)));
  };
  const handleEnd = () => {
    onClose.fire();
    onEnd.fire();
  };

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", handleMessage);
  ws.addEventListener("close", handleEnd);
  ws.addEventListener("error", handleEnd);

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (!disposed && ws.readyState === WebSocket.OPEN) {
        ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ws.removeEventListener("message", handleMessage);
      ws.removeEventListener("close", handleEnd);
      ws.removeEventListener("error", handleEnd);
      onData.dispose();
      onClose.dispose();
      onEnd.dispose();
      if (ws.readyState < WebSocket.CLOSING) ws.close();
    },
  };
}

export function connectViaWebSocket(
  wsUrl: string,
  options?: WebSocketConnectionOptions,
): Promise<IServiceAccessor> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    let disposed = false;
    let socket: ISocket | undefined;
    let protocol: SocketProtocol | undefined;
    let client: ChannelClient | undefined;

    const disposeConnection = () => {
      if (disposed) return;
      disposed = true;
      // SocketProtocol 只负责分帧；连接 owner 必须结束 RPC，避免关闭后永远等待响应。
      try {
        client?.dispose();
      } finally {
        try {
          protocol?.dispose();
        } finally {
          if (socket) socket.dispose();
          else if (ws.readyState < WebSocket.CLOSING) ws.close();
        }
      }
    };
    const handleError = () => {
      disposeConnection();
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("error", handleError);
      // error 可先终结资源；保留 close listener，随后仅通知真实的 CloseEvent。
      if (!settled) {
        settled = true;
        reject(new Error(`WebSocket connection failed: ${wsUrl}`));
      }
    };
    const handleClose = (event: CloseEvent) => {
      disposeConnection();
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("error", handleError);
      ws.removeEventListener("close", handleClose);
      try {
        options?.onClose?.({
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
      } finally {
        if (!settled) {
          settled = true;
          reject(
            new Error(
              event.reason
                ? `WebSocket closed before ready: ${event.reason}`
                : `WebSocket closed before ready (${event.code})`,
            ),
          );
        }
      }
    };
    const handleOpen = () => {
      ws.removeEventListener("open", handleOpen);
      if (disposed) return;
      settled = true;
      socket = wrapBrowserWebSocket(ws);
      protocol = new SocketProtocol(socket);
      client = new ChannelClient(protocol);
      options?.onOpenSocket?.(ws);
      // open 观察回调也可能同步关闭/报错，不能再交付已终结连接的代理。
      if (disposed || ws.readyState !== WebSocket.OPEN) {
        disposeConnection();
        reject(new Error("WebSocket closed before ready"));
        return;
      }
      resolve(new RemoteServiceAccess(client));
    };

    ws.addEventListener("error", handleError);
    ws.addEventListener("close", handleClose);
    ws.addEventListener("open", handleOpen);
  });
}

export function connectViaProtocol(
  protocol: IMessagePassingProtocol,
  options: { windowProjectDirectory?: boolean } = {},
): IServiceAccessor {
  const client = new ChannelClient(protocol);
  return new RemoteServiceAccess(client, options);
}
