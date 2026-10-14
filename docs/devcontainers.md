# Managed devcontainers

The fork supports Pi 1.2.0 and retains its customized automatic review policy,
RPC confirmation support, and reviewed escalation tool. Install this repository
at an immutable commit; its npm workspace links resolve the review and sandbox
extensions to the fork's source, not published copies of those extensions.

A container image can run `npm ci --omit=dev`, then
`python3 scripts/prepare-container.py` as root with Python 3, gcc, libc development
files, libseccomp/libcap/libselinux development files, Meson, Ninja and pkg-config
installed. The build requires network
access to the checksummed Bubblewrap 0.13.0 and Sandbox Runtime source archives. The script verifies
its supported dependency versions before adapting them and recompiles the native
Unix-socket filter helper for x86-64 or arm64.

Set `PI_SANDBOX_CONTAINER=1` only in an isolated devcontainer. Install root-owned
`auto-review.json`, `permissions.json` and `sandbox.json` under
`/opt/pi-security/config`. The permission dependency then ignores workspace policy
overrides. Load the fork's auto-review extension, the permission-system extension,
the reviewed-escalation extension and the fork's sandbox extension, in that order.
Normal installations without this environment flag keep their existing paths.

Nested execution binds the outer container's isolated devices and proc filesystem
instead of creating mounts unavailable in rootless containers. The seccomp helper
retains its PID/user namespaces, Unix-socket filter and non-dumpable supervisor;
its existing failed proc-remount fallback also handles SELinux's EACCES. Read-only
regular-file masks protect denied files without binding device inodes onto a
workspace. The outer container must remain nonprivileged and must not mount host
processes, devices, engine sockets, or broad host directories.

For proxy-only containers, set `SANDBOX_NETWORK_MODE=allowlist` and
`HTTPS_PROXY=http://127.0.0.1:3128`. The gateway must enforce exact destination
hostnames and ports. Hostname syntax checks and automatic review remain active;
DNS resolution belongs to the gateway. Other modes retain public DNS validation.
Reviewed escalation runs in the outer devcontainer and cannot exceed its access.
