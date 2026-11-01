import { useEffect, useRef, useState } from "react";
import { Bot, Folder, Globe, Library, MessageCircle } from "lucide-react";
import type { EnterpriseMenu } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useEnterpriseConsole } from "@/hooks/useEnterpriseConsole.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const icons = { message: MessageCircle, bot: Bot, library: Library, globe: Globe, folder: Folder };
export function EnterpriseNavigation({
  onNavigate,
  activeMenuId,
}: {
  onNavigate: (menu: EnterpriseMenu) => void;
  activeMenuId?: "chat" | "agents" | "assets";
}) {
  const { service, identityRevision, navigation, refreshNavigation } = useEnterpriseConsole();
  const { intl, locale } = useZCodeIntl();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const latest = useRef({ service, identityRevision });
  const mounted = useRef(true);
  latest.current = { service, identityRevision };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setPending(false);
    setFailed(false);
  }, [service, identityRevision]);
  if (!service || navigation?.status === "unmanaged") return null;
  return (
    <nav
      data-testid="enterprise-navigation"
      className="min-w-0"
      aria-label={intl.formatMessage({ id: "enterprise.console.navigation" })}
    >
      {navigation?.status === "ready" ? (
        navigation.items.map((menu) => {
          const Icon = icons[menu.icon];
          return (
            <Button
              key={menu.id}
              variant="ghost"
              size="lg"
              disabled={pending}
              data-testid={`enterprise-menu-${menu.id}`}
              aria-pressed={menu.builtin ? menu.id === activeMenuId : undefined}
              className={`w-full justify-start gap-2 text-foreground${menu.builtin && menu.id === activeMenuId ? " bg-selected" : ""}`}
              onClick={() => {
                const revision = identityRevision;
                setPending(true);
                setFailed(false);
                void service
                  .authorizeMenu(menu.id)
                  .then((current) => {
                    // Service already fences identity/configuration; callback stays tied to this render's base owner.
                    if (
                      mounted.current &&
                      latest.current.service === service &&
                      revision === latest.current.identityRevision
                    )
                      onNavigate(current);
                  })
                  .catch(() => {
                    if (
                      mounted.current &&
                      latest.current.service === service &&
                      revision === latest.current.identityRevision
                    ) {
                      setFailed(true);
                      refreshNavigation();
                    }
                  })
                  .finally(() => {
                    if (
                      mounted.current &&
                      latest.current.service === service &&
                      revision === latest.current.identityRevision
                    )
                      setPending(false);
                  });
              }}
            >
              <Icon className="size-4 shrink-0" />
              <span className="min-w-0 truncate">
                {locale === "en-US" ? menu.nameEn : menu.name}
              </span>
            </Button>
          );
        })
      ) : (
        <p role="status" className="px-3 py-2 text-ui-sm text-foreground-muted">
          {intl.formatMessage({
            id: navigation ? "enterprise.console.unavailable" : "common.loading",
          })}
        </p>
      )}
      {failed ? (
        <p role="alert" className="px-3 py-2 text-ui-sm text-destructive">
          {intl.formatMessage({ id: "enterprise.console.unavailable" })}
        </p>
      ) : null}
    </nav>
  );
}
