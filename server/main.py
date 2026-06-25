import os, re, ast, json, shutil, requests, nbformat, stat, time, sys, subprocess, hashlib
from collections import defaultdict, deque
import ahocorasick
from datetime import datetime, timezone
import git 
from git import Repo
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import tempfile
import uvicorn
from multiprocessing import Pool, cpu_count

# ---------------------------------------------------------------------------
# Graph Cache — persists parsed graph to disk so large repos load instantly
# on subsequent launches instead of re-scanning from scratch every time.
# ---------------------------------------------------------------------------
CACHE_DIR = os.path.join(os.path.expanduser("~"), ".loom", "graph_cache")
CACHE_VERSION = 2  

def _get_cache_path(repo_path: str) -> str:
    """Returns the unique cache file path for a given repo."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    repo_hash = hashlib.md5(repo_path.encode()).hexdigest()
    return os.path.join(CACHE_DIR, f"{repo_hash}.json")

def _compute_fingerprint(file_paths: list) -> str:
    """
    Computes a cheap cache fingerprint from file count + max mtime.
    If any file is added, removed, or modified the fingerprint changes.
    """
    if not file_paths:
        return "empty"
    mtimes = [os.path.getmtime(fp) for fp, _ in file_paths]
    return f"{len(file_paths)}:{max(mtimes):.6f}"

def _try_load_cache(repo_path: str, fingerprint: str) -> dict | None:
    """Loads a valid cache from disk. Returns None if missing or stale."""
    cache_path = _get_cache_path(repo_path)
    if not os.path.exists(cache_path):
        return None
    try:
        with open(cache_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("version") != CACHE_VERSION:
            return None
        if data.get("fingerprint") != fingerprint:
            return None
        return data
    except Exception:
        return None

def _save_cache(repo_path: str, fingerprint: str,
                nodes, links, cg, rcg, sm, smm):
    """Serialises the full graph state to a JSON cache file."""
    cache_path = _get_cache_path(repo_path)
    try:
        data = {
            "version": CACHE_VERSION,
            "repo_path": repo_path,
            "fingerprint": fingerprint,
            "nodes": nodes,
            "links": links,
            "call_graph": cg,
            "reverse_call_graph": rcg,
            # JSON requires string keys; we convert back to int on load
            "scc_map": sm,
            "scc_members": {str(k): v for k, v in smm.items()},
        }
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        print(f"Loom: Cache saved → {cache_path}")
    except Exception as e:
        print(f"Loom: Cache save failed: {e}")

# ---------------------------------------------------------------------------
# Aho-Corasick Multi-Pattern Symbol Matcher
#
# Builds a DFA over all known symbol names in O(M x avgLen) time, then
# scans each code block in a single O(C) deterministic pass with no
# backtracking.  Handles repositories with 50 k+ unique symbols without
# hitting compile-time or runtime limits.
# ---------------------------------------------------------------------------

def _build_ac_automaton(symbols: dict):
    """Build and return a compiled Aho-Corasick automaton from symbol->id map."""
    A = ahocorasick.Automaton()
    for sym, node_id in symbols.items():
        if sym:
            A.add_word(sym, (sym, node_id))
    if len(A):
        A.make_automaton()
    return A

def _is_wc(c: str) -> bool:
    """True if c is a valid identifier character [a-zA-Z0-9_]."""
    return c.isalnum() or c == '_'

def _find_calls_ac(code: str, current_name: str, automaton) -> list:
    """
    Single O(C) scan of `code` returning unique target_ids for every symbol
    found at a word boundary (excluding self-references and duplicates).
    """
    seen = set()
    hits = []
    for end_idx, (sym, target_id) in automaton.iter(code):
        if sym == current_name or sym in seen:
            continue
        start_idx = end_idx - len(sym) + 1
        before_ok = (start_idx == 0) or not _is_wc(code[start_idx - 1])
        after_ok  = (end_idx + 1 >= len(code)) or not _is_wc(code[end_idx + 1])
        if before_ok and after_ok:
            seen.add(sym)
            hits.append(target_id)
    return hits

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# --- Configuration & Constants ---

OLLAMA_BASE = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").strip("/")
if not OLLAMA_BASE.startswith("http"):
    OLLAMA_BASE = f"http://{OLLAMA_BASE}"

OLLAMA_URL = f"{OLLAMA_BASE}/api/chat"
MODEL = "qwen2.5-coder:7b"

# Directories to ignore during scanning (static baseline)
IGNORE_DIRS = {
    "node_modules", ".git", "git-portable", "__pycache__",
    "venv", ".venv", "env", ".env",
    "dist", "build", ".next", "target", "out",
    ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".turbo", ".cache", "coverage",
    ".gradle", "bin", "classes",
    "vendor", ".vs", "Debug", "Release", "x64", "x86", "ARM",
    ".idea", ".vscode", "gen",
    "__pypackages__", ".eggs",
    # Note: *.egg-info directories are caught by the d.endswith('.egg-info') check in _collect_files
}

IGNORE_FILES = {
    "jquery.js", "jquery.min.js", "jquery.min.map",
    "bootstrap.js", "bootstrap.min.js", "bootstrap.min.map"
}


def _is_venv_dir(dir_path: str) -> bool:
    """
    Returns True if `dir_path` is a Python virtual environment.
    Detects by the presence of pyvenv.cfg, which every venv contains
    regardless of the directory name (handles loom-venv, .env, myenv, etc).
    """
    return os.path.isfile(os.path.join(dir_path, "pyvenv.cfg"))


def _load_gitignore_dirs(repo_path: str) -> set:
    """
    Parses the .gitignore at `repo_path` and returns a set of bare directory
    names to skip.  Only handles simple bare names and trailing-slash patterns
    (e.g. `loom-venv/`, `*.egg-info` is skipped as it uses a glob).
    Full gitignore glob semantics are intentionally not implemented here —
    IGNORE_DIRS covers the complex cases.
    """
    gitignore_path = os.path.join(repo_path, ".gitignore")
    extra = set()
    if not os.path.isfile(gitignore_path):
        return extra
    try:
        with open(gitignore_path, "r", encoding="utf-8", errors="ignore") as f:
            for raw_line in f:
                line = raw_line.strip()
                # Skip comments, empty lines, negations, and file globs
                if not line or line.startswith("#") or line.startswith("!"):
                    continue
                # Strip leading slash (repo-root-relative paths like /dist)
                line = line.lstrip("/")
                # Strip trailing slash (gitignore convention for dirs)
                name = line.rstrip("/")
                # Only accept plain names with no remaining path separators or
                # glob characters — those need full gitignore semantics
                if name and "/" not in name and "*" not in name and "?" not in name:
                    extra.add(name)
    except Exception:
        pass
    return extra


# Shared valid extensions (single source of truth — all lowercase, matched after .lower())
VALID_EXTS = frozenset({
    # Original languages
    ".py", ".js", ".jsx", ".ts", ".tsx", ".ipynb",
    ".c", ".cpp", ".h", ".hpp",
    ".java", ".cs", ".go", ".rs",
    # Extended language support
    ".rb",                  # Ruby
    ".php",                 # PHP
    ".swift",               # Swift
    ".kt", ".kts",          # Kotlin
    ".dart",                # Dart
    ".ex", ".exs",          # Elixir
    ".lua",                 # Lua
    ".zig",                 # Zig
    ".scala",               # Scala
    ".sh", ".bash",         # Bash / Shell
    ".r",                   # R (files ending in .R are also caught via .lower())
    ".pl", ".pm",           # Perl
})


def _collect_files(repo_path: str) -> list:
    """
    Walks `repo_path` and returns a list of (abs_file_path, repo_path) tuples
    for every source file that should be analysed.

    Three-layer ignore system (in order):
      1. IGNORE_DIRS static set
      2. .gitignore bare directory names from the repo root
      3. pyvenv.cfg detection — skips any Python venv regardless of its name
    """
    gitignore_dirs = _load_gitignore_dirs(repo_path)
    combined_ignore = IGNORE_DIRS | gitignore_dirs

    file_paths = []
    for root, dirs, files in os.walk(repo_path):
        # Prune dirs in-place so os.walk doesn't descend into them
        dirs[:] = [
            d for d in dirs
            if d not in combined_ignore
            and not d.startswith(".")
            and not d.endswith(".egg-info")   # covers mypackage.egg-info etc.
            and not _is_venv_dir(os.path.join(root, d))
        ]
        for file in files:
            if file in IGNORE_FILES:
                continue
            # Case-insensitive extension check via O(1) set lookup
            if os.path.splitext(file)[1].lower() in VALID_EXTS:
                file_paths.append((os.path.join(root, file), repo_path))
    return file_paths


class ConfigUpdate(BaseModel):
    ollamaHost: str
    customGitPath: str

@app.post("/update-config")
async def update_config(conf: ConfigUpdate) -> dict:
    """Updates runtime configuration for Ollama host and Git executable path."""
    global OLLAMA_BASE, OLLAMA_URL
    OLLAMA_BASE = conf.ollamaHost.strip("/")
    OLLAMA_URL = f"{OLLAMA_BASE}/api/chat"
    
    if conf.customGitPath:
        os.environ["GIT_PYTHON_GIT_EXECUTABLE"] = conf.customGitPath
        git.refresh()
    return {"status": "Config updated in backend."}


def setup_git_env() -> None:
    """
    Configures the git executable.  Only attempts bundled-git lookup on Windows
    (the `git.exe` path is meaningless on Linux/macOS).
    """
    if sys.platform == "win32":
        base_path = os.path.dirname(sys.executable)
        portable_git = os.path.join(base_path, "resources", "git-portable", "bin", "git.exe")
        if os.path.exists(portable_git):
            os.environ["GIT_PYTHON_GIT_EXECUTABLE"] = portable_git
            print(f"Loom: Using bundled Git at {portable_git}")
        else:
            print("Loom: Bundled Git not found, falling back to system PATH.")
    git.refresh()

setup_git_env()

TEMP_REPO_DIR = os.path.join(tempfile.gettempdir(), "loom_analysis_cache")
# Wipe any leftover GitHub clone from a previous session on startup
try:
    if os.path.isdir(TEMP_REPO_DIR):
        shutil.rmtree(TEMP_REPO_DIR, ignore_errors=True)
except Exception:
    pass

# --- Global Graph State ---
global_symbols = {}       # Map of symbol name -> node ID
call_graph = {}           # Forward edges: caller -> [callees]
reverse_call_graph = {}   # Reverse edges: callee -> [callers]
all_nodes = []            # List of all node objects for lookup
scc_map = {}              # Map of node_id -> scc_id
scc_members = {}          # Map of scc_id -> [node_ids] (only for SCCs with >1 member)
current_repo_path = ""    # Currently scanned repository path
all_links = []            # All links in the graph for export

# Fast node lookup — rebuilt once per scan via _rebuild_nodes_by_id().
# Eliminates the O(n) per-click dict comprehension that was previously
# reconstructed inside build_contextual_prompt, build_reverse_call_flow, etc.
_nodes_by_id: dict = {}


# ---------------------------------------------------------------------------
# Module-level helpers (shared across endpoints)
# ---------------------------------------------------------------------------

def _is_ollama_alive() -> bool:
    """Returns True if the Ollama HTTP server is reachable."""
    try:
        r = requests.get(f"{OLLAMA_BASE}/api/tags", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def _rebuild_nodes_by_id() -> None:
    """Rebuilds the global _nodes_by_id lookup dict after a scan completes."""
    global _nodes_by_id
    _nodes_by_id = {n['id']: n for n in all_nodes}


def _build_adjacency_lists(links: list) -> tuple:
    """
    Builds forward and reverse call adjacency dicts from a flat link list.
    Uses sets internally for O(1) uniqueness, returns lists for JSON compatibility.
    """
    fwd: dict = defaultdict(set)
    rev: dict = defaultdict(set)
    for lnk in links:
        if lnk.get('type') == 'call':
            src, tgt = lnk['source'], lnk['target']
            fwd[src].add(tgt)
            rev[tgt].add(src)
    return (
        {k: list(v) for k, v in fwd.items()},
        {k: list(v) for k, v in rev.items()},
    )

# Maps a pattern's `type_label` key to the canonical node type stored in the graph.
_TYPE_LABEL_MAP: dict[str, str] = {
    "function":  "function",
    "arrow":     "function",  # JS/TS arrow / expression functions
    "method":    "function",
    "class":     "class",
    "interface": "interface",
    "struct":    "struct",
    "module":    "module",
}

# Languages whose blocks are terminated with `end` instead of `}`.
_END_BLOCK_LANGS: frozenset = frozenset({"ruby", "elixir", "lua"})

COMPILED_PATTERNS: dict = {
    # -------------------------------------------------------------------------
    # JavaScript / TypeScript
    # Captures: named `function` declarations AND `const/let/var name = ... =>`
    # -------------------------------------------------------------------------
    "js_ts": {
        "function": re.compile(
            r'(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\('
        ),
        "arrow": re.compile(
            r'(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)'
            r'\s*=\s*(?:async\s*)?(?:\([^)]{0,300}\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>'
        ),
        "class":     re.compile(r'(?:export\s+(?:default\s+)?)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)'),
        "interface": re.compile(r'interface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:extends\b[^{]*)?\{'),
        "struct":    re.compile(r'type\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*\{'),
    },
    # -------------------------------------------------------------------------
    # C / C++
    # -------------------------------------------------------------------------
    "cpp_c": {
        "function": re.compile(
            r'(?:[\w:<>]+\s+)+(?:\*|&)?\s*([a-zA-Z_][\w:]*)\s*\([^)]*\)\s*\{'
        ),
        "class":  re.compile(r'class\s+([a-zA-Z0-9_]+)'),
        "struct": re.compile(r'struct\s+([a-zA-Z0-9_]+)\s*\{'),
        "module": re.compile(r'namespace\s+([a-zA-Z0-9_]+)\s*\{'),
    },
    # -------------------------------------------------------------------------
    # Java / C#
    # -------------------------------------------------------------------------
    "java_cs": {
        "function":  re.compile(r'[\w<>]+\s+([a-zA-Z_][\w]*)\s*\([^)]*\)\s*\{'),
        "class":     re.compile(r'(?:abstract\s+|final\s+)?class\s+([a-zA-Z0-9_]+)'),
        "interface": re.compile(r'interface\s+([a-zA-Z0-9_]+)\s*\{'),
    },
    # -------------------------------------------------------------------------
    # Go — also captures method receivers: func (r *Receiver) Name(
    # -------------------------------------------------------------------------
    "go": {
        "function":  re.compile(r'func\s+(?:\([^)]*\)\s+)?([a-zA-Z0-9_]+)\s*\('),
        "interface": re.compile(r'type\s+([a-zA-Z0-9_]+)\s+interface'),
        "struct":    re.compile(r'type\s+([a-zA-Z0-9_]+)\s+struct'),
    },
    # -------------------------------------------------------------------------
    # Rust
    # -------------------------------------------------------------------------
    "rust": {
        "function":  re.compile(r'(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)'),
        "interface": re.compile(r'trait\s+([a-zA-Z0-9_]+)'),
        "class":     re.compile(r'(?:struct|enum)\s+([a-zA-Z0-9_]+)'),
        "module":    re.compile(r'mod\s+([a-zA-Z0-9_]+)'),
    },
    # -------------------------------------------------------------------------
    # Ruby
    # -------------------------------------------------------------------------
    "ruby": {
        "function": re.compile(r'def\s+(?:self\.)?([a-zA-Z_][a-zA-Z0-9_?!]*)'),
        "class":    re.compile(r'class\s+([A-Z][a-zA-Z0-9_:]*)'),
        "module":   re.compile(r'module\s+([A-Z][a-zA-Z0-9_:]*)'),
    },
    # -------------------------------------------------------------------------
    # PHP
    # -------------------------------------------------------------------------
    "php": {
        "function":  re.compile(
            r'(?:(?:public|private|protected|static|abstract|final)\s+)*'
            r'function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\('
        ),
        "class":     re.compile(r'(?:abstract\s+|final\s+)?class\s+([a-zA-Z_][a-zA-Z0-9_]*)'),
        "interface": re.compile(r'interface\s+([a-zA-Z_][a-zA-Z0-9_]*)'),
        "struct":    re.compile(r'trait\s+([a-zA-Z_][a-zA-Z0-9_]*)'),
    },
    # -------------------------------------------------------------------------
    # Swift
    # -------------------------------------------------------------------------
    "swift": {
        "function": re.compile(
            r'(?:(?:public|private|internal|open|fileprivate|static|class|mutating|override|final)\s+)*'
            r'func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<[^>]*>)?\s*\('
        ),
        "class":     re.compile(r'(?:final\s+)?class\s+([a-zA-Z_][a-zA-Z0-9_]*)'),
        "struct":    re.compile(r'struct\s+([a-zA-Z_][a-zA-Z0-9_]*)'),
        "interface": re.compile(r'protocol\s+([a-zA-Z_][a-zA-Z0-9_]*)'),
        "module":    re.compile(r'extension\s+([a-zA-Z_][a-zA-Z0-9_]*)'),
    },
    # -------------------------------------------------------------------------
    # Kotlin
    # -------------------------------------------------------------------------
    "kotlin": {
        "function": re.compile(
            r'(?:(?:public|private|protected|internal|suspend|inline|operator|override|open)\s+)*'
            r'fun\s+(?:<[^>]*>\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\('
        ),
        "class": re.compile(
            r'(?:data\s+|sealed\s+|abstract\s+|open\s+|enum\s+)?class\s+([a-zA-Z_][a-zA-Z0-9_]*)'
        ),
        "interface": re.compile(r'interface\s+([a-zA-Z_][a-zA-Z0-9_]*)'),
        "module":    re.compile(r'object\s+([a-zA-Z_][a-zA-Z0-9_]*)'),
    },
    # -------------------------------------------------------------------------
    # Dart
    # -------------------------------------------------------------------------
    "dart": {
        "function": re.compile(
            r'(?:static\s+)?(?:Future<[^>]+>|Stream<[^>]+>|void|bool|int|double|String'
            r'|List|Map|[A-Z][a-zA-Z0-9_<>?,\s]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<[^>]*>)?\s*\('
        ),
        "class":     re.compile(r'(?:abstract\s+)?class\s+([a-zA-Z_][a-zA-Z0-9_]*)'),
        "interface": re.compile(r'mixin\s+([a-zA-Z_][a-zA-Z0-9_]*)'),
    },
    # -------------------------------------------------------------------------
    # Elixir — defp (private) treated same as def
    # -------------------------------------------------------------------------
    "elixir": {
        "function":  re.compile(r'defp?\s+([a-zA-Z_][a-zA-Z0-9_?!]*)\s*\('),
        "module":    re.compile(r'defmodule\s+([A-Z][a-zA-Z0-9_.]*)\s+do'),
        "interface": re.compile(r'defprotocol\s+([A-Z][a-zA-Z0-9_.]*)\s+do'),
    },
    # -------------------------------------------------------------------------
    # Lua
    # -------------------------------------------------------------------------
    "lua": {
        "function": re.compile(r'(?:local\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s*\('),
        "arrow":    re.compile(r'([a-zA-Z_][a-zA-Z0-9_.]*)\s*=\s*function\s*\('),
    },
    # -------------------------------------------------------------------------
    # Zig
    # -------------------------------------------------------------------------
    "zig": {
        "function": re.compile(r'(?:pub\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\('),
        "struct":   re.compile(r'const\s+([A-Z][a-zA-Z0-9_]*)\s*=\s*(?:struct|union|enum)\s*\{'),
    },
    # -------------------------------------------------------------------------
    # Scala
    # -------------------------------------------------------------------------
    "scala": {
        "function":  re.compile(r'def\s+([a-zA-Z_][a-zA-Z0-9_$`]*)\s*(?:\[[^\]]*\])?\s*(?:\(|:)'),
        "class":     re.compile(
            r'(?:case\s+|abstract\s+|sealed\s+|final\s+)?class\s+([a-zA-Z_][a-zA-Z0-9_$]*)'
        ),
        "module":    re.compile(r'object\s+([a-zA-Z_][a-zA-Z0-9_$]*)'),
        "interface": re.compile(r'trait\s+([a-zA-Z_][a-zA-Z0-9_$]*)'),
    },
    # -------------------------------------------------------------------------
    # Bash / Shell
    # -------------------------------------------------------------------------
    "bash": {
        "function": re.compile(
            r'(?:function\s+)?([a-zA-Z_][a-zA-Z0-9_-]*)\s*\(\s*\)\s*\{'
        ),
    },
    # -------------------------------------------------------------------------
    # R
    # -------------------------------------------------------------------------
    "r": {
        "function": re.compile(r'([a-zA-Z_.][a-zA-Z0-9_.]*)\s*(?:<-|=)\s*function\s*\('),
    },
    # -------------------------------------------------------------------------
    # Perl
    # -------------------------------------------------------------------------
    "perl": {
        "function": re.compile(r'sub\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\{|\()'),
        "class":    re.compile(r'package\s+([a-zA-Z_][a-zA-Z0-9_:]*)\s*;'),
    },
}

class DetailRequest(BaseModel):
    node_id: str
    label: str
    node_type: str
    file_path: str 
    code: str = ""

class ReverseCallFlowRequest(BaseModel):
    function_id: str
    maxDepth: int = 2
    maxNodes: int = 25 

class ForwardCallFlowRequest(BaseModel):
    function_id: str
    maxDepth: int = 2
    maxNodes: int = 25 

def force_rmtree(path: str) -> None:
    """
    Removes a directory tree, handling read-only files (common on Windows).
    Uses `onexc` (Python 3.12+) when available, falls back to `onerror`.
    """
    def _handle_error(func, path, exc_info):
        os.chmod(path, stat.S_IWRITE)
        func(path)
    if os.path.exists(path):
        try:
            shutil.rmtree(path, onexc=_handle_error)   # Python 3.12+
        except TypeError:
            shutil.rmtree(path, onerror=_handle_error)  # Python <3.12

def extract_code_block(source, start_index):
    """
    Extracts a balanced curly-brace code block (function/class body) starting
    from start_index.

    The key improvement over a naive first-brace scan: JS/TS functions can have
    destructured parameters like  `function foo({ a, b }) { ... }`.  A naive
    scan would treat the `{` inside the parameter list as the body opener and
    stop at the matching `}`, returning only the signature.

    Strategy:
      1. If a `(` exists between start_index and the first `{`, walk forward
         with paren-depth counting to find the matching `)`.  The body `{`
         must come after that `)`.
      2. Scan up to 80 chars after `)` (or from start_index when no parens)
         for the first `{` — this is the body opener.
      3. Count balanced braces from that opener to find the body end.
    """
    n = len(source)

    # --- Step 1: find the first '(' before the first '{' (params list) -------
    first_open_paren = -1
    first_open_brace = -1
    for j in range(start_index, min(start_index + 300, n)):
        c = source[j]
        if c == '(' and first_open_paren == -1:
            first_open_paren = j
        if c == '{':
            first_open_brace = j
            break

    # If parens come before the brace, skip the entire param list first
    scan_from = start_index
    if first_open_paren != -1 and (first_open_brace == -1 or first_open_paren < first_open_brace):
        paren_depth = 0
        close_paren_pos = first_open_paren
        for j in range(first_open_paren, n):
            c = source[j]
            if c == '(':
                paren_depth += 1
            elif c == ')':
                paren_depth -= 1
                if paren_depth == 0:
                    close_paren_pos = j
                    break
        scan_from = close_paren_pos + 1

    # --- Step 2: find the body opening '{' after the param list --------------
    body_start = -1
    for j in range(scan_from, min(scan_from + 80, n)):
        c = source[j]
        if c == '{':
            body_start = j
            break
        # Arrow function or declaration with no body
        if c == ';':
            break

    if body_start == -1:
        # No body brace found — return the signature only
        return source[start_index:scan_from]

    # --- Step 3: balanced brace extraction from body_start -------------------
    brace_count = 0
    for k in range(body_start, n):
        c = source[k]
        if c == '{':
            brace_count += 1
        elif c == '}':
            brace_count -= 1
            if brace_count == 0:
                return source[start_index:k + 1]

    # Fallback: return up to what we found
    return source[start_index:body_start]

def extract_end_block(source: str, start_index: int) -> str:
    """
    Extracts a code block terminated by the `end` keyword (Ruby, Elixir, Lua).
    Tracks nesting depth by counting block-opening keywords versus `end` lines.
    Falls back to the first 60 lines if the block is pathologically large.
    """
    _OPEN_KW = frozenset({
        'def', 'defp', 'class', 'module', 'do', 'if', 'unless',
        'while', 'until', 'for', 'begin', 'case', 'function',
        'defmodule', 'defprotocol',
    })
    MAX_LINES = 200
    lines_collected = []
    depth = 1
    i = source.find('\n', start_index)
    if i == -1:
        return source[start_index:]
    lines_collected.append(source[start_index:i])
    i += 1
    n = len(source)
    while i < n and depth > 0 and len(lines_collected) < MAX_LINES:
        line_end = source.find('\n', i)
        if line_end == -1:
            line_end = n
        line = source[i:line_end]
        lines_collected.append(line)
        tok = line.strip().split()
        if tok:
            first = tok[0]
            if first in _OPEN_KW:
                depth += 1
            elif first == 'end':
                depth -= 1
        i = line_end + 1
    return '\n'.join(lines_collected)


def parse_regex_structure(source: str, rel_path: str, file_id: str, lang_key: str) -> tuple:
    """
    Parses source code using compiled regex patterns.
    Handles any language in COMPILED_PATTERNS.

    Key improvements over the previous version:
    - Uses _TYPE_LABEL_MAP so 'interface', 'struct', 'module' get correct types
      instead of blindly falling through to 'function'.
    - Picks the first non-None capture group, supporting patterns with
      alternation (e.g. bash: `func name()` vs `name()`).
    - Deduplicates nodes by nid to prevent double-entries from overlapping
      patterns (e.g. arrow + function both matching the same identifier).
    - Dispatches to extract_end_block for end-keyword languages (Ruby/Elixir/Lua)
      and extract_code_block for brace-delimited languages.
    """
    nodes: list = []
    links: list = []
    found_symbols: dict = {}
    seen_nids: set = set()
    rules = COMPILED_PATTERNS.get(lang_key, {})
    extractor = extract_end_block if lang_key in _END_BLOCK_LANGS else extract_code_block

    _KEYWORD_SKIP = frozenset({
        'if', 'for', 'while', 'return', 'switch', 'template',
        'public', 'private', 'protected', 'static', 'void',
        'new', 'delete', 'throw', 'catch', 'try', 'import',
        'export', 'from', 'const', 'let', 'var',
    })

    for type_label, compiled_pattern in rules.items():
        node_type = _TYPE_LABEL_MAP.get(type_label, 'function')
        for match in compiled_pattern.finditer(source):
            # Support patterns with multiple capture groups (pick first non-None)
            name = next((g for g in match.groups() if g is not None), None)
            if not name or name in _KEYWORD_SKIP:
                continue
            nid = f"{node_type}:{rel_path}:{name}"
            if nid in seen_nids:
                continue
            seen_nids.add(nid)
            found_symbols[name] = nid
            nodes.append({
                'id': nid,
                'label': f'{name}()' if node_type == 'function' else name,
                'type': node_type,
                'code': extractor(source, match.start()),
            })
            links.append({'source': file_id, 'target': nid})
    return nodes, links, found_symbols

def parse_file_structure(file_path: str, base_path: str) -> tuple:
    """
    Parses a single file to extract its code structure (nodes) and links.
    - Python / Jupyter: full AST parse (exact line ranges, decorator info).
    - All other supported languages: regex-based via parse_regex_structure.
    """
    nodes, links = [], []
    found_symbols: dict = {}
    rel_path = os.path.relpath(file_path, base_path).replace('\\', '/')
    file_id = f'file:{rel_path}'
    nodes.append({'id': file_id, 'label': os.path.basename(rel_path), 'type': 'file', 'path': rel_path})

    try:
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            if file_path.endswith('.ipynb'):
                source = '\n'.join(
                    c['source'] for c in nbformat.read(f, as_version=4).cells
                    if c.cell_type == 'code'
                )
            else:
                source = f.read()
    except Exception:
        return nodes, links, found_symbols

    ext = os.path.splitext(file_path)[1].lower()

    def _regex(lang_key: str) -> None:
        n, l, s = parse_regex_structure(source, rel_path, file_id, lang_key)
        nodes.extend(n); links.extend(l); found_symbols.update(s)

    if ext in ('.py', '.ipynb'):
        try:
            tree = ast.parse(source)
            lines = source.splitlines()
            for item in ast.walk(tree):
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    itype = 'function' if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) else 'class'
                    decorator_info = ''
                    if hasattr(item, 'decorator_list') and item.decorator_list:
                        for dec in item.decorator_list:
                            if isinstance(dec, ast.Call) and hasattr(dec.func, 'attr'):
                                decorator_info = f'[@{dec.func.attr}] '
                    display_name = f'{decorator_info}{item.name}'
                    nid = f'{itype}:{rel_path}:{item.name}'
                    found_symbols[item.name] = nid
                    nodes.append({
                        'id': nid, 'label': display_name, 'type': itype,
                        'code': '\n'.join(lines[item.lineno - 1: item.end_lineno])
                    })
                    links.append({'source': file_id, 'target': nid})
        except Exception:
            pass
    # --- JavaScript / TypeScript ---
    elif ext in ('.js', '.jsx', '.ts', '.tsx'):  _regex('js_ts')
    # --- C / C++ ---
    elif ext in ('.c', '.cpp', '.h', '.hpp'):    _regex('cpp_c')
    # --- Java / C# ---
    elif ext in ('.java', '.cs'):                _regex('java_cs')
    # --- Go ---
    elif ext == '.go':                           _regex('go')
    # --- Rust ---
    elif ext == '.rs':                           _regex('rust')
    # --- Ruby ---
    elif ext == '.rb':                           _regex('ruby')
    # --- PHP ---
    elif ext == '.php':                          _regex('php')
    # --- Swift ---
    elif ext == '.swift':                        _regex('swift')
    # --- Kotlin ---
    elif ext in ('.kt', '.kts'):                 _regex('kotlin')
    # --- Dart ---
    elif ext == '.dart':                         _regex('dart')
    # --- Elixir ---
    elif ext in ('.ex', '.exs'):                 _regex('elixir')
    # --- Lua ---
    elif ext == '.lua':                          _regex('lua')
    # --- Zig ---
    elif ext == '.zig':                          _regex('zig')
    # --- Scala ---
    elif ext == '.scala':                        _regex('scala')
    # --- Bash / Shell ---
    elif ext in ('.sh', '.bash'):                _regex('bash')
    # --- R ---
    elif ext == '.r':                            _regex('r')
    # --- Perl ---
    elif ext in ('.pl', '.pm'):                  _regex('perl')

    return nodes, links, found_symbols

def process_file_wrapper(args):
    file_path, base_path = args
    return parse_file_structure(file_path, base_path)

@app.get("/map-repo")
async def map_repo(path: str):
    """
    Analyzes a local repository path to build a code graph.
    
    Process:
    1. Scans file structure recursively (respecting ignore lists).
    2. Parses each file to extract definitions (functions, classes).
    3. Resolves cross-file references to build call edges.
    4. Detects Strongly Connected Components (SCCs) to handle cycles.
    """
    global global_symbols, call_graph, reverse_call_graph, all_nodes, current_repo_path, all_links, scc_map, scc_members
    global_symbols = {} 
    call_graph = {}
    reverse_call_graph = {}
    local_all_nodes = []
    all_links = []
    clean_path = path.replace("\\", "/")
    current_repo_path = clean_path
    local_all_nodes.append({"id": "repo-root", "label": "ROOT", "type": "root"})
    file_paths = _collect_files(clean_path)
    
    # -----------------------------------------------------------------------
    # Cache check — skip full scan if nothing has changed on disk
    # -----------------------------------------------------------------------
    fingerprint = _compute_fingerprint(file_paths)
    cached = _try_load_cache(clean_path, fingerprint)
    if cached:
        print(f"Loom: Cache HIT for {clean_path} ({len(file_paths)} files)")
        # Reset globals before restoring from cache to avoid stale state
        global_symbols = {}
        call_graph = {}
        reverse_call_graph = {}
        scc_map.clear()
        scc_members.clear()
        all_nodes = cached["nodes"]
        all_links = cached["links"]
        call_graph.update(cached["call_graph"])
        reverse_call_graph.update(cached["reverse_call_graph"])
        scc_map.update(cached["scc_map"])
        # JSON stores keys as strings; convert back to int
        for k, v in cached["scc_members"].items():
            scc_members[int(k)] = v
        # Rebuild global_symbols from nodes for any later use
        for node in all_nodes:
            if node.get("type") in ("function", "class", "interface", "struct", "module"):
                name = node["label"].replace("()", "").split("] ")[-1]
                global_symbols[name] = node["id"]
        _rebuild_nodes_by_id()
        lean_cached = [{k: v for k, v in n.items() if k != "code"} for n in all_nodes]
        return {"nodes": lean_cached, "links": all_links}

    print(f"Loom: Cache MISS — full scan of {len(file_paths)} files")

    if file_paths:
        num_workers = min(cpu_count(), len(file_paths))
        with Pool(processes=num_workers) as pool:
            results = pool.map(process_file_wrapper, file_paths)

        for n, l, s in results:
            local_all_nodes.extend(n)
            all_links.extend(l)
            global_symbols.update(s)
            if n:
                all_links.append({"source": "repo-root", "target": n[0]["id"]})

    # -----------------------------------------------------------------------
    # Edge resolution — Aho-Corasick DFA, O(M x avgLen + N x C)
    # No regex size limit, no NFA backtracking.  Handles 50k+ symbol repos.
    # -----------------------------------------------------------------------
    if global_symbols:
        automaton = _build_ac_automaton(global_symbols)
        for node in local_all_nodes:
            if not node.get("code") or node["type"] not in ("function", "class"):
                continue
            current_name = node["label"].replace("()", "").split("] ")[-1]
            for target_id in _find_calls_ac(node["code"], current_name, automaton):
                all_links.append({"source": node["id"], "target": target_id, "type": "call"})

    # Build forward and reverse adjacency lists (O(n), deduped via sets)
    call_graph, reverse_call_graph = _build_adjacency_lists(all_links)

    all_nodes = local_all_nodes
    scc_map, scc_members = detect_sccs(call_graph)
    _rebuild_nodes_by_id()

    # -----------------------------------------------------------------------
    # Save to disk cache for next launch
    # -----------------------------------------------------------------------
    _save_cache(clean_path, fingerprint,
                local_all_nodes, all_links,
                call_graph, reverse_call_graph,
                scc_map, scc_members)

    # Strip the `code` field before sending to the frontend.  The renderer
    # only needs structural metadata (id, label, type, path); full source
    # bodies are retained in server memory and the on-disk cache for AI
    # analysis and call-flow queries.
    lean_nodes = [{k: v for k, v in n.items() if k != "code"} for n in local_all_nodes]

    # Cap call edges sent to the renderer.  AC correctly finds every call
    # reference in the codebase, which can reach hundreds of thousands of
    # edges on large repositories.  Sending all of them at once overwhelms
    # the WebGL force-simulation and crashes the browser tab.
    # The full call graph is available server-side for AI and call-flow queries.
    MAX_FRONTEND_LINKS = 50_000
    struct_links = [l for l in all_links if l.get("type") != "call"]
    call_links   = [l for l in all_links if l.get("type") == "call"]
    if len(call_links) > MAX_FRONTEND_LINKS:
        print(f"Loom: Capping call links {len(call_links)} -> {MAX_FRONTEND_LINKS} for frontend")
        call_links = call_links[:MAX_FRONTEND_LINKS]
    return {"nodes": lean_nodes, "links": struct_links + call_links}


def detect_sccs(cg: dict) -> tuple:
    """
    Detects strongly connected components (cycles) using Tarjan's algorithm.
    Returns (scc_map, scc_members) instead of mutating globals directly,
    making it testable and safe to call from multiple contexts.

    Uses an ITERATIVE DFS implementation (not recursive) to avoid Python's
    default recursion limit (~1000 frames) which causes crashes on large repos
    with deep call chains (e.g. OpenClaw-scale C++ codebases).
    """
    new_scc_map: dict = {}
    new_scc_members: dict = {}

    index_counter = [0]
    scc_id_counter = [0]
    stack = []          # Tarjan's SCC stack
    on_stack = set()
    index = {}
    lowlink = {}

    for start in cg:
        if start in index:
            continue

        # Seed the start node
        index[start] = lowlink[start] = index_counter[0]
        index_counter[0] += 1
        stack.append(start)
        on_stack.add(start)

        # dfs_stack holds (node, neighbor_iterator) pairs.
        # Using iter() + next() lets us resume exactly where we left off
        # after processing each neighbour — mimicking the recursive call stack.
        dfs_stack = [(start, iter(cg.get(start, [])))]

        while dfs_stack:
            node, it = dfs_stack[-1]
            try:
                neighbor = next(it)
                if neighbor not in index:
                    # Tree edge — recurse into neighbor
                    index[neighbor] = lowlink[neighbor] = index_counter[0]
                    index_counter[0] += 1
                    stack.append(neighbor)
                    on_stack.add(neighbor)
                    dfs_stack.append((neighbor, iter(cg.get(neighbor, []))))
                elif neighbor in on_stack:
                    # Back edge — update lowlink in place
                    lowlink[node] = min(lowlink[node], index[neighbor])
            except StopIteration:
                # All neighbours of `node` processed — pop and propagate lowlink
                dfs_stack.pop()
                if dfs_stack:
                    parent = dfs_stack[-1][0]
                    lowlink[parent] = min(lowlink[parent], lowlink[node])

                # Check if `node` is the root of an SCC
                if lowlink[node] == index[node]:
                    scc_nodes = []
                    while True:
                        w = stack.pop()
                        on_stack.discard(w)
                        scc_nodes.append(w)
                        new_scc_map[w] = scc_id_counter[0]
                        if w == node:
                            break
                    if len(scc_nodes) > 1:
                        new_scc_members[scc_id_counter[0]] = scc_nodes
                    scc_id_counter[0] += 1

    return new_scc_map, new_scc_members


@app.get("/map-repo-stream")
def map_repo_stream(path: str):
    """
    Streaming version of /map-repo using Server-Sent Events (SSE).

    Emits nodes to the frontend as each file is parsed (Phase 1),
    then call-link edges in batches after all symbols are known (Phase 2),
    then saves the cache and signals done (Phase 3).

    This is a sync `def` so FastAPI runs it in a thread-pool automatically,
    keeping the event loop free for other requests during the scan.
    """
    def generate():
        global global_symbols, call_graph, reverse_call_graph
        global all_nodes, current_repo_path, all_links, scc_map, scc_members

        # Reset all global graph state
        global_symbols = {}
        call_graph = {}
        reverse_call_graph = {}
        scc_map = {}
        scc_members = {}
        local_all_nodes = []
        all_links = []
        clean_path = path.replace("\\", "/")
        current_repo_path = clean_path

        # Emit root node immediately so frontend isn't blank
        root_node = {"id": "repo-root", "label": "ROOT", "type": "root"}
        local_all_nodes.append(root_node)
        yield f"data: {json.dumps({'type': 'nodes', 'nodes': [root_node], 'links': []})}\n\n"

        # Collect all relevant source files
        file_paths = _collect_files(clean_path)

        # Tell the frontend how many files to expect (used for progress bar)
        yield f"data: {json.dumps({'type': 'meta', 'totalFiles': len(file_paths)})}\n\n"

        # --- Cache check ---
        fingerprint = _compute_fingerprint(file_paths)
        cached = _try_load_cache(clean_path, fingerprint)
        if cached:
            # Reset globals before restoring from cache to avoid stale state
            global_symbols = {}
            call_graph = {}
            reverse_call_graph = {}
            scc_map.clear()
            scc_members.clear()
            all_nodes_c = cached["nodes"]
            all_links_c = cached["links"]
            call_graph.update(cached["call_graph"])
            reverse_call_graph.update(cached["reverse_call_graph"])
            scc_map.update(cached["scc_map"])
            for k, v in cached["scc_members"].items():
                scc_members[int(k)] = v
            for node in all_nodes_c:
                if node.get("type") in ("function", "class", "interface", "struct", "module"):
                    name = node["label"].replace("()", "").split("] ")[-1]
                    global_symbols[name] = node["id"]
            all_nodes = all_nodes_c
            all_links = all_links_c
            _rebuild_nodes_by_id()

            CHUNK = 80
            struct_links = [l for l in all_links_c if l.get("type") != "call"]
            call_links_c = [l for l in all_links_c if l.get("type") == "call"]

            for i in range(0, len(all_nodes_c), CHUNK):
                chunk = all_nodes_c[i:i + CHUNK]
                yield f"data: {json.dumps({'type': 'nodes', 'nodes': chunk, 'links': []})}\n\n"

            for i in range(0, len(struct_links), 500):
                yield f"data: {json.dumps({'type': 'links', 'links': struct_links[i:i + 500]})}\n\n"

            for i in range(0, len(call_links_c), 500):
                yield f"data: {json.dumps({'type': 'links', 'links': call_links_c[i:i + 500]})}\n\n"

            yield f"data: {json.dumps({'type': 'done', 'fromCache': True, 'nodeCount': len(all_nodes_c)})}\n\n"
            return

        # --- Phase 1: Parse files, stream nodes as each file finishes ---
        BATCH = 12  # files per SSE event
        batch_nodes = []
        batch_links = []
        files_done = 0

        if file_paths:
            num_workers = min(cpu_count(), len(file_paths))
            with Pool(processes=num_workers) as pool:
                for n, l, s in pool.imap_unordered(process_file_wrapper, file_paths, chunksize=4):
                    local_all_nodes.extend(n)
                    all_links.extend(l)
                    global_symbols.update(s)
                    if n:  # link file to repo root
                        all_links.append({"source": "repo-root", "target": n[0]["id"]})
                    batch_nodes.extend(n)
                    batch_links.extend(l)
                    files_done += 1

                    if len(batch_nodes) >= BATCH:
                        msg = {'type': 'nodes', 'nodes': batch_nodes,
                               'links': batch_links, 'progress': files_done}
                        yield f"data: {json.dumps(msg)}\n\n"
                        batch_nodes = []
                        batch_links = []

        if batch_nodes or batch_links:  # flush remainder
            yield f"data: {json.dumps({'type': 'nodes', 'nodes': batch_nodes, 'links': batch_links, 'progress': files_done})}\n\n"

        # Signal that Phase 2 (edge resolution) is starting
        yield f"data: {json.dumps({'type': 'status', 'message': 'Resolving call edges...'})}\n\n"

        # --- Phase 2: Aho-Corasick edge resolution, stream links in chunks ---
        call_links = []
        if global_symbols:
            automaton = _build_ac_automaton(global_symbols)
            for node in local_all_nodes:
                if not node.get("code") or node["type"] not in ("function", "class"):
                    continue
                current_name = node["label"].replace("()", "").split("] ")[-1]
                for target_id in _find_calls_ac(node["code"], current_name, automaton):
                    lnk = {"source": node["id"], "target": target_id, "type": "call"}
                    call_links.append(lnk)
                    all_links.append(lnk)

        MAX_FRONTEND_LINKS = 50_000
        if len(call_links) > MAX_FRONTEND_LINKS:
            print(f"Loom: Capping call links {len(call_links)} -> {MAX_FRONTEND_LINKS} for frontend (stream)")
            call_links = call_links[:MAX_FRONTEND_LINKS]
        CHUNK = 200
        for i in range(0, len(call_links), CHUNK):
            yield f"data: {json.dumps({'type': 'links', 'links': call_links[i:i + CHUNK]})}\n\n"

        # Build adjacency lists (O(n), deduped via sets internaly)
        call_graph, reverse_call_graph = _build_adjacency_lists(all_links)

        all_nodes = local_all_nodes

        # Phase 3: SCC detection + cache save + node lookup rebuild
        scc_map, scc_members = detect_sccs(call_graph)
        _rebuild_nodes_by_id()
        _save_cache(clean_path, fingerprint,
                    local_all_nodes, all_links,
                    call_graph, reverse_call_graph,
                    scc_map, scc_members)

        yield f"data: {json.dumps({'type': 'done', 'fromCache': False, 'nodeCount': len(local_all_nodes)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )

def build_reverse_call_flow(function_id: str, max_depth: int, max_nodes: int):
    """
    Constructs a reverse call graph (Who calls this?) starting from a target function.
    
    Key Features:
    - SCC-Aware: Ensures atomic rendering of cycles (all members or none).
    - Cycle-Safe: Records edges within cycles without infinite loops.
    - Depth-Limited but SCC-preserving (if one member is in depth, all are included).
    """
    # Use module-level lookup (built once per scan, not per click)
    nodes_by_id = _nodes_by_id
    if function_id not in nodes_by_id:
        return {"error": "Function not found in call graph"}

    # Extract source file path for metadata
    function_parts = function_id.split(':')
    source_file_path = function_parts[1] if len(function_parts) >= 2 else ''

    visited = set()           # For traversal control only
    result_nodes = []
    result_edges = []
    seen_edges = set()        # For edge deduplication
    queue = deque([(function_id, 0)])
    visited.add(function_id)

    while queue and len(result_nodes) < max_nodes:
        current_id, depth = queue.popleft()
        
        if current_id in nodes_by_id:
            node = nodes_by_id[current_id]
            node_parts = current_id.split(':')
            node_file_path = node_parts[1] if len(node_parts) >= 2 else ''
            
            # Check if node is part of a cycle (SCC with >1 member)
            is_in_cycle = current_id in scc_map and scc_map[current_id] in scc_members
            
            # Build sccInfo for cycle nodes
            scc_info = None
            if is_in_cycle:
                scc_id = scc_map[current_id]
                members = scc_members.get(scc_id, [])
                scc_info = {
                    "memberCount": len(members),
                    "members": [nodes_by_id[m]['label'] for m in members if m in nodes_by_id],
                    "memberIds": members,
                    "isRepresentative": members[0] == current_id if members else False
                }
            
            result_nodes.append({
                "id": node['id'],
                "name": node['label'],
                "type": node.get('type', 'function'),
                "fileId": node_file_path,
                "code": node.get('code', ''),
                "depth": depth,
                "isEntryPoint": len(reverse_call_graph.get(current_id, [])) == 0,
                "inCycle": is_in_cycle,
                "sccId": scc_map.get(current_id),
                "sccInfo": scc_info
            })
        
        # Record all caller edges, including cycle edges
        callers = reverse_call_graph.get(current_id, [])
        
        for caller_id in callers:

            edge_key = (caller_id, current_id)
            if edge_key not in seen_edges:
                seen_edges.add(edge_key)
                
                # Check if this is a cycle edge (both nodes in same SCC)
                is_cycle_edge = (caller_id in scc_map and 
                               current_id in scc_map and 
                               scc_map[caller_id] == scc_map[current_id] and
                               scc_map[caller_id] in scc_members)
                
                result_edges.append({
                    "caller": caller_id,
                    "callee": current_id,
                    "isCycleEdge": is_cycle_edge
                })
            
            # SCC-aware: if caller is in a cycle, include all SCC members atomically
            if caller_id not in visited:
                caller_in_scc = caller_id in scc_map and scc_map[caller_id] in scc_members

                if caller_in_scc:

                    scc_id = scc_map[caller_id]
                    for member_id in scc_members[scc_id]:
                        if member_id not in visited:
                            visited.add(member_id)
                            queue.append((member_id, depth + 1))
                elif depth < max_depth:
                    # Normal traversal with depth limit
                    visited.add(caller_id)
                    queue.append((caller_id, depth + 1))
    
    return {
        "nodes": result_nodes,
        "edges": result_edges,
        "metadata": {
            "sourceFileId": source_file_path,
            "sourceFunctionId": function_id,
            "nodeCount": len(result_nodes),
            "edgeCount": len(result_edges),
            "depthUsed": max(n['depth'] for n in result_nodes) if result_nodes else 0,
            "truncated": len(result_nodes) >= max_nodes or len(queue) > 0,
            "hasCycles": any(e.get('isCycleEdge') for e in result_edges)
        }
    }

def build_forward_call_flow(function_id: str, max_depth: int, max_nodes: int):
    """
    Constructs a forward call graph (What does this call?) starting from a target function.
    
    Key Features:
    - SCC-Aware: Ensures atomic rendering of cycles.
    - Complexity Boundaries: 
        - Stops if fan-out > 10
        - Stops if entering large SCC (>5 members)
    """
    nodes_by_id = _nodes_by_id
    if function_id not in nodes_by_id:
        return {"error": "Function not found in call graph"}

    function_parts = function_id.split(':')
    source_file_path = function_parts[1] if len(function_parts) >= 2 else ''

    visited = set()
    result_nodes = []
    result_edges = []
    seen_edges = set()
    queue = deque([(function_id, 0)])
    visited.add(function_id)

    while queue and len(result_nodes) < max_nodes:
        current_id, depth = queue.popleft()
        
        if current_id in nodes_by_id:
            node = nodes_by_id[current_id]
            node_parts = current_id.split(':')
            node_file_path = node_parts[1] if len(node_parts) >= 2 else ''
            
            is_in_cycle = current_id in scc_map and scc_map[current_id] in scc_members
            scc_info = None
            if is_in_cycle:
                scc_id = scc_map[current_id]
                members = scc_members.get(scc_id, [])
                scc_info = {
                    "memberCount": len(members),
                    "members": [nodes_by_id[m]['label'] for m in members if m in nodes_by_id],
                    "memberIds": members,
                    "isRepresentative": members[0] == current_id
                }
            
            # Count TOTAL callees for this node to check fan-out
            all_callees = call_graph.get(current_id, [])
            total_callees = len(all_callees)
            truncated_calls = False
            
            # High fan-out boundary: mark as truncated and skip expansion for non-root nodes.
            if depth > 0 and total_callees > 10:
                truncated_calls = True
            
            result_nodes.append({
                "id": node['id'],
                "name": node['label'],
                "type": node.get('type', 'function'),
                "fileId": node_file_path,
                "code": node.get('code', ''),
                "depth": depth,
                "isEntryPoint": False, # Concept doesn't apply same way forward
                "inCycle": is_in_cycle,
                "sccId": scc_map.get(current_id),
                "sccInfo": scc_info,
                "totalCallees": total_callees,
                "truncatedCalls": truncated_calls
            })
            
            # If truncated, STOP here for this branch
            if truncated_calls:
                continue

        # Traverse outgoing call edges
        callees = call_graph.get(current_id, [])
        
        # Large SCC boundary: do not traverse out, only record internal edges.
        stop_transversal = False
        if is_in_cycle and scc_info and scc_info['memberCount'] > 5:

            stop_transversal = True

        for callee_id in callees:
            # Record edge
            edge_key = (current_id, callee_id)
            if edge_key not in seen_edges:
                seen_edges.add(edge_key)
                
                is_cycle_edge = (current_id in scc_map and 
                               callee_id in scc_map and 
                               scc_map[current_id] == scc_map[callee_id] and
                               scc_map[current_id] in scc_members)
                
                result_edges.append({
                    "caller": current_id,
                    "callee": callee_id,
                    "isCycleEdge": is_cycle_edge
                })
            

            if callee_id not in visited:
                callee_in_scc = callee_id in scc_map and scc_map[callee_id] in scc_members
                
                # Skip external edges when at large SCC boundary
                is_internal_scc_edge = callee_in_scc and is_in_cycle and scc_map[callee_id] == scc_map[current_id]
                
                if stop_transversal and not is_internal_scc_edge:
                    continue

                if callee_in_scc:

                    scc_id = scc_map[callee_id]
                    for member_id in scc_members[scc_id]:
                        if member_id not in visited:
                            visited.add(member_id)
                            queue.append((member_id, depth + 1))
                elif depth < max_depth:
                     visited.add(callee_id)
                     queue.append((callee_id, depth + 1))

    return {
        "nodes": result_nodes,
        "edges": result_edges,
        "metadata": {
            "sourceFileId": source_file_path,
            "sourceFunctionId": function_id,
            "nodeCount": len(result_nodes),
            "edgeCount": len(result_edges),
            "depthUsed": max(n['depth'] for n in result_nodes) if result_nodes else 0,
            "truncated": len(result_nodes) >= max_nodes or len(queue) > 0,
            "hasCycles": any(e.get('isCycleEdge') for e in result_edges)
        }
    }


@app.get("/map-github")
async def map_github(repo_url: str):
    """
    Clones a remote GitHub repository to a temporary directory and maps it.
    
    Args:
        repo_url (str): The HTTPS URL of the GitHub repository.
        
    Returns:
        dict: The full graph structure (nodes, links) as per /map-repo.
    """
    if "https://" in repo_url:
        repo_url = "https://" + repo_url.split("https://")[-1].strip()
    
    force_rmtree(TEMP_REPO_DIR)
    try:
        Repo.clone_from(repo_url, TEMP_REPO_DIR, depth=1)
        time.sleep(0.5)
        return await map_repo(TEMP_REPO_DIR)
    except Exception as e: 
        return {"error": str(e)}

@app.post("/reverse-call-flow")
async def reverse_call_flow(req: ReverseCallFlowRequest):
    """
    Endpoint for fetching the upstream call hierarchy for a specific function.
    Returns:
        dict: Subgraph of callers, edges, and metadata including cycle info.
    """
    try:
        result = build_reverse_call_flow(
            function_id=req.function_id,
            max_depth=req.maxDepth,
            max_nodes=req.maxNodes
        )
        return result
    except Exception as e:
        return {"error": str(e)}

@app.post("/forward-call-flow")
async def forward_call_flow(req: ForwardCallFlowRequest):
    """
    Endpoint for fetching downstream call hierarchy (Forward Graph).
    """
    try:
        # Enforce Rule 1: Always start shallow if not specified otherwise, 
        # but here we allow client to request what they want, 
        # assuming client defaults to 2.
        result = build_forward_call_flow(
            function_id=req.function_id,
            max_depth=req.maxDepth,
            max_nodes=req.maxNodes
        )
        return result
    except Exception as e:
        return {"error": str(e)}


def find_documentation_files(file_path: str, repo_root: str) -> str:
    """
    Searches for documentation files in the file's directory hierarchy,
    walking up from the source file's directory to the repo root.
    Looks for: README.md, ARCHITECTURE.md, CONTRIBUTING.md, NOTES.md,
    documentation.md, and common README variants.
    Caps total content at 4000 chars to avoid drowning the LLM prompt.
    """
    _DOC_NAMES = (
        "README.md", "readme.md", "README.rst", "readme.rst", "README",
        "ARCHITECTURE.md", "architecture.md",
        "documentation.md", "Documentation.md",
        "CONTRIBUTING.md", "contributing.md",
        "NOTES.md", "notes.md",
    )
    MAX_DOC_CHARS = 4000
    doc_content: list = []
    total_chars = 0
    current_dir = os.path.dirname(file_path)
    repo_root_normalized = os.path.normpath(repo_root)

    while current_dir and os.path.normpath(current_dir).startswith(repo_root_normalized):
        for doc_name in _DOC_NAMES:
            if total_chars >= MAX_DOC_CHARS:
                break
            doc_path = os.path.join(current_dir, doc_name)
            if os.path.exists(doc_path):
                try:
                    with open(doc_path, "r", encoding="utf-8", errors="ignore") as f:
                        content = f.read().strip()
                    if content:
                        remaining = MAX_DOC_CHARS - total_chars
                        if len(content) > remaining:
                            content = content[:remaining] + "\n...(truncated)"
                        rel_doc_path = os.path.relpath(doc_path, repo_root)
                        doc_content.append(f"[{rel_doc_path}]:\n{content}")
                        total_chars += len(content)
                except Exception:
                    pass

        parent = os.path.dirname(current_dir)
        if parent == current_dir:  # filesystem root
            break
        current_dir = parent

    return "\n\n---\n\n".join(doc_content)


def extract_docstring_context(code_block: str, node_name: str, node_type: str, file_ext: str) -> str:
    """
    Extracts docstrings and leading comments from a code block.
    
    Args:
        code_block: The source code of the function/class.
        node_name: Name of the function/class.
        node_type: Type of node ('function' or 'class').
        file_ext: File extension to determine comment style.
        
    Returns:
        str: Extracted documentation (docstrings + comments), or empty string.
    """
    extracted = []
    
    # For Python: extract docstrings
    if file_ext in [".py", ".ipynb"]:
        try:
            tree = ast.parse(code_block)
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    docstring = ast.get_docstring(node)
                    if docstring:
                        extracted.append(f"Docstring:\n{docstring}")
                    break
        except:
            pass
        
        # Also look for # comments at start of function
        lines = code_block.split('\n')
        leading_comments = []
        in_def = False
        for line in lines:
            stripped = line.strip()
            if stripped.startswith('def ') or stripped.startswith('async def ') or stripped.startswith('class '):
                in_def = True
                continue
            if in_def and stripped.startswith('#'):
                leading_comments.append(stripped[1:].strip())
            elif in_def and stripped and not stripped.startswith('#'):
                break
        if leading_comments:
            extracted.append(f"Comments:\n" + "\n".join(leading_comments))
    
    # For JS/TS: extract JSDoc and leading comments
    elif file_ext in [".js", ".jsx", ".ts", ".tsx"]:
        # JSDoc pattern: /** ... */
        jsdoc_match = re.search(r'/\*\*[\s\S]*?\*/', code_block)
        if jsdoc_match:
            jsdoc = jsdoc_match.group(0)
            # Clean up JSDoc markers
            jsdoc_clean = re.sub(r'^\s*\*\s?', '', jsdoc, flags=re.MULTILINE)
            jsdoc_clean = jsdoc_clean.replace('/**', '').replace('*/', '').strip()
            if jsdoc_clean:
                extracted.append(f"JSDoc:\n{jsdoc_clean}")
        
        # Single line comments: // ...
        comment_lines = []
        for line in code_block.split('\n'):
            stripped = line.strip()
            if stripped.startswith('//'):
                comment_lines.append(stripped[2:].strip())
            elif stripped.startswith('function') or stripped.startswith('const') or stripped.startswith('class'):
                break
        if comment_lines:
            extracted.append(f"Comments:\n" + "\n".join(comment_lines))
    
    # For C/C++/Java/C#/Go/Rust: block comments and line comments
    elif file_ext in [".c", ".cpp", ".h", ".hpp", ".java", ".cs", ".go", ".rs"]:
        # Block comments: /* ... */ or /** ... */
        block_match = re.search(r'/\*[\s\S]*?\*/', code_block)
        if block_match:
            block = block_match.group(0).replace('/*', '').replace('*/', '')
            block = re.sub(r'^\s*\*\s?', '', block, flags=re.MULTILINE).strip()
            if block:
                extracted.append(f"Block Comment:\n{block}")
        
        # Rust doc comments: ///
        if file_ext == ".rs":
            rust_docs = []
            for line in code_block.split('\n'):
                stripped = line.strip()
                if stripped.startswith('///'):
                    rust_docs.append(stripped[3:].strip())
                elif stripped.startswith('fn ') or stripped.startswith('pub '):
                    break
            if rust_docs:
                extracted.append(f"Doc Comments:\n" + "\n".join(rust_docs))
    
    return "\n\n".join(extracted)


def build_contextual_prompt(node_id, node_label, node_type, node_code):
    """
    Builds focused context using the call graph instead of dumping the full file.
    
    Traverses reverse_call_graph (who calls this?) and call_graph (what does this call?)
    to gather only the relevant code snippets for LLM analysis.
    
    Args:
        node_id: Unique ID of the target node (e.g. 'function:path:name').
        node_label: Display label of the target node.
        node_type: Type of node ('function', 'class', etc.).
        node_code: Source code of the target node.
        
    Returns:
        tuple: (caller_snippets list, callee_signatures list)
    """
    # Use module-level lookup (built once per scan, not per click)
    nodes_by_id = _nodes_by_id
    
    MAX_CALLERS = 5
    MAX_CALLEES = 5
    MAX_CALLER_LINES = 50
    
    # --- Callers: Who calls this function? ---
    callers = reverse_call_graph.get(node_id, [])
    caller_snippets = []
    for caller_id in callers[:MAX_CALLERS]:
        caller_node = nodes_by_id.get(caller_id)
        if caller_node and caller_node.get('code'):
            code = caller_node['code']
            lines = code.split('\n')
            if len(lines) > MAX_CALLER_LINES:
                code = '\n'.join(lines[:MAX_CALLER_LINES]) + '\n... (truncated)'
            caller_snippets.append({
                'label': caller_node.get('label', caller_id),
                'code': code
            })
    
    # --- Callees: What does this function call? ---
    callees = call_graph.get(node_id, [])
    callee_signatures = []
    for callee_id in callees[:MAX_CALLEES]:
        callee_node = nodes_by_id.get(callee_id)
        if callee_node and callee_node.get('code'):
            code = callee_node['code']
            lines = code.split('\n')
            # Extract just the signature + leading docstring/comments
            sig_lines = [lines[0]]
            if len(lines) > 1:
                for i in range(1, min(len(lines), 8)):
                    line = lines[i].strip()
                    if '"""' in line or "'''" in line or line.startswith('#') or line.startswith('//') or line.startswith('*'):
                        sig_lines.append(lines[i])
                        if i > 1 and ('"""' in line or "'''" in line):
                            break
                    else:
                        break
            callee_signatures.append({
                'label': callee_node.get('label', callee_id),
                'signature': '\n'.join(sig_lines)
            })
    
    return caller_snippets, callee_signatures

