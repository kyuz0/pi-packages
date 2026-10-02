# Pi configuration

This profile preserves the installed current-model reviewer setup. It contains
permission and loading configuration; credentials, provider connection settings,
session history and audit logs are stored separately.

| File | Global destination |
| --- | --- |
| `auto-review.json` | `~/.pi/agent/extensions/pi-auto-review/config.json` |
| `permissions.json` | `~/.pi/agent/extensions/pi-permission-system/config.json` |
| `settings-packages.json` | Merge its package entries into `~/.pi/agent/settings.json` |

The reviewer uses the current session model, a 4,096-token output budget and a
240-second total deadline. Low/medium risk can pass with weak authorization;
high risk requires sufficient authorization and narrow scope. Hard denies remain.

Ordinary Bash runs in `@erichll/pi-sandbox`. The separate `bash_escalate` tool
reviews the exact command before host execution. Its `allow` permission avoids
a duplicate generic tool review; it does not bypass the internal broker.
The eight installed Slack tools, `schedule_prompt`, `advisor_ask` and
`advisor_status` have explicit allow rules. Other tools use the default ask rule.

Restore the reviewer from `packages/pi-auto-review` and the host-execution
extension from `packages/pi-reviewed-escalation` into trusted installations
outside the agent's writable workspace. The recorded package entries point to
`~/.pi/agent/local-packages/`; adjust absolute paths for another account.
Both installations need the Pi SDK and peer dependencies available to the host.
Keep the published npm reviewer autoload disabled so only one reviewer loads.
Load the reviewer before the escalation extension and sandbox, then reload Pi.

`local-overrides.json` records the installed adaptations now preserved in this
branch. It is bookkeeping, not a Pi runtime configuration file. The obsolete
`~/.pi/agent/sandbox.json` belongs to the disabled unscoped sandbox package and
is not part of this profile.
