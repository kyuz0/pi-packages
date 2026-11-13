# Testing automatic review

Run from the repository root with Node.js 22.19 or newer and npm 11:

```sh
npm ci
npm run check
npm test
```

The Linux sandbox tests also require bubblewrap, socat and ripgrep. Report platform
skips separately. The default suite uses synthetic sessions and model responses;
it makes no live inference calls. Audit tests use temporary storage.

For the reviewer alone:

```sh
npm run test --workspace=@erichll/pi-auto-review
```

To repeat a specific regression without dropping the TypeScript loader:

```sh
cd packages/pi-auto-review
node --disable-warning=ExperimentalWarning --experimental-transform-types \
  --import ./test/register-external-ts.mjs --test \
  --test-name-pattern='compaction|rollover|history|omitted' test/*.test.ts
```

## Coverage and ownership

Extension behavior and regression tests belong here. Factory owns tests of its
installed Pi/Pendant clients, configuration, images and dependency pins.

| Contract | Tests in `test/` |
| --- | --- |
| Original instructions survive compaction; summaries cannot grant permission; sibling branches cannot contribute permission; rebuilding a session preserves originals | `retained-session.test.ts`, `retained-context.test.ts` |
| In-flight authorization is invalidated by edited instructions, branch or session changes | `retained-review.test.ts`, `conversation.test.ts`, `authorizer-integration.test.ts` |
| Long reviewer histories roll over; omitted messages are explicit; older permission is marked possibly superseded; parallel sessions remain separate | `reviewer-resilience.test.ts`, `conversation.test.ts` |
| Final serialized input fits the configured budget, including framing and escaping; whole messages are omitted rather than partially quoted | `reviewer-resilience.test.ts`, `retained-context.test.ts` |
| Screenshot text and attachment metadata survive; image bytes are excluded; unsupported content cannot invent permission | `retained-context.test.ts`, `retained-review.test.ts`, `reviewer-resilience.test.ts` |
| Provider errors, context rejection, malformed output, aborts and retries recover within the configured deadline | `conversation.test.ts`, `reviewer-resilience.test.ts`, `review-provider.test.ts`, `reviewer-model.test.ts` |
| Automatic mode never opens a human permission gate, including invalid config, unavailable review and capped native-file requests | `authorizer-integration.test.ts`, `broker.test.ts` |
| Hard denies precede model review; shell quotation and command boundaries preserve the documented best-effort scanner behavior | `policy.test.ts`, `shell-text.test.ts`, `broker.test.ts` |
| Exact grants expire and are consumed once; forwarded requests retain their identity; explicit questions remain separate evidence | `broker.test.ts`, `broker-service.test.ts`, `override.test.ts`, `question-evidence.test.ts`, `authorizer-integration.test.ts` |
| TUI/RPC bridges approve only the matching one-time choice; machine approvals cannot become human evidence for allow-rule suggestions | `ui-auto-confirm.test.ts`, `rpc-auto-confirm.test.ts`, `policy-audit.test.ts`, `authorizer-integration.test.ts` |
| Denials, uncertainty and reviewer outages have distinct wording; final reasons survive the permission event and next turn | `user-feedback.test.ts`, `authorizer-integration.test.ts` |

`retained-session.test.ts` uses the installed Pi SessionManager. It explicitly
checks that compaction removes an old instruction from the model-visible context
while the reviewer can still retrieve its original from the active branch. These
tests run in the default suite, alongside synthetic repeated-compaction cases.
Factory also checks loading compacted session files through each installed client.

Bounded context may omit older originals; tests require explicit omissions and
prevent omitted text from being treated as inspected. A summary is never a
substitute for original authorization. Image metadata does not claim that the
reviewer inspected the image.

## Installed clients and live inference

Run Factory's [automatic-review integration recipe](https://github.com/kyuz0/pi-sandbox-factory/blob/main/TESTING.md#automatic-review)
against a disposable sandbox using the candidate extension pin. It drives the real
Pi RPC client and shipped Pendant worker with compacted session files, a screenshot,
restricted reviewer input, history rollover, revocation, renewed authorization
and a deterministic hard deny. It fails on a permission dialog or incorrect result.

First use scripted reviewer replies. With explicit authorization, repeat with
`--review-model PROVIDER/MODEL --review-models CATALOGUE.json`. Only reviewer calls
use live inference; main-agent replies stay scripted. Keep real credentials in the
managed inference companion and use placeholder credentials in the catalogue.
Fixture tests establish controller behavior; live tests also exercise provider
transport and model judgment. Neither proves every future model decision correct.
The older `stateful-live.mjs` is a separate OpenAI-compatible standalone experiment;
it does not replace the installed Pi/Pendant recovery checks.

## Authentication policy

`test/authentication.test.ts` checks that scoped login authorization and later
restrictions survive compaction in both reviewer modes, and credential-network
hard denies remain active. It also checks stream failures and rejects unavailable
reviews as test passes. These fixture tests do not evaluate model judgment.

With authorization for live inference, run the synthetic authentication scenarios
against a managed Anthropic-compatible inference socket supporting adaptive
thinking:

```sh
node --experimental-transform-types --import ./test/register-external-ts.mjs \
  test/authentication-live.ts --socket /run/inference/proxy.sock \
  --route '/r/provider/api/v1/messages?beta=true' --model MODEL_ID \
  --report /tmp/authentication-results.json
```

Run from this package in a disposable environment. Mount only the inference
socket alongside the read-only package checkout and a writable report directory;
never mount credential storage or a user workspace. The matrix reviews fifteen
synthetic scenarios in both reviewer modes: scoped advice, helper creation,
interactive login, same-service session use, secret printing, advisor disclosure,
third-party upload, session-file permission widening, revoked persistence, existing-profile access,
helper leaks, cross-service collection, Git commits and profile harvesting. An
unseen script must defer for inspection; automatic mode returns that as a denial
without a dialog. The positive login case includes its complete helper body.
It uses the real review controller and automatic broker, consumes each allowed
grant once, executes no proposed commands and never opens a permission dialog.
The report records raw model outcomes, broker decisions, denial sources, model-call
counts and source/fixture hashes. Transport/controller errors and missing model
judgments fail the run, including expected-denial cases;
`--repeats 2` repeats each case. A failed or incomplete matrix is not a pass.

## Adding a regression

1. State the supported behavior and reproduce the failure with a focused test.
   Use a minimal synthetic session, permission request and model response.
2. For compaction, use the real SessionManager test when the issue depends on Pi's
   branch or context APIs. Check original restrictions and reject forged summary
   authorization; checking only a successful tool result is insufficient.
3. For automatic mode, assert the operation result **and** zero human dialogs.
   Distinguish model denial, model uncertainty and controller unavailability.
   After an outage, test recovery on a fresh request. After a denial, ensure the
   agent is not invited to retry the same action by rephrasing it.
4. For budgets and images, inspect the actual serialized reviewer envelope. Assert
   the input bound, explicit omissions, required text and absence of binary data.
   For concurrency, prove session separation and reject stale results.
5. Add a Factory regression when the failure depends on installed configuration,
   Pi RPC, Pendant IPC or container integration. Include both clients where relevant.
6. Run the focused test, type checks and complete repository suite. Repeat installed
   client checks after runtime changes. Record exact revisions, commands, counts,
   skips and whether inference was scripted or live in the test run's artifacts.

Keep fixture transcripts, screenshots and credentials synthetic. Production changes
must reach this repository's `main` before Factory publishes their immutable pin.
