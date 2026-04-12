# Loom Session Changelog

## 🚀 v4.0.0 — Large-Repo Engine & UX Polish
**Release Date:** 2026-04-12

### Performance & Stability
- **Aho-Corasick symbol matching** — replaced combined-regex edge resolution (hit Python's 65 k opcode limit) with a DFA-based multi-pattern scan. Enables analysis of 50 k+ symbol repositories without crashing.
- **Code-field stripping** — `code` bodies are now stripped from API responses before sending to the frontend, cutting typical large-repo payloads from ~100 MB to ~3 MB.
- **Call-link cap** (`MAX_FRONTEND_LINKS = 50 000`) — AC correctly finds hundreds of thousands of call edges; excess edges are silently capped to prevent the WebGL force-simulation from crashing the browser tab.
- **Iterative Tarjan SCC** — replaced recursive DFS with an iterative implementation to avoid Python's recursion-depth limit on large C++ call chains.

### New Features
- **`DELETE /clear-cache`** — backend endpoint that removes all cached graph files from `~/.loom/graph_cache/`. Wired up in the Settings modal.
- **Clear Recents button** — `✕ clear` link alongside the "Recent" heading on the Welcome screen. Clears `localStorage` immediately without a page reload.
- **Clear Graph Cache button** — red destructive button in Settings → SYSTEM CONFIGURATION. Shows an alert with the number of files removed.

### Bug Fixes
- **Welcome screen background** — `.welcome-screen` now uses `min-height: calc(100vh - 30px)` so the dark background fills the full viewport regardless of how many recent items are listed.

### Internal
- `loom.spec` — added `ahocorasick` to `hiddenimports` for correct PyInstaller bundling.
- `CACHE_VERSION` bumped to `2`.

---

## 🔧 v0.3.1 – Ollama Detection Fix
**Release Date:** 2026-02-06

### Bug Fixes
- **Ollama Detection**: Fixed installer always activating even when Ollama was already installed
  - Detection now checks standard Windows install path (`%LOCALAPPDATA%\Programs\Ollama\ollama.exe`)
  - Falls back to `Get-Command` for PATH-based detection
  - Added console logging for debugging detection issues
- **Tauri Shell Permissions**: Fixed "scoped powershell command not found" error
  - Added `powershell` to `shell:allow-execute` scope in capabilities
  - Enables `Command.create().execute()` calls for system checks

---

## 📦 v0.3.0 – Graph Export + Git Architectural Awareness
**Release Date:** 2026-02-04

### UI Simplification
- **Toolbar Consolidation**: Reduced from 8+ buttons to 3 dropdowns
  - **Mode ▾**: Graph type, SCC collapse, View Callers, Filters
  - **Export ▾**: JSON/SVG export for main or callers graph
  - **⚙**: Git Overlay toggle, Config, About
- **Keyboard Shortcuts**: F (forward), R (reverse), S (SCC), E (export), Esc (close)
- **Callers Panel**: Simplified to Back + Depth + Refresh

### Graph Export
- **JSON Export**: Full graph or subgraph export with canonical schema (`schema_version: 1.0`)
  - Includes `meta` (repo, timestamp, language), `nodes`, and `edges`
  - Subgraph export via multi-node selection (Shift+Click)
- **SVG Export**: Vector graphics export with professional layout
  - Arrowhead markers showing call direction
  - Force-based collision detection to prevent node overlaps
  - 5x scaled layout for better readability on large codebases
  - Glow effects on nodes for visibility
  - Generous padding (200px) to prevent edge cutoff
- **Export Menu**: Dropdown in both main graph and callers view
- **Browser Fallback**: Auto-downloads if Tauri save dialog unavailable

### Callers Graph Export
- **JSON Export**: Exports reverse/forward call graph with edge directions
- **SVG Export**: Hierarchical layout with 400px horizontal / 250px vertical spacing
- Export button added to callers graph control panel

### Node Multi-Selection
- **Shift+Click**: Add/remove nodes from selection for subgraph export
- **Visual Feedback**: Cyan outline ring on selected nodes
- Export automatically uses selection when present

### Git Working-Tree Status Overlay
- **Status Detection**: Parses `git status --porcelain` on scan
- **Visual Indicators**:
  - Modified files: Amber outline ring
  - Added files: Green outline ring
  - Deleted files: 45% opacity (no color change)
- **Legend Panel**: Displays when Git changes detected
- **Graceful Fallback**: Non-Git folders work without overlay

### Technical Changes
- Added `@tauri-apps/plugin-dialog` for native file save dialogs
- Added `fs:default` and write permissions to Tauri capabilities
- New backend endpoints: `/export-graph`, `/git-status`
- Version bumped to 0.3.0
