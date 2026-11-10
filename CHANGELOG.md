# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-11-10

First public release. `dsh-reakit` is not a thin adapter: it ships a managed
Node and REA runtime plus a control surface for the harness.

### Changed

- Version switching keeps a single generation on disk: after a successful switch
  the replaced version is deleted, so returning to it re-installs it (and needs
  network). Rollback refuses with an explanation when the previous version is gone.

### Fixed

- The managed runtime is published as two independent trees (`node/` and
  `engine/`), each with its own ready marker. A fresh install no longer writes a
  combined generation, so removing the Node part only costs a re-download.

### Added

- **Bring your own REA.** After adopting, the downloaded Node can be deleted to reclaim
  space while the installed REA engine is kept, so switching back only re-downloads Node. Settings → REA → *Existing REA installation* detects a globally
  installed `rea-agents`, validates its `scripts/rea.mjs` entry and its `engines.node`
  contract (managed Node first, host Node second), and adopts it as the manual `nodePath` / `reaEntry`
  pair. Every Node the plugin can find is listed with its version and whether it satisfies the
  REA `engines.node` range; an incompatible choice shows the required range and offers a
  one-click upgrade to the plugin-managed Node. *Switch back to the managed runtime* clears it again. Detection never runs npm or
  REA, and an incompatible install is reported as a reason instead of a ready state.
- **Managed runtime.** On first start the plugin provisions a pinned Node
  24.22.1 and REA 6.8.0 from official sources, using a fully locked
  dependency graph (`npm ci --ignore-scripts --include=optional`). No global
  `npm i -g rea-agents` is needed, and the system or DSH Node, shell `PATH`
  and user `npmrc` are never modified.
- **Complete tool catalogue.** All 229 REA MCP tools are registered as
  `mcp__rea__*`; the plugin never trims the catalogue by tool type.
- **Global switch** in settings and a matching **composer quick switch**, both
  driving the same `setEnabled` / ConfigEditor state. Display preference is
  stored separately through official Config Forms and never restarts REA.
- **Live status indicator** on the composer button: off, ready, running a tool
  call (pulsing), just finished (one-shot ripple), starting, failed and
  unknown. Disabling REA while a tool call is in flight is refused by both the
  UI and the host.
- **On-demand optional tool setup** as a collapsed section with a copyable
  AI setup prompt. It targets this installed plugin instance only, never the
  upstream repository tutorial, and never installs anything by itself.
- **Dependency hints** derived read-only from reviewed REA error codes, so a
  missing optional provider is reported only when a real call fails that way.
- **Runtime version management**: an explicit "check for updates" step that
  reads official npm and Node.js metadata, prepares a candidate in an isolated
  staging directory, verifies the full dependency lock, and publishes it
  atomically. The previous generation is preserved and can be rolled back.
- **Bilingual UI** (English and Chinese) through the official DSH locale API,
  with backend diagnostics in English.
- 192 unit, integration and failure-recovery tests.

### Added

- When no usable Node exists, the plugin asks where to install it instead of
  downloading on its own: into the plugin environment, or on the machine using a
  detected installer (Homebrew, nvm, apt, dnf, winget, Chocolatey) with the exact
  command and a re-detect step.

### Added

- Setup failures are classified as network, disk or permission problems and
  reported with the managed root and the next step; every other failure keeps
  its original message.

### Added

- `npmRegistry` accepts an https mirror (no credentials, query or fragment) for
  the REA package install. Package integrity still comes from the lockfile SRI, so
  using a mirror never weakens verification.

### Added

- `nodeMirror` points the Node archive at an https mirror. The mirror's own
  `SHASUMS256.txt` must agree with the pinned digest before extraction, so a
  mirror can never substitute different bytes.

### Fixed

- The settings pane could render completely blank when the existing-REA block
  referenced a state variable it never declared. The block now declares its own
  notice state, and a component-level test renders it directly so this class of
  crash cannot come back.

- Deleting the managed runtime is refused while another DSH profile still runs REA in
  managed mode, and the blocking profiles are named.
- Abandoned `.setup-*` staging trees from failed installs are removed before the next
  attempt instead of accumulating hundreds of MB each.
- Global REA detection now also covers the Windows locations (`%APPDATA%\npm`,
  `%LOCALAPPDATA%\pnpm`, `%ProgramFiles%\nodejs`).

### Security

- Downloads are integrity-checked against pinned SHA-256 digests and npm SRI
  values; package lifecycle scripts stay disabled.
- Version switching requires two explicit confirmations (session exported, and
  restart acknowledged) and refuses to proceed while analysis work is active.
- Analysis targets, devices, browsers and commercial licences are never
  started or handled automatically.
