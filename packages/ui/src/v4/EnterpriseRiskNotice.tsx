import { useEnterpriseIdentity } from "@/hooks/useEnterpriseIdentity.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function EnterpriseRiskNotice() {
  const presentation = useEnterpriseIdentity()?.presentation;
  const { intl } = useZCodeIntl();
  const ready = presentation?.status === "ready";
  return (
    <p
      data-testid="enterprise-risk-notice"
      data-status={ready ? "ready" : "fallback"}
      className="px-3 py-2 text-center text-ui-xs text-foreground-muted whitespace-pre-wrap break-words"
    >
      <span>
        {ready ? presentation.riskPrefix : intl.formatMessage({ id: "chat.aiRiskPrefix" })}
      </span>
      {ready ? (
        <>
          {" · "}
          <span>{presentation.riskNotice}</span>
        </>
      ) : null}
    </p>
  );
}