class ChatRequest(BaseModel):
    messages: list[dict]
    context: dict

class NodeSourceRequest(BaseModel):
    node_id: str
    file_path: str

@app.post("/node-source")
async def node_source(req: NodeSourceRequest):
    """
    Returns the source code for a specific node, or the entire file if it's a file node.
    """
    # Try to get from cached nodes first (functions/classes have code stored)
    code = _nodes_by_id.get(req.node_id, {}).get("code", "")
    if code:
        return {"code": code}
    
    # If not in cache (e.g., file node), try to read from disk
    try:
        actual_path = req.file_path
        if not os.path.exists(actual_path):
            rel_path = req.node_id.split(':')[1] if ':' in req.node_id else req.node_id
            actual_path = os.path.join(current_repo_path, rel_path)

        # Path traversal guard — resolved path must stay within the repo root.
        safe_root = os.path.realpath(current_repo_path) if current_repo_path else None
        resolved = os.path.realpath(actual_path)
        if safe_root and not resolved.startswith(safe_root):
            return {"error": "Path outside repository", "code": ""}

        with open(actual_path, "r", encoding="utf-8") as f:
            code = f.read()
        return {"code": code}
    except Exception as e:
        return {"error": str(e), "code": ""}

@app.post("/get-details")
async def get_details(req: DetailRequest):
    """
    Analyzes a specific code node using an LLM (Ollama).
    Streams the explanation via SSE.
    """
    def generate():
        if not _is_ollama_alive():
            yield f"data: {json.dumps({'error': 'Ollama is not running.'})}\n\n"
            return
        try:
            actual_path = req.file_path
            if not os.path.exists(actual_path):
                 rel_path = req.node_id.split(':')[1]
                 actual_path = os.path.join(TEMP_REPO_DIR, rel_path)

            repo_root = current_repo_path if current_repo_path else os.path.dirname(actual_path)

            doc_context = ""
            documentation_md = find_documentation_files(actual_path, repo_root)
            if documentation_md:
                doc_context += f"\n\nPROJECT DOCUMENTATION:\n---\n{documentation_md}\n---"

            # O(1) node lookup via module-level index
            node_code = _nodes_by_id.get(req.node_id, {}).get("code", "")

            if node_code:
                file_ext = os.path.splitext(actual_path)[1].lower()
                docstring_context = extract_docstring_context(
                    node_code, req.label.replace("()", ""), req.node_type, file_ext
                )
                if docstring_context:
                    doc_context += f"\n\nEXISTING DOCUMENTATION FOR '{req.label}':\n---\n{docstring_context}\n---"

            focus_code = node_code if node_code else ""
            caller_snippets, callee_signatures = build_contextual_prompt(req.node_id, req.label, req.node_type, focus_code)

            prompt_parts = [
                f"Analyze the {req.node_type} named '{req.label}'.",
                f"\nTARGET CODE:\n```\n{focus_code}\n```" if focus_code else "",
            ]
            if caller_snippets:
                prompt_parts.append(f"\nCALLERS:")
                for cs in caller_snippets:
                    prompt_parts.append(f"\n{cs['label']}:\n```\n{cs['code']}\n```")
            if callee_signatures:
                prompt_parts.append(f"\nCALLEES:")
                for cs in callee_signatures:
                    prompt_parts.append(f"\n{cs['label']}:\n```\n{cs['signature']}\n```")
            if doc_context:
                prompt_parts.append(f"\nDOCUMENTATION:{doc_context}")

            prompt_parts.append(
                "\nExplain this code as you would during a professional code review.\n\n"
                "Prioritize:\n"
                "1. What problem the code solves.\n"
                "2. Why it is implemented this way.\n"
                "3. The key design decisions.\n"
                "4. Important assumptions or limitations.\n"
                "5. How it fits into the surrounding system (using supporting context when relevant).\n\n"
                "Avoid narrating the implementation line-by-line unless the user explicitly asks for an execution walkthrough.\n"
                "Use backticks for all identifiers. Format response as clean Markdown."
            )
            prompt = "\n".join(p for p in prompt_parts if p)

            payload = {
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": (
                        "You are a code analysis assistant. Explain code based ONLY on what is explicitly visible in the provided source. "
                        "Never invent behavior not shown. Be concise and precise. "
                        "Format your response as clean Markdown: use ## headers, backtick code spans for identifiers, and bullet points for lists."
                    )},
                    {"role": "user", "content": prompt}
                ],
                "stream": True,
                "options": {
                    "temperature": 0.2,
                    "top_p": 0.5,
                    "num_ctx": 8192,
                    "num_predict": -1
                }
            }

            with requests.post(OLLAMA_URL, json=payload, stream=True, timeout=300) as r:
                for line in r.iter_lines():
                    if line:
                        chunk = json.loads(line)
                        if chunk.get("error"):
                            yield f"data: {json.dumps({'error': chunk['error']})}\n\n"
                            return
                        token = chunk.get("message", {}).get("content", "")
                        if token:
                            yield f"data: {json.dumps({'content': token})}\n\n"
                        if chunk.get("done"):
                            break
            yield f"data: {json.dumps({'done': True})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

