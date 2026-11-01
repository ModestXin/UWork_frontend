import { randomUUID } from "node:crypto";
import {
  hostClientPresentationResponseSchema,
  type DesktopClientPresentation,
  type HostClientPresentationReadMessage,
} from "@zcode/shared";

interface Child {
  postMessage(message: HostClientPresentationReadMessage): void;
}
export interface BoundClientPresentation {
  bindingEpoch: string;
  projection: DesktopClientPresentation;
}
interface Pending {
  requestId: string;
  sourceEpoch: number;
  promise: Promise<BoundClientPresentation>;
  finish(value: BoundClientPresentation): void;
}
interface Binding<T> {
  child: T;
  nonce: string;
  sourceEpoch: number;
  decision: number;
  fingerprint: string;
  current: BoundClientPresentation;
  pending?: Pending;
}

/** 当前 child 的派生 view；没有成功缓存或失败后的旧值回退。 */
export function createClientPresentationBindings<T extends Child>(options: {
  currentChild(senderId: number): T | undefined;
  changed(senderId: number, value: BoundClientPresentation): void;
  timeoutMs?: number;
}) {
  const bindings = new Map<number, Binding<T>>();
  let disposed = false;
  const unavailable = (): DesktopClientPresentation => ({ status: "unavailable" });
  const update = (
    senderId: number,
    binding: Binding<T>,
    projection: DesktopClientPresentation,
    rotate = false,
  ) => {
    const fingerprint = JSON.stringify(projection);
    if (rotate || fingerprint !== binding.fingerprint) {
      binding.fingerprint = fingerprint;
      binding.current = { bindingEpoch: `${binding.nonce}:${++binding.decision}`, projection };
      options.changed(senderId, binding.current);
    }
    return binding.current;
  };
  const retire = (senderId: number, binding: Binding<T>) => {
    const pending = binding.pending;
    binding.pending = undefined;
    const current = update(senderId, binding, unavailable(), true);
    pending?.finish(current);
  };
  const currentBinding = (senderId: number): Binding<T> | undefined => {
    if (disposed) return undefined;
    const child = options.currentChild(senderId);
    let binding = bindings.get(senderId);
    if (binding?.child !== child) {
      bindings.delete(senderId);
      if (binding) retire(senderId, binding);
      binding = undefined;
    }
    if (!child) return undefined;
    if (!binding) {
      const nonce = randomUUID();
      binding = {
        child,
        nonce,
        sourceEpoch: -1,
        decision: 0,
        fingerprint: "",
        current: { bindingEpoch: `${nonce}:0`, projection: unavailable() },
      };
      bindings.set(senderId, binding);
    }
    return binding;
  };
  return {
    read(senderId: number): Promise<BoundClientPresentation> {
      const binding = currentBinding(senderId);
      if (!binding)
        return Promise.resolve({ bindingEpoch: `unbound:${senderId}`, projection: unavailable() });
      if (binding.pending?.sourceEpoch === binding.sourceEpoch) return binding.pending.promise;
      const requestId = randomUUID();
      let finish!: (value: BoundClientPresentation) => void;
      const promise = new Promise<BoundClientPresentation>((resolve) => {
        finish = resolve;
      });
      const timer = setTimeout(() => {
        if (binding.pending?.requestId !== requestId) return;
        binding.pending = undefined;
        finish(update(senderId, binding, unavailable()));
      }, options.timeoutMs ?? 15_000);
      timer.unref?.();
      binding.pending = {
        requestId,
        sourceEpoch: binding.sourceEpoch,
        promise,
        finish(value) {
          clearTimeout(timer);
          finish(value);
        },
      };
      try {
        binding.child.postMessage({ type: "client-presentation-read", requestId });
      } catch {
        binding.pending.finish(update(senderId, binding, unavailable()));
        binding.pending = undefined;
      }
      return promise;
    },
    receive(senderId: number, child: T, message: unknown): void {
      const parsed = hostClientPresentationResponseSchema.safeParse(message);
      if (disposed || !parsed.success || options.currentChild(senderId) !== child) return;
      const binding = currentBinding(senderId);
      if (!binding || binding.child !== child || parsed.data.sourceEpoch < binding.sourceEpoch)
        return;
      const response = parsed.data;
      if (response.type === "client-presentation-invalidated") {
        if (response.sourceEpoch === binding.sourceEpoch) return;
        binding.sourceEpoch = response.sourceEpoch;
        retire(senderId, binding);
        return;
      }
      const pending = binding.pending;
      if (!pending || pending.requestId !== response.requestId) return;
      const sourceChanged =
        binding.sourceEpoch >= 0 && response.sourceEpoch !== binding.sourceEpoch;
      binding.sourceEpoch = response.sourceEpoch;
      binding.pending = undefined;
      pending.finish(update(senderId, binding, response.projection, sourceChanged));
    },
    isCurrent(senderId: number, bindingEpoch: string): boolean {
      const binding = currentBinding(senderId);
      return binding?.current.bindingEpoch === bindingEpoch;
    },
    forgetChild(child: T): void {
      for (const [senderId, binding] of bindings)
        if (binding.child === child) {
          bindings.delete(senderId);
          retire(senderId, binding);
        }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const [senderId, binding] of bindings) retire(senderId, binding);
      bindings.clear();
    },
  };
}
