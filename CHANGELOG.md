# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] — 2026-11-11

Compatibility with DSH 0.2.2-rc.2.

### Fixed

- `engines.dsh` was pinned to the exact `0.2.2-rc.1`, so DSH 0.2.2-rc.2 marked the
  plugin incompatible and disabled it. The declaration is now a range
  (`>=0.2.2-rc.1`), the same shape other bundles use.

## [0.1.2] — 2026-11-11

Version management now only moves forward, and a plugin-managed runtime can be
upgraded without first having a transition record.

### Changed

- **Forward-only.** The rollback path is gone: a successful upgrade deletes the
  replaced version, so the panel offers one action (prepare and upgrade) instead
  of a rollback that could only re-download.
- Wording follows the behaviour: "version upgrade" everywhere, with no rollback
  or switch-back phrasing left in the panel.

### Fixed

- A runtime whose pair sits inside `runtime/node` is recognised as plugin-managed
  and can be upgraded; previously every upgrade was refused as a manual
  configuration unless a transition record already existed. An adopted pair
  outside the managed root is still refused.

## [0.1.1] — 2026-11-11

Runtime layout, adoption and enterprise-network work. Nothing here changes the
public tool surface: the plugin still registers all 229 REA tools.

### Added

- **Bring your own REA.** *Settings → REA → Existing REA installation* detects a globally
  installed `rea-agents`, validates its `scripts/rea.mjs` entry and its `engines.node`
  contract, and adopts it as the manual `nodePath` / `reaEntry` pair. Detection is
  read-only: it never runs npm or REA, and an incompatible install is reported as a
  reason instead of a ready state.
- **Node environment switch.** *Settings → REA → Node runtime* switches only the Node that runs the
  plugin-managed REA, keeping the installed engine; an incompatible Node is refused with the
  required range, and a one-click upgrade returns to the plugin-managed Node.
- **Node choice.** Every Node the plugin can find is listed with its version and
  whether it satisfies the chosen REA's `engines.node`; an incompatible choice shows
  the required range and offers a one-click upgrade to the plugin-managed Node.
- **Install location choice.** On a machine with no usable environment the plugin no
  longer downloads on its own: it asks whether to install into the plugin environment
  or on the machine, naming the installers it actually found (Homebrew, nvm, apt, dnf,
  winget, Chocolatey) with the exact command.
- **`npmRegistry` and `nodeMirror`.** https mirrors for the REA package install and the
  Node distribution. Integrity still comes from the lockfile SRI and the mirror's
  `SHASUMS256.txt`, which must agree with the pinned digest.
- **Setup failure classes.** Network, disk and permission failures are reported with an
  actionable sentence naming the managed root; every other failure keeps its original
  message.

### Changed

- **Split runtime layout.** The managed runtime is published as two independent trees
  (`node/<id>` and `engine/<id>`), each with its own ready marker. A fresh install, and
  now a version upgrade too, no longer writes a combined generation.
- **Deleting only the Node part.** *Delete* on an adopted environment removes `node/`
  and keeps the installed `engine/`, so switching back only re-downloads Node. The
  choice to keep or delete is remembered.
- **One version on disk.** A successful version upgrade deletes the replaced version.
  Version management only moves forward: there is no rollback, because the replaced
  version is gone and re-installing it would mean downloading it again.
- **Shared runtime guard.** Deleting the managed runtime is refused while another DSH
  profile still runs REA in managed mode, and the blocking profiles are named.

### Fixed

- The settings pane could render completely blank when the existing-REA block
  referenced a state variable it never declared.
- Redeeming a runtime after deleting only its Node part reuses the installed engine
  instead of failing on an existing engine target.
- Abandoned `.setup-*` staging trees are removed before the next attempt instead of
  accumulating.
- The split validator canonicalises the managed root, so a symlinked runtime directory
  no longer falls through to the legacy combined-layout branch.

### Tests

- 237 cases, up from 192 at 0.1.0.

## [0.1.0] — 2026-11-10

First public release. `dsh-reakit` is not a thin adapter: it ships a managed
Node and REA runtime plus a control surface for the harness.

### Added

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
  atomically.
- **Bilingual UI** (English and Chinese) through the official DSH locale API,
  with backend diagnostics in English.
- 192 unit, integration and failure-recovery tests.

### Security

- Downloads are integrity-checked against pinned SHA-256 digests and npm SRI
  values; package lifecycle scripts stay disabled.
- Version switching requires two explicit confirmations (session exported, and
  restart acknowledged) and refuses to proceed while analysis work is active.
- Analysis targets, devices, browsers and commercial licences are never
  started or handled automatically.
