# Current-chat scheduling

This integration uses `pi-schedule-prompt` 0.4.1's published scheduler, persistence
and tool implementation. Prompts are injected into the originating Pi session;
the session's model, tool extensions, reviews and command sandbox remain active.
It does not start another agent. No upstream source is patched.

Ask Pi to schedule a prompt once (`+5m`), at an interval (`10m`), or with a six-field
cron expression. `/schedule-prompt` lists this chat's jobs; `disable ID`, `enable ID`,
`remove ID` and `cleanup` manage them in both terminal and RPC clients.

Jobs live in `.pi/schedule-prompts.json` and belong to the session that created them.
Timers stop when that session closes. Resume that same session to load its jobs;
missed one-shot jobs are disabled, and missed recurring runs are not replayed.
`cleanup` removes disabled jobs belonging to this chat. Unsupported background-agent
or unbound jobs are left on disk but never scheduled by this integration.

The model-facing schema omits per-job models, extensions, skills and notification
options. Runtime validation and filtered startup/fire-time reads enforce the same
restriction for direct calls, persisted jobs and another chat in the same workspace.
Installed extensions remain trusted code; the container is the OS boundary.