def _detect_chat_intent(messages: list) -> str:
    """
    Classifies the user's latest question into one of three modes:
    - 'bug'          → simulation, variable tracking, failure analysis
    - 'architecture' → relationships, dependencies, module design
    - 'explain'      → purpose, inputs, outputs (default)

    Uses compiled regex with word boundaries so e.g. 'race' doesn't
    match inside 'brace_count'.
    """
    if not messages:
        return 'explain'
    last_user = next(
        (m['content'] for m in reversed(messages) if m.get('role') == 'user'),
        ''
    ).lower()

    _BUG_RE = re.compile(
        r'\b(?:'
        r'fail|crash|bug|error|wrong|break|edge\s*cases?|exception|undefined|null|'
        r'infinite|race\s+condition|race(?!\w)|leak|off-by|incorrect|fix|track|simulate|'
        r'step\s*through|trace|will\s+(?:this|it)\s+(?:fail|crash|break|error|work)'
        r')\b'
    )
    _ARCH_RE = re.compile(
        r'\b(?:'
        r'architecture|design|relate|depend|module|structure|pattern|connect|'
        r'who\s+calls|what\s+calls|relationship|coupling|cohesion|refactor|'
        r'compare|difference|how\s+does\s+.+\s+fit'
        r')\b'
    )

    if _BUG_RE.search(last_user):
        return 'bug'
    if _ARCH_RE.search(last_user):
        return 'architecture'
    return 'explain'


