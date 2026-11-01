import { Building2, Network, Sparkles } from "lucide-react";
import type { UcasGatewaySubscription, UcasGatewayView } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Separator } from "@/components/ui/separator.js";
import { Button } from "@/components/ui/button.js";
import { Progress } from "@/components/ui/progress.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { UcasGatewayController } from "@/hooks/useUcasGateway.js";
import {
  formatResetTime,
  formatUsd,
  formatCost,
  gatewayHostLabel,
  shortModelName,
  gatewayAccountRoleId,
} from "./gatewayFormat.js";
import { FieldRow, InfoTile, SectionCard, type Translate } from "./gatewayUiParts.js";

export function AccountCard({ t, view }: { t: Translate; view: UcasGatewayView }) {
  const { locale } = useZCodeIntl();
  const user = view.user;
  if (!user) return null;
  const roleId = gatewayAccountRoleId(user.role);
  return (
    <SectionCard
      icon={<Building2 className="size-4" aria-hidden="true" />}
      title={t("account.title")}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <InfoTile label={t("account.name")} value={user.name} />
        <InfoTile label={t("account.department")} value={user.department ?? t("notSet")} />
        {view.authMode !== "enterprise-session" && (
          <InfoTile label={t("account.position")} value={user.position ?? t("notSet")} />
        )}
        <InfoTile label={t("account.email")} value={user.email ?? t("notSet")} />
        <InfoTile label={t("account.role")} value={t(`role.${roleId}`)} />
        {view.authMode === "enterprise-session" && user.wecomUserId && (
          <InfoTile label={t("account.wecomUserId")} value={user.wecomUserId} />
        )}
        {view.authMode !== "enterprise-session" && (
          <InfoTile
            label={t("account.budget")}
            value={
              user.monthlyBudgetUsd && user.monthlyBudgetUsd > 0
                ? formatUsd(locale, user.monthlyBudgetUsd)
                : t("notSet")
            }
          />
        )}
      </div>
    </SectionCard>
  );
}

export function GatewayCard({
  gateway,
  t,
  view,
}: {
  gateway: UcasGatewayController;
  t: Translate;
  view: UcasGatewayView;
}) {
  const endpoint = view.endpoint;
  const key = view.key;
  return (
    <SectionCard
      icon={<Network className="size-4" aria-hidden="true" />}
      title={t("gateway.title")}
    >
      <div className="space-y-3">
        <FieldRow
          label={t("gateway.endpoint")}
          value={
            <span className="font-mono text-ui-sm">
              {endpoint ? gatewayHostLabel(endpoint.baseUrl) : t("notSet")}
            </span>
          }
        />
        {/* 自有 UWork 使用 Host 私有会话；不能再引导用户下载或替换模型密钥。 */}
        <Separator />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-ui-sm text-foreground-subtle">
            {t(view.authMode === "enterprise-session" ? "gateway.sessionHint" : "gateway.keyHint")}
          </span>
          {view.authMode !== "enterprise-session" && key ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={gateway.busy}
              onClick={() => void gateway.replaceApiKey()}
              data-testid="ucas-gateway-replace-key"
            >
              {t("gateway.replaceKey")}
            </Button>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}

export function PlanSection({ t, view }: { t: Translate; view: UcasGatewayView }) {
  const { locale } = useZCodeIntl();
  return (
    <SectionCard icon={<Sparkles className="size-4" aria-hidden="true" />} title={t("plan.title")}>
      {view.subscriptions.length === 0 ? (
        <p className="text-ui-sm text-foreground-subtle">{t("plan.empty")}</p>
      ) : (
        view.subscriptions.map((subscription) => (
          <PlanRow
            key={`${subscription.planId}:${subscription.status}`}
            locale={locale}
            subscription={subscription}
            t={t}
          />
        ))
      )}
    </SectionCard>
  );
}

function PlanRow({
  locale,
  subscription,
  t,
}: {
  locale: string;
  subscription: UcasGatewaySubscription;
  t: Translate;
}) {
  const percent =
    subscription.amountTotal > 0
      ? Math.min(100, (subscription.amountUsed / subscription.amountTotal) * 100)
      : 0;
  const reset = formatResetTime(locale, subscription.nextResetTime);
  const allowance = subscription.effectiveAllowance;
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-surface/50 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-ui-base font-medium text-foreground">
          {subscription.planTitle || t("plan.unnamed")}
        </span>
        <Badge variant="secondary">{subscription.status}</Badge>
      </div>
      {allowance && (
        <div className="space-y-1 text-ui-sm" data-testid="enterprise-effective-allowance">
          <p className="font-medium text-foreground">
            {t("plan.effectiveRemaining", {
              amount: formatCost(locale, allowance.amountRemaining, "credits"),
            })}
          </p>
          {allowance.blocked && (
            <p className="text-foreground-subtle">
              {t(
                allowance.reason === "subscription_inactive"
                  ? "plan.subscriptionInactive"
                  : "plan.creditExhausted",
              )}
            </p>
          )}
          <p className="text-foreground-subtle">{t("plan.effectiveHint")}</p>
        </div>
      )}
      <Progress value={percent} />
      <div className="flex flex-wrap items-center justify-between gap-2 text-ui-sm text-foreground-subtle">
        <span>
          {t(allowance ? "plan.referenceUsedOf" : "plan.usedOf", {
            used: formatCost(locale, subscription.amountUsed, subscription.unit),
            total: formatCost(locale, subscription.amountTotal, subscription.unit),
          })}
        </span>
        <span>{reset ? t("plan.nextReset", { time: reset }) : t("plan.noReset")}</span>
      </div>
    </div>
  );
}

export function ModelsSection({
  gateway,
  t,
  view,
}: {
  gateway: UcasGatewayController;
  t: Translate;
  view: UcasGatewayView;
}) {
  const models = view.models;
  if (!models) return null;
  return (
    <SectionCard
      icon={<Sparkles className="size-4" aria-hidden="true" />}
      title={t("models.title")}
      aside={
        <>
          <Badge variant="outline">
            {t("models.available", { count: models.available.length })}
          </Badge>
          {models.pendingCount > 0 ? (
            <Badge variant="secondary">{t("models.pending", { count: models.pendingCount })}</Badge>
          ) : null}
          {models.unrestricted ? <Badge variant="ghost">{t("models.unrestricted")}</Badge> : null}
        </>
      }
    >
      {models.available.length === 0 ? (
        <p className="text-ui-sm text-foreground-subtle">{t("models.empty")}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {models.available.slice(0, 24).map((model) => (
            <Badge key={model} variant="outline" className="font-mono">
              {shortModelName(model)}
            </Badge>
          ))}
        </div>
      )}
      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-ui-sm text-foreground-subtle">{t("models.hint")}</span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={gateway.busy}
            onClick={() => void gateway.refreshModels()}
            data-testid="ucas-gateway-refresh-models"
          >
            {t("models.refresh")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={gateway.busy || models.pendingCount === 0}
            onClick={() => void gateway.applyModels()}
            data-testid="ucas-gateway-apply-models"
          >
            {t("models.apply")}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
