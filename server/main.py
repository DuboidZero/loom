import os, re, ast, json, shutil, requests, nbformat, stat, time, sys, subprocess, hashlib, asyncio
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
CACHE_VERSION = 2  # Bump this when the cache schema changes

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
MODEL = "gemma4:e2b"

# Directories to ignore during scanning
IGNORE_DIRS = {
    "node_modules", ".git", "git-portable", "__pycache__", "venv",
    "dist", "build", ".next", "target",
    ".venv", "env", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".turbo", ".cache", "coverage", "out",
    ".gradle", "bin", "classes",
    "vendor", ".vs", "Debug", "Release", "x64", "x86", "ARM",
    ".idea", ".vscode"
}

IGNORE_FILES = {
    "jquery.js", "jquery.min.js", "jquery.min.map",
    "bootstrap.js", "bootstrap.min.js", "bootstrap.min.map"
}


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

@app.delete("/clear-cache")
async def clear_cache() -> dict:
    """Deletes all cached graph JSON files from CACHE_DIR."""
    try:
        if not os.path.exists(CACHE_DIR):
            return {"status": "ok", "deleted": 0}
        deleted = 0
        for fname in os.listdir(CACHE_DIR):
            if fname.endswith(".json"):
                os.remove(os.path.join(CACHE_DIR, fname))
                deleted += 1
        print(f"Loom: Cleared {deleted} cache file(s) from {CACHE_DIR}")
        return {"status": "ok", "deleted": deleted}
    except Exception as e:
        return {"status": "error", "message": str(e)}

def setup_git_env():
    """Configures the git executable, preferring a bundled portable version if available."""
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

# --- Global Graph State ---
global_symbols = {}       # Map of symbol name -> node ID
call_graph = {}           # Forward edges: caller -> [callees]
reverse_call_graph = {}   # Reverse edges: callee -> [callers]
all_nodes = []            # List of all node objects for lookup
scc_map = {}              # Map of node_id -> scc_id
scc_members = {}          # Map of scc_id -> [node_ids] (only for SCCs with >1 member)
current_repo_path = ""    # Currently scanned repository path
all_links = []            # All links in the graph for export