@app.post("/chat")
async def chat(req: ChatRequest):
    """
    Handles AI chat messages using Ollama.
    Streams the response back via SSE.
    """
    def generate():
        if not _is_ollama_alive():
            yield f"data: {json.dumps({'error': 'Ollama is not running.'})}\n\n"
            return
        try:
            ctx = req.context

            # ----------------------------------------------------------------
            # No node selected — chat requires a focused node
            # ----------------------------------------------------------------
            if not ctx.get('nodeId'):
                yield f"data: {json.dumps({'error': 'Select a node in the graph to start chatting.'})}\n\n"
                return

            # ----------------------------------------------------------------
            # Shared Analysis Principles — injected into every prompt
            # ----------------------------------------------------------------
            ANALYSIS_PRINCIPLES = (
                "## Conversation Routing\n\n"
                "Determine whether the user is requesting code analysis or general conversation.\n\n"
                "Use Code Analysis Mode when the user is:\n"
                "* asking what code does\n"
                "* asking how code works\n"
                "* asking about bugs, behavior, architecture, performance, security, design, dependencies, or implementation details\n"
                "* referring to identifiers, functions, classes, files, variables, stack traces, logs, or source code\n\n"
                "Use Conversation Mode when the user is:\n"
                "* joking\n"
                "* making casual conversation\n"
                "* asking for opinions\n"
                "* brainstorming ideas\n"
                "* discussing projects informally\n"
                "* speaking about the codebase in a non-technical way\n\n"
                "In Conversation Mode:\n"
                "* Respond naturally.\n"
                "* Humor is allowed.\n"
                "* Do not force structured analysis.\n"
                "* Do not refuse obvious jokes.\n"
                "* Be conversational while remaining truthful.\n\n"
                "---\n\n"
                "## Analysis Principles\n\n"
                "When analyzing code:\n\n"
                "### Evidence\n\n"
                "Distinguish between:\n"
                "* Observation: directly visible in the code or provided context.\n"
                "* Inference: a conclusion supported by observations but not proven.\n"
                "* Unknown: information that cannot be determined from the available evidence.\n\n"
                "Do not present inferences as facts.\n"
                "If evidence is insufficient, say so.\n"
                "Do not invent implementation details, runtime behavior, architecture, developer intent, or historical decisions unless supported by evidence.\n\n"
                "### Code Reasoning\n\n"
                "Reason from the implementation.\n\n"
                "When evaluating behavior:\n"
                "1. Follow the actual control flow.\n"
                "2. Track relevant variable state changes.\n"
                "3. Reference the code responsible for the behavior.\n"
                "4. Prefer concrete execution paths over summaries.\n\n"
                "Do not assume handling for comments, strings, regex literals, template literals, frameworks, or libraries unless the implementation explicitly contains logic for them.\n\n"
                "### Bug Analysis\n\n"
                "A bug requires:\n"
                "* Evidence from the implementation\n"
                "* A plausible failure mechanism\n\n"
                "Preferred:\n"
                "* Reproduction input\n"
                "* Expected behavior\n"
                "* Actual behavior\n\n"
                "If those are not available, classify the finding as:\n"
                "* Concern\n"
                "* Limitation\n"
                "* Assumption\n"
                "* Unknown\n\n"
                "Not a bug.\n\n"
                "### Response Style\n\n"
                "* Speak naturally.\n"
                "* Be concise.\n"
                "* Avoid customer-support language.\n"
                "* Use backticks for identifiers.\n"
                "* Explain your reasoning when it matters.\n"
                "* When giving examples, prefer examples that appear in the provided repository context. "
                "If no repository example is available, either state that explicitly or omit the example.\n"
                "* Sound like an experienced developer reviewing code, not a compliance document.\n"
            )

            # ----------------------------------------------------------------
            # NODE MODE — build system prompt from context
            # ----------------------------------------------------------------
            node_label = ctx.get('nodeLabel', 'Unknown')
            node_type  = ctx.get('nodeType', 'Unknown')
            file_path  = ctx.get('filePath', 'Unknown')
            code       = ctx.get('code', '')

            # Detect file extension for code fence language tag
            ext = file_path.rsplit('.', 1)[-1].lower() if '.' in file_path else ''
            EXT_LANG = {
                'py': 'python', 'js': 'javascript', 'jsx': 'javascript',
                'ts': 'typescript', 'tsx': 'typescript', 'rs': 'rust',
                'go': 'go', 'java': 'java', 'cs': 'csharp',
                'cpp': 'cpp', 'c': 'c', 'rb': 'ruby', 'php': 'php',
            }
            lang = EXT_LANG.get(ext, ext or 'text')

            # ----------------------------------------------------------------
            # Caller / Callee context — full function bodies from server memory
            # ----------------------------------------------------------------
            MAX_CALLER_SNIPPETS = 3
            MAX_CALLEE_SNIPPETS = 1
            MAX_SNIPPET_CHARS   = 1500  # safety cap per body

            node_id = ctx.get('nodeId', '')

            def _get_lang_for_node(nid: str) -> str:
                """Infer markdown language tag from the node's file path."""
                node_obj = _nodes_by_id.get(nid, {})
                np = node_obj.get('path', '') or ''
                ne = np.rsplit('.', 1)[-1].lower() if '.' in np else ''
                return EXT_LANG.get(ne, ne or 'text')

            def _format_snippet(nid: str, role: str) -> str:
                """Return a markdown section for one caller/callee function body."""
                node_obj = _nodes_by_id.get(nid)
                if not node_obj:
                    return ''
                body = (node_obj.get('code') or '')[:MAX_SNIPPET_CHARS]
                if not body:
                    return ''
                label  = node_obj.get('label', nid)
                npath  = node_obj.get('path', '')
                nlang  = _get_lang_for_node(nid)
                return (
                    f"\n### `{label}` — {npath}\n"
                    f"```{nlang}\n{body}\n```\n"
                )

            # Callers — from server-side reverse_call_graph (not frontend payload)
            raw_callers = list(reverse_call_graph.get(node_id, []))
            # Prioritise: same file first, then by outgoing degree (descending)
            def _caller_priority(cid: str):
                is_same_file = 1 if file_path in cid else 0
                degree = len(call_graph.get(cid, []))
                return (-is_same_file, -degree)
            raw_callers.sort(key=_caller_priority)
            selected_callers = raw_callers[:MAX_CALLER_SNIPPETS]

            # Callees — from server-side call_graph
            raw_callees = list(call_graph.get(node_id, []))
            selected_callees = raw_callees[:MAX_CALLEE_SNIPPETS]

            caller_text = ''
            if selected_callers:
                caller_text = (
                    '\n## Caller Context\n\n'
                    'The following functions directly invoke the selected function.\n'
                    'These are provided as supporting evidence to help infer the selected function\'s '
                    'role, expected inputs, assumptions, and intended behavior.\n'
                    'Use this context to improve reasoning about the selected function.\n'
                    'Do not analyze these functions independently unless the user\'s question is specifically about them.\n'
                )
                for cid in selected_callers:
                    caller_text += _format_snippet(cid, 'caller')

            callee_text = ''
            if selected_callees:
                callee_text = (
                    '\n## Callee Context\n\n'
                    'The following functions are directly invoked by the selected function.\n'
                    'These are provided as supporting evidence to help understand the selected function\'s '
                    'dependencies and implementation.\n'
                    'Use this context when it helps explain the selected function.\n'
                    'Do not analyze these functions independently unless the user\'s question is specifically about them.\n'
                )
                for ceid in selected_callees:
                    callee_text += _format_snippet(ceid, 'callee')

            # Format graph name list (still useful for orientation)
            neighbors_text = ''
            raw_neighbors = ctx.get('neighbors', [])
            if isinstance(raw_neighbors, dict):
                # callers-graph perspective mode
                perspective = raw_neighbors.get('perspective', 'unknown')
                nodes_list  = raw_neighbors.get('nodes', [])
                neighbors_text = f"\n## Graph Context ({perspective} call graph)\n"
                neighbors_text += '\n'.join(f'- `{n}`' for n in nodes_list[:15])

            git_text = ''
            if ctx.get('gitStatus'):
                git_text = f"\n## Git Status\nThis file has uncommitted changes: `{ctx['gitStatus']}`\n"

            # Assemble: role + principles + evidence
            system_prompt = (
                "You are a code intelligence assistant embedded in Loom.\n\n"
                f"{ANALYSIS_PRINCIPLES}"
                "---\n\n"
                f"# Selected {node_type.capitalize()}\n\n"
                f"**Name:** `{node_label}`\n\n"
                f"**File:** `{file_path}`\n"
            )

            if code:
                system_prompt += (
                    f"\n# Source Code\n\n"
                    f"```{lang}\n{code}\n```\n"
                )

            system_prompt += neighbors_text
            system_prompt += caller_text
            system_prompt += callee_text
            system_prompt += git_text

            # Build messages array: System prompt + trimmed conversation history
            # Trim BEFORE prepending system message so the system message is never
            # counted against MAX_HISTORY and is always present in full.
            MAX_HISTORY = 12
            trimmed_messages = req.messages[-MAX_HISTORY:]
            messages = [{"role": "system", "content": system_prompt}] + trimmed_messages


            payload = {
                "model": MODEL,
                "messages": messages,
                "stream": True,
                "options": {
                    "temperature": 0.3,
                    "top_p": 0.6,
                    "num_ctx": 8192,
                    "num_predict": -1
                }
            }


            with requests.post(OLLAMA_URL, json=payload, stream=True, timeout=300) as r:
                for line in r.iter_lines():
                    if line:
                        chunk = json.loads(line)
                        if chunk.get("error"):
                            yield f"data: {json.dumps({'error': chunk['error']})}\n\n"
                            return
                        token = chunk.get("message", {}).get("content", "")
                        if token:
                            yield f"data: {json.dumps({'content': token})}\n\n"
                        if chunk.get("done"):
                            break
            yield f"data: {json.dumps({'done': True})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.post("/clear-cache")
