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
| **S0** | Environment & topology inventory | **PASS** | Complete environment, runtime, sudo, and topology mapped. |
| **S1A** | Secure one-shot password sudo | **PASS** | On-demand askpass over private Unix domain socket; target runs at most once; NOPASSWD runs without prompt; secret zeroized. |
| **S1B** | Cross-invocation native timestamp reuse | **FAIL (DEFERRED)** | Sudo timestamp is keyed by session/TTY. Detached execution (`setsid()`) gives each command a distinct session with no TTY, preventing timestamp sharing across detached invocations. |
| **S1C** | Non-interactive credential refresh | **DEFERRED** | Dependent on S1B. Proactive refresh without TTY cannot be proven without password retention (prohibited). Deferred per PRD §6 S1C & §7. |
| **S2** | Privileged process lifecycle & cleanup | **PASS** | Coordinated signal sequence (`SIGTERM` -> grace -> `SIGKILL` -> privileged group kill if required) reliably terminates root target and privileged descendants. |
| **S3** | Final execution-context integrity | **PASS** | Binding approval at `resolveSpawnContext` ensures complete shell source, cwd, sanitized env (stripped `BASH_ENV`/`ENV`), and shell args match final execution. |
| **S4** | Secure password-input isolation | **PASS** | `setSecureInput` on `TuiBase` captures terminal bytes before `inputListeners`, editor, shortcuts, or queues. Masked feedback (`*`). |
| **S5** | ROOT_SESSION slash-command visibility | **DEFERRED** | Deferred alongside `ROOT_SESSION` per PRD §6 S1B & §7 rules. |
| **S6** | Auth-routing integrity & askpass anti-oracle | **PASS** | Agent-authored `-S`, `-A`, `-k`, `-K`, `-v`, `-b`, `sudoedit`, `SUDO_ASKPASS` blocked. One-shot single-use random token with immediate socket closure prevents replay/oracles. |
| **S7** | Same-UID process-memory isolation posture | **LIMITED** | Yama `ptrace_scope=1` prevents same-UID sibling/child `/proc/<pid>/mem` access, but host-dependent. Classified `LIMITED` and documented honestly. |
| **S8** | Explicit-sudo mediation coverage | **PASS** | Specialized command tokenizer covers all explicit sudo forms, aliases, prefixes, and reserved options while respecting `--`. |
| **S9** | Sudo I/O-logging secret-persistence | **PASS** | Askpass helper output is piped to sudo's internal PAM routine, not target command stdin; secret is absent from sudo I/O logs. |

---

## Architectural Decision

In accordance with PRD §1.3, §6 S1B/S1C, §7, and §27:
- **Shipped Capabilities**:
  1. Default mediated explicit sudo approval in Local TUI (`ASK`).
  2. One-request approval (`Allow this sudo command`).
  3. Session-wide approval (`Allow sudo for this session`, entering `ALLOW_SUDO_SESSION`).
  4. On-demand one-shot askpass authentication routing with zeroized memory.
  5. Isolated TUI masked password entry (`setSecureInput`).
  6. Final execution-context approval binding and display sanitization (ANSI/bidi safe).
  7. Strict reserved-option and askpass environment enforcement.
  8. Reliable privileged lifecycle cleanup.
- **Deferred Capabilities**:
  - `ROOT_SESSION`, `/root`, and `/root-off` are deferred because S1B proved that native sudo timestamps under detached non-TTY process topology cannot be reused across subsequent invocations, and PRD §6 S1B/S1C explicitly prohibits retaining passwords or using a root daemon to simulate keepalive.
