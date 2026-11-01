import type { EnterpriseIdentityView, UWorkClientPresentation } from "@zcode/shared";

const ownerIds = new WeakMap<object, number>();
let nextOwnerId = 1;

/** A disposable display key derived from the existing base owner; never an identity authority. */
export function clientExperienceScopeKey(
  owner: object | null,
  view: EnterpriseIdentityView | null,
  presentation: UWorkClientPresentation | null,
  kind: "scenes" | "pluginStore",
): string {
  let ownerId = 0;
  if (owner) {
    ownerId = ownerIds.get(owner) ?? nextOwnerId++;
    ownerIds.set(owner, ownerId);
  }
  const feature = presentation?.status === "ready" ? presentation[kind] : undefined;
  return [
    ownerId,
    view?.revision ?? -1,
    view?.status ?? "pending",
    presentation?.status ?? "pending",
    feature?.status ?? "pending",
    feature?.status === "ready" ? feature.version : -1,
  ].join(":");
}

export function currentClientExperienceValue<T>(
  snapshot: { scope: string; value: T } | undefined,
  scope: string,
): T | undefined {
  return snapshot?.scope === scope ? snapshot.value : undefined;
}