async def clear_cache():
    """
    Fully resets Loom state:
    1. Deletes all on-disk graph JSON cache files from CACHE_DIR.
    2. Wipes the GitHub clone temp directory.
    3. Clears all in-memory graph globals.
    Useful for switching repositories cleanly.
    """
    global call_graph, reverse_call_graph, all_nodes, scc_map, scc_members, _nodes_by_id
    try:
        # 1. Delete on-disk cache JSON files
        disk_deleted = 0
        if os.path.exists(CACHE_DIR):
            for fname in os.listdir(CACHE_DIR):
                if fname.endswith(".json"):
                    os.remove(os.path.join(CACHE_DIR, fname))
                    disk_deleted += 1
        # 2. Wipe GitHub clone temp dir
        force_rmtree(TEMP_REPO_DIR)
        # 3. Reset in-memory state
        call_graph = {}
        reverse_call_graph = {}
        all_nodes = []
        scc_map = {}
        scc_members = {}
        _nodes_by_id = {}
        return {"status": "success", "message": f"Cleared {disk_deleted} cache file(s) and reset graph state."}
    except Exception as e:
        return {"status": "error", "message": str(e)}

class ExportRequest(BaseModel):
    node_ids: list[str] = []  # Empty = full graph, otherwise subgraph

class GitStatusRequest(BaseModel):
    repo_path: str

