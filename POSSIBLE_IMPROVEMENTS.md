# Possible Improvements

Sorted by expected impact and priority.

## 1. Centralize Pi theme configuration

Add `PI_THEME` to `src/config.ts` instead of reading `process.env.PI_THEME` directly in `src/pi-runner.ts`.

Impact:
- Keeps all runtime configuration validated in one place.
- Makes the theme setting visible in `publicConfig()` and deployment docs.
- Reduces hidden environment-variable behavior.

## 2. Deduplicate and throttle progress updates

Track the last progress message and skip repeated updates. Avoid sending generic updates like `Pi is thinking.` too often.

Impact:
- Prevents Linear activity spam during long sessions.
- Keeps useful tool/action updates visible.
- Reduces API calls to Linear.

## 3. Flush progress before error responses

Call `reporter.flush()` in the error path before posting the final Linear error activity.

Impact:
- Preserves the last useful progress update before a timeout or failure.
- Makes debugging failed runs easier.

## 4. Improve tool argument summaries

Make `summarizeToolArgs()` more tool-aware.

Examples:
- `bash`: show the redacted command.
- `read`, `write`, `edit`: show the target path.
- search tools: show the query.
- unknown tools: fall back to the tool name.

Impact:
- Makes Linear progress updates more informative.
- Helps users understand what Pi is doing without opening logs.

## 5. Report completion for long-running tools

For tools that take longer than a threshold, post a completion update such as `Finished bash npm test`.

Impact:
- Helps distinguish stuck commands from completed long-running work.
- Avoids noise by only reporting completion for slow operations.

## 6. Include elapsed time in final status

Record the start time of each run and include elapsed time in timeout/error messages.

Impact:
- Makes operational debugging easier.
- Helps users understand whether a run failed quickly or after a long timeout.

## 7. Make progress behavior configurable

Add configuration flags for progress reporting.

Possible settings:
- `PI_PROGRESS_ENABLED`
- `PI_PROGRESS_TOOL_UPDATES_ENABLED`
- `PI_PROGRESS_THINKING_UPDATES_ENABLED`

Impact:
- Allows quieter deployments.
- Makes noisy progress updates easy to disable without code changes.

## 8. Handle more SDK events

Consider mapping additional SDK events to Linear updates.

Useful candidates:
- `compaction_end`
- `auto_retry_end`
- `session_info_changed`

Impact:
- Improves observability for complex or long-running sessions.
- Helps diagnose retries and context compaction behavior.

## 9. Add tests for SDK event-to-Linear progress mapping

Extract or expose the event mapping enough to unit test it with a fake reporter.

Test cases:
- `agent_start` creates a start thought.
- `turn_start` creates a thinking thought.
- `tool_execution_start` creates a tool progress thought.
- `tool_execution_end` only reports errors.
- `message_end` creates no progress activity.

Impact:
- Protects the Linear session-state behavior from regressions.
- Documents why assistant messages are not mirrored as progress thoughts.
