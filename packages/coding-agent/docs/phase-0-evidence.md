# Havk Local Sudo — Phase 0 Capability Matrix & Evidence Report

## S0: Environment & Topology Inventory

- **Target System**: Linux VM-16-15-ubuntu 7.0.0-30-generic #30-Ubuntu SMP PREEMPT_DYNAMIC Fri Jul 31 18:22:54 UTC 2026 x86_64 GNU/Linux
- **Distribution**: Ubuntu 26.04 LTS (Resolute Raccoon)
- **Node.js**: v24.21.0
- **npm**: 11.19.0
- **Sudo Executables**:
  - `/usr/bin/sudo` -> `/etc/alternatives/sudo` -> `/usr/lib/cargo/bin/sudo` (`sudo-rs 0.2.13-0ubuntu1`)
  - `/usr/bin/sudo.ws` (`Sudo version 1.9.17p2`, Todd Miller's C sudo)
- **Sudoers Defaults**: `Defaults use_pty`
- **User ubuntu Privileges**: `(ALL : ALL) ALL`, `(ALL) NOPASSWD: ALL` in `/etc/sudoers.d/90-cloud-init-users`
- **Linux Security Modules / Yama**: `/proc/sys/kernel/yama/ptrace_scope = 1` (restricted ptrace)
- **Core Dump Pattern**: `|/usr/share/apport/apport...`, `ulimit -c = 0` (dumps disabled)
- **Process Topology in Pi/Havk**:
  - Pi spawns child shells with `detached: true`, `stdio: [pipe/ignore, pipe, pipe]`
  - On Linux/Unix, `detached: true` executes `setsid()`, creating a new session ID and new process group with no controlling terminal (`/dev/tty`).

---

## S0–S9 Capability Matrix

| Gate | Capability | Result | Evidence Summary |
|------|------------|--------|------------------|
| **S0** | Environment & topology inventory | **PASS** | Complete environment, runtime, sudo-rs (`/usr/bin/sudo`) & C sudo (`/usr/bin/sudo.ws`), and detached topology mapped. |
| **S1A** | Secure one-shot password sudo | **DEFERRED** | Under same-UID Linux execution, an askpass helper returning credentials on stdout can be accessed or executed directly by agent commands without privilege separation. Deferred per PRD §6 S1A & §27; mediated sudo ships for NOPASSWD and native credentials. |
| **S1B** | Cross-invocation native timestamp reuse | **DEFERRED** | Sudo timestamp is keyed by session/TTY. Detached execution (`setsid()`) gives each command a distinct session with no TTY, preventing timestamp sharing across detached invocations. |
| **S1C** | Non-interactive credential refresh | **DEFERRED** | Dependent on S1B. Proactive refresh without TTY cannot be proven without password retention (prohibited). Deferred per PRD §6 S1C & §7. |
| **S2** | Privileged process lifecycle & cleanup | **PARTIAL** | Coordinated signal sequence (`SIGTERM` -> `SIGKILL` -> privileged group kill if permitted) reaps target process group and children when remaining in the PGID; unprivileged Havk cannot signal arbitrary root processes that disassociate or change PGID if passwordless sudo kill is unavailable. |
| **S3** | Final execution-context integrity | **PASS** | Binding approval at `resolveSpawnContext` ensures complete shell source, cwd, sanitized env (stripped `BASH_ENV`/`ENV`), and shell args match final execution. |
| **S4** | Sudo authorization state & approval dialog | **PASS** | Interactive approval dialog captures human consent (`Allow once`, `Allow for session`, `Deny`). `ALLOW_SUDO_SESSION` is scoped strictly to the logical session. |
| **S5** | ROOT_SESSION slash-command visibility | **DEFERRED** | Deferred alongside `ROOT_SESSION` per PRD §6 S1B & §7 rules. `/root` is deferred and informs user; `/root-off` does not act as an unverified de-elevation command. |
| **S6** | Auth-routing integrity & askpass anti-oracle | **FAIL / DEFERRED** | Agent-authored `-S`, `-A`, `-k`, `-K`, `-v`, `-b`, `sudoedit`, `SUDO_ASKPASS` are strictly blocked. However, same-UID askpass helper execution cannot be prevented from leaking credentials to an unprivileged child process without OS privilege separation. Password sudo is deferred; NOPASSWD mediation is supported. |
| **S7** | Same-UID process-memory isolation posture | **LIMITED** | Yama `ptrace_scope=1` prevents same-UID sibling/child `/proc/<pid>/mem` access, but host-dependent. Classified `LIMITED` and documented honestly. |
| **S8** | Explicit-sudo mediation coverage | **PASS** | Specialized command tokenizer with POSIX dequoting (`removeQuotes`) and wrapper unwrapping (`command -p`, `command --`, `exec --`, `env -u`, `nice`, `time`, `builtin`, `nohup`) covers all explicit sudo forms and reserved options while respecting `--`. |
| **S9** | Sudo I/O-logging secret-persistence | **NOT APPLICABLE** | Password-capable sudo over askpass is deferred; no passwords are submitted to sudo and no credential persistence occurs. |

---

## Architectural Decision

In accordance with PRD §1.3, §6 S1A/S1B/S1C/S6, §7, and §27:
- **Shipped Capabilities**:
  1. Default mediated explicit sudo approval in Local Linux Bash (`ASK`).
  2. One-request approval (`Allow this sudo command`).
  3. Session-wide approval (`Allow sudo for this session`, entering `ALLOW_SUDO_SESSION` committed only upon successful zero exit code).
  4. Logical session isolation: state unconditionally resets to `ASK` on clear, new session, switch session, resume, tree navigation, and reload.
  5. Final execution-context approval binding and display sanitization (ANSI/bidi safe and C1 control character neutralization).
  6. Strict reserved-option and askpass environment enforcement.
  7. Robust explicit sudo detection covering quotes and shell wrappers.
  8. Privileged process lifecycle coordination (`SIGTERM` -> `SIGKILL` -> privileged group sweep).
  9. Preservation of pre-feature semantics for PowerShell, non-Linux platforms, and custom/remote operations.
- **Deferred Capabilities**:
  1. Password-capable sudo (S1A & S6) is deferred because same-UID askpass helper execution acts as a password oracle without kernel-level privilege separation (a non-goal). Sudo mediation remains fully functional for `NOPASSWD` and native credentials; commands requiring interactive passwords fail closed safely.
  2. `ROOT_SESSION`, `/root`, and `/root-off` are deferred because S1B proved that native sudo timestamps under detached non-TTY process topology cannot be reused across subsequent invocations, and PRD §6 S1B/S1C explicitly prohibits retaining passwords or using a root daemon to simulate keepalive.