@app.post("/export-graph")
async def export_graph(req: ExportRequest = None):
    """
    Exports the current graph in canonical JSON format.
    Supports full graph or subgraph export via node_ids filter.
    """
    if not all_nodes:
        return {"error": "No graph loaded. Scan a repository first."}
    
    # Determine primary language from file extensions
    ext_counts = {}
    for node in all_nodes:
        if node.get("type") == "file":
            ext = node.get("label", "").split(".")[-1].lower()
            ext_counts[ext] = ext_counts.get(ext, 0) + 1
    
    primary_lang = max(ext_counts, key=ext_counts.get) if ext_counts else "unknown"
    lang_map = {"py": "Python", "js": "JavaScript", "ts": "TypeScript", "jsx": "React", 
                "tsx": "React TypeScript", "java": "Java", "cs": "C#", "go": "Go", 
                "rs": "Rust", "c": "C", "cpp": "C++"}
    primary_lang = lang_map.get(primary_lang, primary_lang.upper())
    
    # Get repo name from path
    repo_name = os.path.basename(current_repo_path.rstrip("/")) if current_repo_path else "unknown"
    
    # Filter nodes if subgraph requested
    node_ids_filter = set(req.node_ids) if req and req.node_ids else None
    
    if node_ids_filter:
        export_nodes = [n for n in all_nodes if n["id"] in node_ids_filter]
        export_edges = [l for l in all_links if l.get("type") == "call" 
                        and l["source"] in node_ids_filter and l["target"] in node_ids_filter]
    else:
        export_nodes = all_nodes
        export_edges = [l for l in all_links if l.get("type") == "call"]
    
    # Format to canonical schema
    formatted_nodes = []
    for node in export_nodes:
        if node.get("type") in ["function", "class", "interface", "struct"]:
            parts = node["id"].split(":")
            file_path = parts[1] if len(parts) >= 2 else ""
            formatted_nodes.append({
                "id": node["id"],
                "name": node.get("label", "").replace("()", ""),
                "file": file_path
            })
    
    formatted_edges = [
        {"from": e["source"], "to": e["target"], "type": "call"}
        for e in export_edges
    ]
    
    return {
        "schema_version": "1.0",
        "meta": {
            "repo": repo_name,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "language": primary_lang
        },
        "nodes": formatted_nodes,
        "edges": formatted_edges
    }

