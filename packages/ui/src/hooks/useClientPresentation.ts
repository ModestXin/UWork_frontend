import { useEffect, useState } from "react";
import type { IEnterpriseIdentityService } from "@zcode/services";
import {
  uworkClientPresentationSchema,
  type EnterpriseIdentityView,
  type UWorkClientPresentation,
} from "@zcode/shared";

/** Derived display state bound to the base Host; no credentials or independent identity owner. */
export function useClientPresentation(
  owner: IEnterpriseIdentityService | null,
  identity: EnterpriseIdentityView | null,
) {
  const [projection, setProjection] = useState<{
    owner: IEnterpriseIdentityService;
    revision: number;
    value: UWorkClientPresentation;
  } | null>(null);
  useEffect(() => {
    if (!owner || !identity) return;
    let active = true,
      serial = 0;
    const refresh = async () => {
      const current = ++serial;
      let value: UWorkClientPresentation = { status: "unavailable" };
      try {
        value = uworkClientPresentationSchema.parse(await owner.readClientPresentation());
      } catch {
        // 旧 Host 缺少新 RPC 或失败响应不能保留前一组织的界面投影。
      }
      if (active && current === serial)
        setProjection({ owner, revision: identity.revision, value });
    };
    void refresh();
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    const timer = window.setInterval(focus, 30000);
    return () => {
      active = false;
      serial++;
      window.removeEventListener("focus", focus);
      window.clearInterval(timer);
    };
  }, [owner, identity?.status, identity?.revision]);
  return identity &&
    projection?.owner === owner &&
    projection.revision === identity.revision &&
    (identity.status === "authenticated" || projection.value.status !== "ready")
    ? projection.value
    : null;
}
