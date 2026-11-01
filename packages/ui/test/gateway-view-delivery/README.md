# Gateway view delivery regression

This fixture mounts the production `UcasGatewayPanel` and Hook with the real service and internationalization providers. Its finite typed service delivers schema-valid public snapshots in a controlled order. It does not contact an identity provider, backend, model, user profile or retained Native data.

Run from the client workspace root with three explicit executable paths and a new evidence directory:

```sh
UWORK_TEST_CHROME_PATH=/absolute/path/to/chrome-headless-shell \
UWORK_TEST_BROWSER_HARNESS=/absolute/path/to/browser-harness \
UWORK_TEST_BH_PYTHON=/absolute/path/to/browser-harness-python \
pnpm test:gateway-view-delivery /absolute/path/to/new-evidence-directory
```

The root script prepares the existing dependency declarations, runs strict fixture type checking and then uses browser-harness with a new private headless profile. It never discovers or opens the user's Chrome profile. The browser step has a four-minute deadline, preserves each result and checks owned process, port and scratch cleanup. An existing evidence directory is rejected.

The ten cases cover late initial/sync responses after signed-out, retired usage selection, service replacement, the first committed layout, busy isolation, normal cold sync, a usage response before its event, a lower-revision usage response and a rejected usage request. The first-layout observer only reads the production panel DOM. The panel stays at the same React position without a forced remount.

Snapshot capture permits a missing Sync button during the correct loading state. Actions in ready/cold/held states still require the actual control. A disabled button is never bypassed with synthetic dispatch. Driver exceptions and forbidden accessor reads fail validity checks independently from business assertions.

Exit code 0 means all ten component contracts pass. Business failures return 1; driver validity errors return 2. Inspect `results.json`, `case-verdict.json` and `cleanup.json` together. Raw CDP events are bounded diagnostics and do not establish complete network coverage. These component tests do not replace Native or real HTTP identity acceptance.
