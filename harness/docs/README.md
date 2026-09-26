# Harness documentation

| Topic | Document |
|---|---|
| Architecture, invariants, agent topology, OpenClaw integration | [architecture.md](architecture.md) |
| State model, epistemology, truth and candidates, NPC minds vs craft | [state-and-epistemology.md](state-and-epistemology.md) |
| Turn transaction lifecycle, context builder, validation, Editor, shape ledger | [turn-pipeline.md](turn-pipeline.md) |
| Workspace format, campaign package format, adding a new campaign | [campaign-package.md](campaign-package.md) |
| Voice cards, exemplars, casting, SillyTavern adapter | [voices-and-casting.md](voices-and-casting.md) |
| Modes, presentation, branching, commands | [modes-commands-branching.md](modes-commands-branching.md) |
| Save/sync, persistence adapters, webhook API, n8n integration | [persistence.md](persistence.md), [examples/n8n-contract.md](examples/n8n-contract.md) |
| Model adapters, roles, metering and budgets | [models-and-budgets.md](models-and-budgets.md) |
| Transports: Discord, OpenClaw UI, CLI | [transports.md](transports.md) |
| CLI reference and operator tools | [cli.md](cli.md) |
| Testing, live smoke tests, reconstruction test, disaster recovery, upgrading | [operations.md](operations.md) |

Every document uses placeholders (`<CAMPAIGN_ID>`, `<PC_ID>`, `<NPC_A>`, `<FACT_A>`, `<EVENT_A>`, `<LOCATION_A>`, `<GROUP_A>`, `<CHANNEL_A>`, `<SCOPE_A>`). Concrete names belong in a campaign package.
