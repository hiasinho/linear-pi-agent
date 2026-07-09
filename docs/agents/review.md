# Review Workflow

How review skills should find the source request and choose a diff base in this repo.

## Spec Source

Use the first available source:

1. A spec path or GitHub issue reference provided by the user.
2. A spec or issue reference found in commit messages or branch name.
3. A matching spec under `docs/specs/`.
4. The current conversation or direct user request.

If no spec source exists, review the diff for correctness and risk without a spec comparison, and say that no spec was available.

## Fixed Point

If the user supplies a fixed point, use it. Otherwise compare the current work against the branch merge-base with `main`.

Default command shape:

```bash
git merge-base HEAD main
```

Then review the diff from that merge-base to the current work.
