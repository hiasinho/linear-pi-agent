## Agent skills

### PRDs

PRDs/specs live as local markdown under `docs/specs/<feature-slug>.md`; skills should create, update, and read specs there. See `docs/agents/prd.md`.

### Issue tracker

Implementation issues are tracked in GitHub Issues using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context repo: use optional root `CONTEXT.md` and root `docs/adr/` when present. See `docs/agents/domain.md`.

### Review

Review uses user-provided specs/issues first, then branch/commit references, then matching specs under `docs/specs/`; default diff base is merge-base with `main`. See `docs/agents/review.md`.
