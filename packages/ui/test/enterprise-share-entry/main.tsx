import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { UserInfo } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import {
  EnterpriseIdentityProvider,
  useEnterpriseIdentity,
} from "@/hooks/useEnterpriseIdentity.js";
import { WorkspaceHeaderActionSection } from "@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js";
import { createIdentity, platform, providerSettings } from "./ports.js";

document.documentElement.dataset.fixtureErrors = "0";
for (const event of ["error", "unhandledrejection"])
  window.addEventListener(event, () => {
    document.documentElement.dataset.fixtureErrors = String(
      Number(document.documentElement.dataset.fixtureErrors) + 1,
    );
  });

const legacyUser: UserInfo = {
  id: "owned-retired-user",
  username: "owned-retired-user",
  displayName: "Owned retired user",
};
type Identity = ReturnType<typeof createIdentity>;

function Surface({
  identity,
  managed,
  user,
  activeTaskId,
  isDesktop,
  controls,
}: {
  identity: Identity;
  managed: boolean;
  user: UserInfo | null;
  activeTaskId: string | null;
  isDesktop: boolean | undefined;
  controls: ReactNode;
}) {
  const current = useEnterpriseIdentity();
  const facts = {
    managed,
    status: current ? (current.view?.status ?? "pending") : "no-context",
    currentMember: current?.view?.profile?.id ?? null,
    ownerName: identity.name,
    legacyUser: user !== null,
    activeTaskId,
    isDesktop: isDesktop ?? "unspecified",
  };
  return (
    <main>
      <h1>Owned enterprise sharing entry regression</h1>
      <section aria-label="Fixture controls">
        {controls}
        <button onClick={() => void current?.logout()}>Sign out</button>
      </section>
      <section aria-label="Actual workspace header">
        <WorkspaceHeaderActionSection
          variant="draft"
          activeTaskId={activeTaskId}
          user={user}
          workspaceAbsPath="/owned/component-workspace"
          isDesktop={isDesktop}
          isTerminalOpen={false}
          isSidePaneOpen
          onToggleTerminal={() => {}}
          onToggleSidePane={() => {}}
          simplifyForNarrowRemote
          hideHelpMenu
        />
      </section>
      <output data-testid="share-entry-facts">{JSON.stringify(facts)}</output>
    </main>
  );
}

function Fixture() {
  const scenario = new URL(location.href).searchParams.get("case");
  const [managed, setManaged] = useState(!scenario?.startsWith("legacy-"));
  const [user, setUser] = useState<UserInfo | null>(
    [
      "managed-signed-out",
      "managed-pending",
      "task-constraint",
      "desktop-constraint",
      "legacy-compatible",
    ].includes(scenario ?? "")
      ? legacyUser
      : null,
  );
  const [identity, setIdentity] = useState(() =>
    createIdentity(
      scenario === "managed-pending" ? "B" : "A",
      scenario === "managed-pending"
        ? null
        : scenario === "managed-signed-out"
          ? "signed-out"
          : "authenticated",
    ),
  );
  const [activeTaskId, setActiveTaskId] = useState<string | null>("owned-task");
  const [isDesktop, setDesktop] = useState<boolean | undefined>(true);
  const controls = (
    <>
      <button onClick={() => setUser(legacyUser)}>Set legacy</button>
      <button onClick={() => setUser(null)}>Clear legacy</button>
      <button onClick={() => setIdentity(createIdentity("B", null))}>Switch identity</button>
      <button onClick={() => identity.authenticate()}>Authenticate current</button>
      <button onClick={() => setActiveTaskId(null)}>Remove task</button>
      <button onClick={() => setActiveTaskId("owned-task")}>Restore task</button>
      <button onClick={() => setDesktop(false)}>Web</button>
      <button onClick={() => setDesktop(true)}>Desktop</button>
      <button onClick={() => setDesktop(undefined)}>Desktop unspecified</button>
      <button onClick={() => setManaged((value) => !value)}>Toggle identity context</button>
    </>
  );
  const surface = (
    <Surface
      identity={identity}
      managed={managed}
      user={user}
      activeTaskId={activeTaskId}
      isDesktop={isDesktop}
      controls={controls}
    />
  );
  return (
    <ZCodeIntlProvider initialLocale="en-US">
      <TooltipProvider>
        <PlatformProvider platform={platform}>
          {managed ? (
            <EnterpriseIdentityProvider
              service={identity.service}
              providerSettingsService={providerSettings}
              showOnStartup={false}
            >
              {surface}
            </EnterpriseIdentityProvider>
          ) : (
            surface
          )}
        </PlatformProvider>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
