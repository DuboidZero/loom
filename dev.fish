#!/usr/bin/env fish
# dev.fish — Launch Loom in development mode on Linux
# Usage: fish dev.fish   (or chmod +x dev.fish && ./dev.fish)

# ---------------------------------------------------------------------------
# Resolve repo root relative to this script's location
# ---------------------------------------------------------------------------
set REPO_ROOT (dirname (status filename))
set VENV_PYTHON $REPO_ROOT/loom-venv/bin/python
set SERVER_PY   $REPO_ROOT/server/main.py
set CLIENT_DIR  $REPO_ROOT/client

# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------
set BOLD    (set_color --bold)
set GREEN   (set_color green)
set CYAN    (set_color cyan)
set YELLOW  (set_color yellow)
set RED     (set_color red)
set RESET   (set_color normal)

echo ""
echo "$BOLD$CYAN  ██╗      ██████╗  ██████╗ ███╗   ███╗$RESET"
echo "$BOLD$CYAN  ██║     ██╔═══██╗██╔═══██╗████╗ ████║$RESET"
echo "$BOLD$CYAN  ██║     ██║   ██║██║   ██║██╔████╔██║$RESET"
echo "$BOLD$CYAN  ██║     ██║   ██║██║   ██║██║╚██╔╝██║$RESET"
echo "$BOLD$CYAN  ███████╗╚██████╔╝╚██████╔╝██║ ╚═╝ ██║$RESET"
echo "$BOLD$CYAN  ╚══════╝ ╚═════╝  ╚═════╝ ╚═╝     ╚═╝$RESET"
echo ""

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
if not test -f $VENV_PYTHON
    echo "$RED  ✗ Python venv not found at $VENV_PYTHON$RESET"
    echo "    Run: python -m venv loom-venv && loom-venv/bin/pip install -r server/requirements.txt"
    exit 1
end

if not command -q npm
    echo "$RED  ✗ npm not found. Install it with: sudo pacman -S nodejs npm$RESET"
    exit 1
end

if not command -q cargo
    echo "$YELLOW  ⚠ cargo not found — Tauri may fail to compile.$RESET"
    echo "    Install with: sudo pacman -S rustup && rustup default stable"
end

# ---------------------------------------------------------------------------
# Fix WebKit / Wayland DMA-BUF protocol error
# ---------------------------------------------------------------------------
set -x WEBKIT_DISABLE_DMABUF_RENDERER 1

# ---------------------------------------------------------------------------
# Start Python backend in the background
# ---------------------------------------------------------------------------
echo "$GREEN  → Starting Python backend...$RESET"
$VENV_PYTHON $SERVER_PY &
set BACKEND_PID $last_pid
echo "    PID $BACKEND_PID — listening on http://127.0.0.1:8000"

# Give uvicorn a moment to bind the port before Tauri opens the window
sleep 2

# Verify backend actually came up
if not kill -0 $BACKEND_PID 2>/dev/null
    echo "$RED  ✗ Backend failed to start. Check server/main.py for errors.$RESET"
    exit 1
end
echo "$GREEN  ✓ Backend ready$RESET"
echo ""

# ---------------------------------------------------------------------------
# Cleanup function — kills backend when this script exits for any reason
# ---------------------------------------------------------------------------
function _loom_cleanup
    echo ""
    echo "$YELLOW  Shutting down backend (PID $BACKEND_PID)...$RESET"
    kill $BACKEND_PID 2>/dev/null
    wait $BACKEND_PID 2>/dev/null
    echo "$CYAN  Loom stopped.$RESET"
    echo ""
end

# Register cleanup on normal exit and on Ctrl-C
trap _loom_cleanup EXIT
trap _loom_cleanup INT

# ---------------------------------------------------------------------------
# Launch Tauri frontend (blocks until the window is closed)
# ---------------------------------------------------------------------------
echo "$GREEN  → Starting Tauri dev app...$RESET"
echo "$YELLOW  (First run compiles Rust — this takes a few minutes)$RESET"
echo ""

cd $CLIENT_DIR
npm run tauri dev

# _loom_cleanup runs automatically after this line
