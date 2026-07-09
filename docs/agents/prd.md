# PRDs: Local Markdown

PRDs/specs for this repo live as markdown files in the repository.

## Conventions

- Store PRDs/specs under `docs/specs/`.
- Use one file per feature: `docs/specs/<feature-slug>.md`.
- PRDs/specs are product/specification documents, not implementation issue lists.
- If implementation issues are created later, they should reference the spec path.

## When a skill says "publish the PRD"

Create or update the relevant PRD/spec markdown file in `docs/specs/`.

## When a skill says "fetch the PRD"

Read the referenced markdown file. If the user gives a feature name instead of a path, search `docs/specs/` first.
