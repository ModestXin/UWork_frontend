# Gateway catalog invalidation

EnterpriseIdentityService remains the only session/generation/revision owner. UcasGatewayService owns its existing projected scope and admission epoch. A Node-only catalog admission port reads that original scope and publishes invalidation; it carries no token, model list or accepted permission value and is not a string RPC.

Revoking the original identity scope synchronously closes managed catalog reads before asynchronous persistence cleanup. An authenticated replacement identity has no admitted managed catalog until its original full Gateway sync commits. Failure to clear disk never restores an invalid scope.

Model selection adapts the original ProviderRegistryFacadeSource without replacing Registry or ProviderSettings ownership. It removes only UCAS with enterprise-session access when the original Gateway catalog admission is invalid. Registry Provider instances for ordinary UCAS/API-key and all other providers retain their identity. The original facade still computes preferred/effective selection from this projected registry.

The existing model view event delivers explicit removal promptly; an input-specific Hook must not retain the revoked managed candidate while awaiting its normal current-input read. Ordinary transient read failures retain the existing ready contract. Draft/history and configured preferences remain their original owners' data.

Persistence uses only the existing private Gateway provisioning command and Provider Repository lock. A narrow clear request is conditional on the current locked UCAS access still being enterprise-session. It clears only derived IDs/names, leaves endpoint/membership/rules/order/preferences untouched, and rechecks the original invalidation admission inside that lock. Public provisioning rejects this private command. A newer identity/catalog operation invalidates an older clear or response; no second writer, timer or authorization store is introduced.
