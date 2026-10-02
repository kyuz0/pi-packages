# Reviewed Bash escalation

Local Pi extension exposing `bash_escalate`. Ordinary `bash` retains the OS
sandbox. The escalation tool requires an exact command and justification,
then submits a host-execution request to the active auto-review broker.

A model allow must carry a valid one-use grant bound to the full request and
session. A model deferral asks the user to approve that exact command through
Pi's UI. Denials, absent brokers, invalid grants and cancellation do not run
anything. A reviewer outage follows the global reviewer's failure mode.

Approved execution runs as the current user outside the sandbox. It can use
host credentials, network and sockets; it does not provide root privileges.
It is unavailable to sandboxed child agents. Review and manual decisions are
recorded in the session as `pi-reviewed-escalation` entries.

The trusted permission rule `"bash_escalate": "allow"` avoids a redundant
generic tool-name review; the tool's mandatory exact host-execution review
still runs every time. No persistent host authorization is granted.

The installed `pi-auto-review` bridge supports both terminal and VS Code/RPC
external-file confirmations. A model allow auto-confirms only the immediately
matching request once; it does not grant access for the whole session. Model
deferrals and denials continue through the normal permission flow.