@app.post("/git-status")
async def git_status(req: GitStatusRequest):
    """
    Returns Git working-tree status for files in the repository.
    Maps file status (M/A/D) to graph node IDs.
    """
    repo_path = req.repo_path.replace("\\", "/")
    
    # Check if directory is a git repository
    git_dir = os.path.join(repo_path, ".git")
    if not os.path.exists(git_dir):
        return {"is_git_repo": False, "status": {}}
    
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode != 0:
            return {"is_git_repo": False, "status": {}, "error": result.stderr}
        


        # Parse output: XY PATH format
        file_status = {}
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            status_code = line[:2].strip()
            file_path = line[3:].strip()
            
            # Handle renamed files (format: old -> new)
            if " -> " in file_path:
                file_path = file_path.split(" -> ")[1]
            
            # Map to M/A/D
            if "D" in status_code:
                file_status[file_path] = "D"
            elif "A" in status_code or status_code == "??":
                file_status[file_path] = "A"
            elif "M" in status_code or status_code:
                file_status[file_path] = "M"
        
        # Map file paths to node IDs
        node_status = {}
        for node in all_nodes:
            node_id = node.get("id", "")
            node_label = node.get("label", "")
            
            # Extract file path from node ID (format: type:filepath:name)
            node_file = ""
            if ":" in node_id:
                parts = node_id.split(":")
                if len(parts) >= 2:
                    node_file = parts[1].replace("\\", "/")
            
            # Also check node label for file nodes
            if node.get("type") == "file":
                node_file = node_label
            
            if not node_file:
                continue
                
            # Normalize the node file path for comparison
            node_file_normalized = node_file.replace("\\", "/")
            
            # Check if this file matches any status file
            for status_file, status in file_status.items():
                status_file_normalized = status_file.replace("\\", "/")
                
                # Match if: exact match, ends with slash+file, or file is contained in node path
                if (node_file_normalized == status_file_normalized or 
                    node_file_normalized.endswith("/" + status_file_normalized) or
                    status_file_normalized in node_file_normalized):
                    node_status[node_id] = status
                    break
        
        return {"is_git_repo": True, "status": node_status}
        
    except subprocess.TimeoutExpired:
        return {"is_git_repo": True, "status": {}, "error": "Git command timed out"}
    except Exception as e:
        return {"is_git_repo": False, "status": {}, "error": str(e)}

if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()  
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)