import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { UcasGatewayPanel } from "@/settings/ucas-gateway/UcasGatewayPanel.js";
import { createPort, CASE_NAMES, type CaseName } from "./port.js";
import { accessor } from "./accessor.js";

function readCase(): CaseName {
  const name = new URLSearchParams(location.search).get("case");
  const found = CASE_NAMES.find((candidate) => candidate === name);
  if (!found) throw Error("Finite case required");
  return found;
}
let runtimeErrors = 0;
const recordRuntimeError = () => {
  runtimeErrors++;
  document.documentElement.dataset.ownedRuntimeErrors = String(runtimeErrors);
};
window.addEventListener("error", recordRuntimeError);
window.addEventListener("unhandledrejection", recordRuntimeError);
function Fixture() {
  const [, repaint] = useState(0);
  const notify = useCallback(() => repaint((n) => n + 1), []);
  const ports = useMemo(
    () => ({ A: createPort(readCase(), notify), B: createPort(readCase(), notify, "B") }),
    [notify],
  );
  const [selected, setSelected] = useState<"A" | "B">("A");
  const current = ports[selected];
  const services = useMemo(() => accessor(current.service), [current]);
  const layoutReads = useRef<Array<{ selected: "A" | "B"; text: string }>>([]);
  useLayoutEffect(() => {
    layoutReads.current.push({
      selected,
      text: document.querySelector("[data-testid=actual-panel]")?.textContent ?? "",
    });
    const output = document.querySelector("[data-testid=layout-facts]");
    if (!output) throw Error("Fixture layout observer missing");
    output.textContent = JSON.stringify(layoutReads.current);
  }, [selected]);
  return (
    <main>
      <h1>Owned actual Gateway panel delivery-order probe</h1>
      <nav aria-label="Finite test producer controls">
        <button onClick={() => ports.A.emitCurrent()}>Deliver current A event</button>
        <button onClick={() => ports.A.emitSignedOut()}>Deliver current signed-out event</button>
        <button onClick={() => ports.A.emitB()}>Deliver new B event</button>
        <button onClick={() => ports.A.deliverInitial()}>Deliver old initial response</button>
        <button onClick={() => ports.A.deliverSync()}>Deliver old sync response</button>
        <button onClick={() => ports.A.deliverUsage()}>Retire old usage request</button>
        <button onClick={() => setSelected("B")}>Replace service with B</button>
        <button onClick={() => ports.B.deliverInitial()}>Deliver B initial response</button>
        <button onClick={() => ports.B.deliverSync()}>Deliver B sync response</button>
        <button onClick={() => ports.A.deliverCapturedUsage()}>
          Deliver captured usage response
        </button>
        <button onClick={() => ports.A.deliverCapturedUsageEvent()}>
          Deliver captured usage event
        </button>
        <button onClick={() => ports.A.emitNewerUsage()}>Deliver newer usage event</button>
        <button onClick={() => ports.A.rejectUsage()}>Reject usage request</button>
      </nav>
      <output data-testid="producer-facts">
        {JSON.stringify({ selected, A: ports.A.facts(), B: ports.B.facts(), runtimeErrors })}
      </output>
      <output data-testid="layout-facts" />
      <ServiceProvider services={services}>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <section data-testid="actual-panel">
            <UcasGatewayPanel />
          </section>
        </ZCodeIntlProvider>
      </ServiceProvider>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw Error("Fixture root required");
createRoot(root).render(<Fixture />);