COMPILED_PATTERNS = {
    "js_ts": {
        "function": re.compile(r'(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\('),
        "class": re.compile(r'(?:export\s+)?class\s+([a-zA-Z0-9_]+)'),
        "interface": re.compile(r'interface\s+([a-zA-Z0-9_]+)\s*{'),
        "struct": re.compile(r'type\s+([a-zA-Z0-9_]+)\s*=\s*{')
    },
    "cpp_c": {
        "function": re.compile(r'(?:[\w:<>]+\s+)+(?:\*|&)?\s*([a-zA-Z_][\w:]*)\s*\([^)]*\)\s*{'),
        "class": re.compile(r'class\s+([a-zA-Z0-9_]+)'),
        "struct": re.compile(r'struct\s+([a-zA-Z0-9_]+)\s*{'),
        "module": re.compile(r'namespace\s+([a-zA-Z0-9_]+)\s*{')
    },
    "java_cs": {
        "function": re.compile(r'[\w<>]+\s+([a-zA-Z_][\w]*)\s*\([^)]*\)\s*{'),
        "class": re.compile(r'class\s+([a-zA-Z0-9_]+)'),
        "interface": re.compile(r'interface\s+([a-zA-Z0-9_]+)\s*{')
    },
    "go": {
        "function": re.compile(r'func\s+([a-zA-Z0-9_]+)\s*\('),
        "interface": re.compile(r'type\s+([a-zA-Z0-9_]+)\s+interface'),
        "struct": re.compile(r'type\s+([a-zA-Z0-9_]+)\s+struct')
    },
    "rust": {
        "function": re.compile(r'fn\s+([a-zA-Z0-9_]+)'),
        "interface": re.compile(r'trait\s+([a-zA-Z0-9_]+)'),
        "class": re.compile(r'(?:struct|enum)\s+([a-zA-Z0-9_]+)'),
        "module": re.compile(r'mod\s+([a-zA-Z0-9_]+)')
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

def force_rmtree(path):
    """
    Removes a directory tree, handling read-only files (common on Windows).
    """
    def on_rm_error(func, path, exc_info):
        os.chmod(path, stat.S_IWRITE)
        func(path)
    if os.path.exists(path):
        shutil.rmtree(path, onerror=on_rm_error)

def extract_code_block(source, start_index):
    """
    Extracts a balanced curly-brace code block starting from a given index.
    
    Args:
        source (str): The full source code string.
        start_index (int): The index of the opening brace (or just before it).
        
    Returns:
        str: The extracted code block inclusive of braces.
    """
    brace_count = 0
    found_first = False
    end_index = start_index
    for i in range(start_index, len(source)):
        char = source[i]
        if char == '{':
            brace_count += 1
            found_first = True
        elif char == '}':
            brace_count -= 1
        if found_first and brace_count == 0:
            end_index = i + 1
            break
    return source[start_index:end_index]

def parse_regex_structure(source, rel_path, file_id, lang_key):
    """
    Parses source code using regex patterns for languages where AST is not available.
    Supports extracton of function, class, interface, struct, and module definitions.
    """
    nodes, links = [], []
    found_symbols = {}
    rules = COMPILED_PATTERNS.get(lang_key, {})
    for type_label, compiled_pattern in rules.items():
        for match in compiled_pattern.finditer(source):
            name = match.group(1)
            # Skip common keywords that might be matched erroneously
            if name in ["if", "for", "while", "return", "switch", "template", "public", "private", "protected"]: continue
            
            node_type = "class" if "class" in type_label else "function"
            nid = f"{node_type}:{rel_path}:{name}"
            found_symbols[name] = nid
            nodes.append({
                "id": nid, 
                "label": f"{name}()" if node_type == "function" else name, 
                "type": node_type, 
                "code": extract_code_block(source, match.start())
            })
            links.append({"source": file_id, "target": nid})
    return nodes, links, found_symbols

def parse_file_structure(file_path, base_path):
    """
    Parses a single file to extract its code structure (nodes) and structure links.
    Uses Python AST for .py files, and regex fallback for others.
    
    Args:
        file_path (str): Absolute path to the file.
        base_path (str): Root directory of the repository.
        
    Returns:
        tuple: (nodes list, links list, found_symbols dict)
    """
    nodes, links = [], []
    found_symbols = {}
    rel_path = os.path.relpath(file_path, base_path).replace("\\", "/")
    file_id = f"file:{rel_path}"
    nodes.append({"id": file_id, "label": os.path.basename(rel_path), "type": "file", "path": rel_path})
    
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            source = f.read() if not file_path.endswith(".ipynb") else "\n".join([c['source'] for c in nbformat.read(f, as_version=4).cells if c.cell_type == 'code'])
    except: return nodes, links, found_symbols
    
    ext = os.path.splitext(file_path)[1].lower()
    if ext in [".py", ".ipynb"]:
        try:
            tree = ast.parse(source)
            lines = source.splitlines()
            for item in ast.walk(tree):
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    itype = "function" if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) else "class"
                    decorator_info = ""
                    if hasattr(item, 'decorator_list') and item.decorator_list:
                        for dec in item.decorator_list:
                            if isinstance(dec, ast.Call) and hasattr(dec.func, 'attr'):
                                decorator_info = f"[@{dec.func.attr}] "
                    
                    display_name = f"{decorator_info}{item.name}"
                    nid = f"{itype}:{rel_path}:{item.name}"
                
                    found_symbols[item.name] = nid
                    nodes.append({
                        "id": nid, 
                        "label": display_name, 
                        "type": itype, 
                        "code": "\n".join(lines[item.lineno-1 : item.end_lineno])
                    })
                    links.append({"source": file_id, "target": nid})
        except: pass
    elif ext in [".js", ".jsx", ".ts", ".tsx"]:
        n, l, s = parse_regex_structure(source, rel_path, file_id, "js_ts")
        nodes.extend(n); links.extend(l); found_symbols.update(s)
    elif ext in [".c", ".cpp", ".h", ".hpp"]:
        n, l, s = parse_regex_structure(source, rel_path, file_id, "cpp_c")
        nodes.extend(n); links.extend(l); found_symbols.update(s)
    elif ext in [".java", ".cs"]:
        n, l, s = parse_regex_structure(source, rel_path, file_id, "java_cs")
        nodes.extend(n); links.extend(l); found_symbols.update(s)
    elif ext == ".go":
        n, l, s = parse_regex_structure(source, rel_path, file_id, "go")
        nodes.extend(n); links.extend(l); found_symbols.update(s)
    elif ext == ".rs":
        n, l, s = parse_regex_structure(source, rel_path, file_id, "rust")
        nodes.extend(n); links.extend(l); found_symbols.update(s)
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
    global global_symbols, call_graph, reverse_call_graph, all_nodes, current_repo_path, all_links
    global_symbols = {} 
    call_graph = {}
    reverse_call_graph = {}
    local_all_nodes = []
    all_links = []
    clean_path = path.replace("\\", "/")
    current_repo_path = clean_path
    local_all_nodes.append({"id": "repo-root", "label": "ROOT", "type": "root"})
    VALID_EXTS = {".py", ".js", ".jsx", ".ts", ".tsx", ".ipynb", ".c", ".cpp", ".h", ".hpp", ".java", ".cs", ".go", ".rs"}
    
    file_paths = []
    for root, dirs, files in os.walk(clean_path):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith('.')]
        for file in files:
            if file in IGNORE_FILES:
                continue

            if any(file.endswith(ext) for ext in VALID_EXTS):
                file_paths.append((os.path.join(root, file), clean_path))
    
    # -----------------------------------------------------------------------
    # Cache check — skip full scan if nothing has changed on disk
    # -----------------------------------------------------------------------
    fingerprint = _compute_fingerprint(file_paths)
    cached = _try_load_cache(clean_path, fingerprint)
    if cached:
        print(f"Loom: Cache HIT for {clean_path} ({len(file_paths)} files)")
        # Restore all global state from cache
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

    # Build forward and reverse adjacency lists
    for link in all_links:
        if link.get('type') == 'call':
            source = link['source']
            target = link['target']
            if source not in call_graph:
                call_graph[source] = []
            if target not in call_graph[source]:
                call_graph[source].append(target)
            if target not in reverse_call_graph:
                reverse_call_graph[target] = []
            if source not in reverse_call_graph[target]:
                reverse_call_graph[target].append(source)

    all_nodes = local_all_nodes
    detect_sccs()

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


