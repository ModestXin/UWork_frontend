import { useCallback, useEffect, useRef } from "react";
import type { IFeedbackService } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { FeedbackCenter } from "./FeedbackCenter.js";
import { useFeedbackStore } from "./feedbackStore.js";
import { resolveFeedbackEntryPolicy } from "./feedbackEntryPolicy.js";
import { useEnterpriseIdentity } from "@/hooks/useEnterpriseIdentity.js";
import { useEnterpriseIdentityStore } from "@/store/enterpriseIdentityStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";

export function FeedbackHost(props: {
  feedbackService?: IFeedbackService;
  platform: IPlatformService;
}) {
  const presentation = useEnterpriseIdentity()?.presentation ?? null;
  const policy = resolveFeedbackEntryPolicy(presentation);
  const owner = useEnterpriseIdentityStore((state) => state.owner);
  const revision = useEnterpriseIdentityStore((state) => state.view?.revision);
  const open = useFeedbackStore((state) => state.open);
  const featureRequestOpen = useFeedbackStore((state) => state.featureRequestOpen);
  const tab = useFeedbackStore((state) => state.tab);
  const submissionJobId = useFeedbackStore((state) => state.submissionJobId);
  const intentVersion = useFeedbackStore((state) => state.intentVersion);
  const { intl } = useZCodeIntl();
  const processed = useRef(-1);
  const latest = useRef({ policy, owner, revision, intl });
  latest.current = { policy, owner, revision, intl };
  const currentOwner = useCallback(() => {
    const current = useEnterpriseIdentityStore.getState();
    return (
      current.owner === latest.current.owner && current.view?.revision === latest.current.revision
    );
  }, []);

  useEffect(() => {
    // Native 的内置打开事件只接纳明确 unmanaged；不能再重入 platform.openFeedback。
    const openNative = (tickets: boolean) => {
      const current = latest.current;
      const identity = useEnterpriseIdentityStore.getState();
      const store = useFeedbackStore.getState();
      if (
        current.policy === "legacy" &&
        current.owner === identity.owner &&
        current.revision === identity.view?.revision
      ) {
        if (tickets) store.openTickets();
        else store.openSubmit();
      } else {
        store.close();
        toast(current.intl.formatMessage({ id: "feedback.enterprise.unavailable" }), {
          dedupeKey: "enterprise-feedback",
        });
      }
    };
    const submit = props.platform.onOpenFeedbackDialog?.(() => openNative(false));
    const tickets = props.platform.onOpenTicketsPanel?.(() => openNative(true));
    return () => {
      submit?.();
      tickets?.();
    };
  }, [props.platform]);

  useEffect(() => {
    if (!open && !featureRequestOpen) return;
    const isNew = processed.current !== intentVersion;
    processed.current = intentVersion;
    if (policy === "legacy" && currentOwner()) return;
    useFeedbackStore.getState().close();
    // 身份变化仅关闭旧意图，不能替新企业自动打开一个外部窗口。
    if (!isNew || !currentOwner()) return;
    if (policy === "external" && (featureRequestOpen || (tab === "submit" && !submissionJobId))) {
      const scope = { owner, revision };
      void props.platform.openFeedback().catch(() => {
        const current = useEnterpriseIdentityStore.getState();
        if (current.owner === scope.owner && current.view?.revision === scope.revision)
          toast(intl.formatMessage({ id: "feedback.enterprise.unavailable" }), {
            dedupeKey: "enterprise-feedback",
          });
      });
      return;
    }
    const id =
      policy === "disabled"
        ? "feedback.enterprise.disabled"
        : policy === "external"
          ? "feedback.enterprise.externalOnly"
          : "feedback.enterprise.unavailable";
    toast(intl.formatMessage({ id }), { dedupeKey: "enterprise-feedback" });
  }, [
    currentOwner,
    featureRequestOpen,
    intentVersion,
    intl,
    open,
    owner,
    policy,
    props.platform,
    revision,
    submissionJobId,
    tab,
  ]);

  // 先在 render 边界阻止挂载，旧 TicketsView/Form 的 effect 没有机会先发 HTTP。
  return policy === "legacy" && currentOwner() ? <FeedbackCenter {...props} /> : null;
}
