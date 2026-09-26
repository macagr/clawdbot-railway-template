# rp-harness

A generic, campaign-agnostic harness for long-form narrative roleplay on OpenClaw 2026.9.5.

- **Explicit state is authority.** Models reason over filtered views of files under `state/`; no session transcript is canon.
- **Code derives, models decide.** Who holds which fact, what a role may see, revisions, speaker sets and form pressure are computed; models only cite ids and decide intent and prose.
- **One turn, one transaction.** `received → planned → drafted → validated → committed → delivered`; nothing mutates before commit.

Run it:

```
rp campaign source-sync                      # clone/fast-forward the private campaign repo (CAMPAIGNS_REPO_TOKEN)
rp campaign update <CAMPAIGN_ID>             # install <repo>/<CAMPAIGN_ID> into /data/workspaces/<CAMPAIGN_ID>, validate
#   or from any directory: rp campaign install --from <package> --to /data/workspaces/<CAMPAIGN_ID>
rp setup-openclaw --campaign /data/workspaces/<CAMPAIGN_ID> --dry-run
rp turn --campaign /data/workspaces/<CAMPAIGN_ID> --text "..."
```

Documentation index: [docs/README.md](docs/README.md). Tests: `npm run test:harness` from the repository root (Node 24).

No real campaign content lives here. Placeholders such as `<CAMPAIGN_ID>`, `<PC_ID>`, `<NPC_A>` are used throughout; the only concrete data is the synthetic fixture under `test/fixtures/campaign-generic/`.