def detect_sccs():
    """
    Detects strongly connected components (cycles) using Tarjan's algorithm.
    Populates global `scc_map` and `scc_members`.

    Uses an ITERATIVE DFS implementation (not recursive) to avoid Python's
    default recursion limit (~1000 frames) which causes crashes on large repos
    with deep call chains (e.g. OpenClaw-scale C++ codebases).
    """
    global scc_map, scc_members
    scc_map = {}
    scc_members = {}

    index_counter = [0]
    scc_id_counter = [0]
    stack = []          # Tarjan's SCC stack
    on_stack = set()
    index = {}
    lowlink = {}

    for start in call_graph:
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
        dfs_stack = [(start, iter(call_graph.get(start, [])))]

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
                    dfs_stack.append((neighbor, iter(call_graph.get(neighbor, []))))
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
                        scc_map[w] = scc_id_counter[0]
                        if w == node:
                            break
                    if len(scc_nodes) > 1:
                        scc_members[scc_id_counter[0]] = scc_nodes
                    scc_id_counter[0] += 1


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
        VALID_EXTS = {".py", ".js", ".jsx", ".ts", ".tsx", ".ipynb",
                      ".c", ".cpp", ".h", ".hpp", ".java", ".cs", ".go", ".rs"}
        file_paths = []
        for root_dir, dirs, files in os.walk(clean_path):
            dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith('.')]
            for file in files:
                if file in IGNORE_FILES:
                    continue
                if any(file.endswith(ext) for ext in VALID_EXTS):
                    file_paths.append((os.path.join(root_dir, file), clean_path))

        # Tell the frontend how many files to expect (used for progress bar)
        yield f"data: {json.dumps({'type': 'meta', 'totalFiles': len(file_paths)})}\n\n"

        # --- Cache check ---
        fingerprint = _compute_fingerprint(file_paths)
        cached = _try_load_cache(clean_path, fingerprint)
        if cached:
            # Stream cached data in chunks — still feels instant but progressive
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

        # Build adjacency lists
        for lnk in all_links:
            if lnk.get('type') == 'call':
                src, tgt = lnk['source'], lnk['target']
                if src not in call_graph:
                    call_graph[src] = []
                if tgt not in call_graph[src]:
                    call_graph[src].append(tgt)
                if tgt not in reverse_call_graph:
                    reverse_call_graph[tgt] = []
                if src not in reverse_call_graph[tgt]:
                    reverse_call_graph[tgt].append(src)

        all_nodes = local_all_nodes

        # Phase 3: SCC detection + cache save (user doesn't need to wait)
        detect_sccs()
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
    # Validate function exists
    nodes_by_id = {n['id']: n for n in all_nodes}
    if function_id not in nodes_by_id:
        return {"error": "Function not found in call graph"}
    
    # Extract source file path for metadata
    function_parts = function_id.split(':')
    source_file_path = function_parts[1] if len(function_parts) >= 2 else ''
    
    visited = set()           # For traversal control only
    result_nodes = []
    result_edges = []
    seen_edges = set()        # For edge deduplication
    queue = [(function_id, 0)]
    visited.add(function_id)
    
    while queue and len(result_nodes) < max_nodes:
        current_id, depth = queue.pop(0)
        
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
        
        # Get ALL callers and record ALL edges (including cycle edges)
        callers = reverse_call_graph.get(current_id, [])
        
        for caller_id in callers:
            # Always record the edge (even if caller already visited)
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
            
            # SCC-aware traversal: if caller is in an SCC, include ALL SCC members
            # regardless of depth limit (never partially render an SCC)
            if caller_id not in visited:
                caller_in_scc = caller_id in scc_map and scc_map[caller_id] in scc_members
                
                if caller_in_scc:
                    # Force include all SCC members at same depth
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
    nodes_by_id = {n['id']: n for n in all_nodes}
    if function_id not in nodes_by_id:
        return {"error": "Function not found in call graph"}
    
    function_parts = function_id.split(':')
    source_file_path = function_parts[1] if len(function_parts) >= 2 else ''
    
    visited = set()
    result_nodes = []
    result_edges = []
    seen_edges = set()
    queue = [(function_id, 0)]
    visited.add(function_id)
    
    while queue and len(result_nodes) < max_nodes:
        current_id, depth = queue.pop(0)
        
        if current_id in nodes_by_id:
            node = nodes_by_id[current_id]
            node_parts = current_id.split(':')
            node_file_path = node_parts[1] if len(node_parts) >= 2 else ''
            
            # SCC Info
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
            
            # Complexity Boundary: High Fan-out
            # If this node calls too many functions, we mark it as truncated 
            # and do not add its children to the queue (unless explicitly requested via depth 0 scan?)
            # NOTE: We allow depth 0 (root) even if high fan-out, but won't expand children.
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

        # Process outgoing edges (what does it call?)
        callees = call_graph.get(current_id, [])
        
        # Complexity Boundary: Large SCC
        # If we are currently IN a large SCC, we don't traverse out from it automatically
        # EXCEPT for the edges internal to the SCC.
        stop_transversal = False
        if is_in_cycle and scc_info and scc_info['memberCount'] > 5:
            # We are in a large cycle. We will record edges, but we won't add external callees to queue.
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
                    "caller": current_id,  # Caller is 'current_id' (source)
                    "callee": callee_id,   # Callee is 'callee_id' (target)
                    "isCycleEdge": is_cycle_edge
                })
            
            # Decide to traverse
            if callee_id not in visited:
                callee_in_scc = callee_id in scc_map and scc_map[callee_id] in scc_members
                
                # Rule: Don't traverse out if we stopped at large SCC boundary
                # UNLESS it's an internal cycle edge (we always render the full cycle)
                is_internal_scc_edge = callee_in_scc and is_in_cycle and scc_map[callee_id] == scc_map[current_id]
                
                if stop_transversal and not is_internal_scc_edge:
                    continue

                if callee_in_scc:
                    # Atomic inclusion
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
    Searches for documentation.md files in the file's directory hierarchy.
    Looks in: same directory, parent directories up to repo root.
    
    Args:
        file_path: Absolute path to the source file being analyzed.
        repo_root: Root directory of the repository.
        
    Returns:
        str: Combined content of all found documentation.md files, or empty string.
    """
    doc_content = []
    current_dir = os.path.dirname(file_path)
    repo_root_normalized = os.path.normpath(repo_root)
    
    # Walk up directory tree from file location to repo root
    while current_dir and os.path.normpath(current_dir).startswith(repo_root_normalized):
        doc_path = os.path.join(current_dir, "documentation.md")
        if os.path.exists(doc_path):
            try:
                with open(doc_path, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read().strip()
                    if content:
                        rel_doc_path = os.path.relpath(doc_path, repo_root)
                        doc_content.append(f"[{rel_doc_path}]:\n{content}")
            except:
                pass
        
        parent = os.path.dirname(current_dir)
        if parent == current_dir:  # Reached filesystem root
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
    nodes_by_id = {n['id']: n for n in all_nodes}
    
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


@app.post("/get-details")
async def get_details(req: DetailRequest):
    """
    Analyzes a specific code node using an LLM (Ollama).
    Provides an explanation of the code's purpose and logic.
    
    Enhanced with documentation context:
    - Reads documentation.md files from file's directory hierarchy
    - Extracts docstrings and comments from the code itself
    """
    def is_ollama_alive():
        try:
            response = requests.get(f"{OLLAMA_BASE}/api/tags", timeout=2)
            return response.status_code == 200
        except:
            return False

    if not is_ollama_alive():
        return {"description": "Ollama is not running. Please start the Ollama application to use Loom's analysis features."}

    try:
        actual_path = req.file_path
        if not os.path.exists(actual_path):
             rel_path = req.node_id.split(':')[1]
             actual_path = os.path.join(TEMP_REPO_DIR, rel_path)
        
        # Determine repository root for documentation search
        repo_root = current_repo_path if current_repo_path else os.path.dirname(actual_path)
        


        # Gather documentation context
        doc_context = ""
        
        # 1. Find documentation.md files in directory hierarchy
        documentation_md = find_documentation_files(actual_path, repo_root)
        if documentation_md:
            doc_context += f"\n\nPROJECT DOCUMENTATION:\n---\n{documentation_md}\n---"
        
        # 2. Extract docstrings/comments from the specific code block
        # Find the node's code from all_nodes
        node_code = ""
        for node in all_nodes:
            if node.get("id") == req.node_id:
                node_code = node.get("code", "")
                break
        
        if node_code:
            file_ext = os.path.splitext(actual_path)[1].lower()
            docstring_context = extract_docstring_context(
                node_code, 
                req.label.replace("()", ""), 
                req.node_type, 
                file_ext
            )
            if docstring_context:
                doc_context += f"\n\nEXISTING DOCUMENTATION FOR '{req.label}':\n---\n{docstring_context}\n---"

        # The specific code block being analyzed
        focus_code = node_code if node_code else ""

        # Build call-graph context instead of dumping the full file
        caller_snippets, callee_signatures = build_contextual_prompt(
            req.node_id, req.label, req.node_type, focus_code
        )

        # Build the user prompt with targeted context from the call graph
        prompt_parts = [
            f"Analyze the {req.node_type} named '{req.label}'.",
            f"\nTARGET CODE (this is what you are analyzing):\n```\n{focus_code}\n```" if focus_code else "",
        ]

        # Add caller context (who calls this?)
        if caller_snippets:
            prompt_parts.append(f"\nCALLERS (these functions/classes call '{req.label}'):")
            for cs in caller_snippets:
                prompt_parts.append(f"\n{cs['label']}:\n```\n{cs['code']}\n```")

        # Add callee signatures (what does this call?)
        if callee_signatures:
            prompt_parts.append(f"\nCALLEES (functions/classes that '{req.label}' uses):")
            for cs in callee_signatures:
                prompt_parts.append(f"\n{cs['label']}:\n```\n{cs['signature']}\n```")

        if doc_context:
            prompt_parts.append(f"\nDOCUMENTATION:{doc_context}")

        prompt_parts.append(
            "\nRespond in this exact format:\n"
            "PURPOSE: What this code does — one or two sentences.\n"
            "HOW IT WORKS: How it accomplishes its purpose — reference specific variables, calls, and logic branches you can see in the target code. 2-4 sentences.\n"
            "USAGE: How this code is used by its callers — reference the specific caller functions shown above and explain the role this code plays in each. If no callers are shown, write NOT CALLED DIRECTLY or explain if it is an entry point/endpoint.\n"
            "ISSUES: Any bugs, edge cases, or concerns visible in the code. Write NONE if nothing stands out."
        )

        prompt = "\n".join(p for p in prompt_parts if p)

        system_message = (
            "You are a code analysis tool. Your job is to explain what code does based ONLY on what is explicitly visible in the provided source code.\n\n"
            "STRICT RULES:\n"
            "- ONLY describe logic, variables, and behavior you can directly see in the code.\n"
            "- NEVER invent function behavior, parameters, return values, or side effects that are not visible.\n"
            "- NEVER speculate about code you cannot see. If something is unclear, say UNKNOWN.\n"
            "- Reference specific line details (variable names, function calls, conditions) to support every claim.\n"
            "- Be concise. Do not pad your response with generic software engineering advice.\n"
            "- Follow the requested output format exactly."
        )

        payload = {
            "model": MODEL,
            "messages": [
                {"role": "system", "content": system_message},
                {"role": "user", "content": prompt}
            ],
            "stream": False,
            "options": {
                "temperature": 0.2,
                "top_p": 0.5
            }
        }
        r = await asyncio.to_thread(requests.post, OLLAMA_URL, json=payload, timeout=60)
        result = r.json()
        if "error" in result:
            return {"description": f"Ollama Error: {result['error']}"}
        return {"description": result["message"]["content"]}
    except Exception as e: 
        return {"description": f"Analysis Failed: {str(e)}"}

@app.post("/clear-cache")
async def clear_cache():
    """
    Resets all server state and clears temporary files.
    Useful for switching repositories cleanly.
    """
    global call_graph, reverse_call_graph, all_nodes, scc_map, scc_members
    try:
        force_rmtree(TEMP_REPO_DIR)
        call_graph = {}
        reverse_call_graph = {}
        all_nodes = []
        scc_map = {}
        scc_members = {}
        return {"status": "success", "message": "Cache and graph state cleared."}
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
        
        print(f"DEBUG: git status output for {repo_path}:\n{result.stdout}")

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