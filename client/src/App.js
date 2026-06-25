import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import { CameraControls, Text, PerspectiveCamera, Line, Float, ContactShadows, Billboard, Html } from "@react-three/drei";
import { invoke } from "@tauri-apps/api/core";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { applyFilters, DEFAULT_FILTER_STATE } from "./filters";
import OllamaInstaller from './OllamaInstaller';
import GitInstaller from './GitInstaller';
import WelcomeScreen, { saveRecentWorkspace } from './WelcomeScreen';
import Sidebar from './Sidebar';
import ReactMarkdown from 'react-markdown';
import logo from './logo.png';
import BottomDock from './BottomDock';

const LAST_WORKSPACE_KEY = 'loom_last_workspace';

// ---------------------------------------------------------------------------
// TopMenuBar — VSCode-style slim menu bar
// ---------------------------------------------------------------------------
function TopMenuBar({
  hasWorkspace, workspaceName,
  onOpenFolder, onOpenGithub, onCloseWorkspace,
  view, callPerspective, setCallPerspective,
  filterState, setFilterState,
  gitOverlayEnabled, setGitOverlayEnabled,
  onExportJSON, onExportSVG,
  onOpenSettings, onOpenAbout,
  nodes, selectedNodes,
  loading,
}) {
  const [openMenu, setOpenMenu] = useState(null); // 'workspace' | 'view' | 'export' | 'settings'
  const [githubModalOpen, setGithubModalOpen] = useState(false);
  const [githubUrlInput, setGithubUrlInput] = useState('');

  const closeAll = () => setOpenMenu(null);

  const handleGithubSubmit = () => {
    if (!githubUrlInput.trim()) return;
    onOpenGithub(githubUrlInput.trim());
    setGithubModalOpen(false);
    setGithubUrlInput('');
    closeAll();
  };

  // Close menus on outside click
  useEffect(() => {
    const handler = () => closeAll();
    if (openMenu) {
      document.addEventListener('click', handler);
      return () => document.removeEventListener('click', handler);
    }
  }, [openMenu]);

  return (
    <>
      <nav className="top-menubar" onClick={e => e.stopPropagation()}>
        {/* Brand */}
        <div className="top-menubar__brand" onClick={() => setOpenMenu(null)}>
          <img src={logo} alt="" className="top-menubar__logo" />
          <span className="top-menubar__title">LOOM</span>
        </div>

        {/* Workspace menu */}
        <div className="top-menubar__item">
          <button
            className={`top-menubar__btn${openMenu === 'workspace' ? ' top-menubar__btn--open' : ''}`}
            onClick={e => { e.stopPropagation(); setOpenMenu(openMenu === 'workspace' ? null : 'workspace'); }}
            id="menu-workspace"
          >
            File
          </button>
          {openMenu === 'workspace' && (
            <div className="top-menubar__dropdown">
              <div className="top-menubar__menu-item" onClick={() => { onOpenFolder(); closeAll(); }}>
                📂 Open Folder...
              </div>
              <div className="top-menubar__menu-item" onClick={() => { closeAll(); setGithubModalOpen(true); }}>
                ⎇ Clone GitHub Repository...
              </div>
              {hasWorkspace && (
                <>
                  <div className="top-menubar__menu-sep" />
                  <div className="top-menubar__menu-item top-menubar__menu-item--danger" onClick={() => { onCloseWorkspace(); closeAll(); }}>
                    ✕ Close Workspace
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* View menu — only when workspace loaded */}
        {hasWorkspace && nodes.length > 0 && (
          <div className="top-menubar__item">
            <button
              className={`top-menubar__btn${openMenu === 'view' ? ' top-menubar__btn--open' : ''}`}
              onClick={e => { e.stopPropagation(); setOpenMenu(openMenu === 'view' ? null : 'view'); }}
              id="menu-view"
            >
              View
            </button>
            {openMenu === 'view' && (
              <div className="top-menubar__dropdown">
                <div className="top-menubar__menu-section">Graph Perspective</div>
                <div
                  className={`top-menubar__menu-item${callPerspective === 'forward' ? ' top-menubar__menu-item--active' : ''}`}
                  onClick={() => { setCallPerspective('forward'); closeAll(); }}
                >
                  {callPerspective === 'forward' ? '✔ ' : '  '}Forward Call Graph
                </div>
                <div
                  className={`top-menubar__menu-item${callPerspective === 'reverse' ? ' top-menubar__menu-item--active' : ''}`}
                  onClick={() => { setCallPerspective('reverse'); closeAll(); }}
                >
                  {callPerspective === 'reverse' ? '✔ ' : '  '}Reverse Call Graph
                </div>
                <div className="top-menubar__menu-sep" />
                <div className="top-menubar__menu-section">Cycle Display</div>
                <div
                  className={`top-menubar__menu-item${filterState.cycleMode === 'collapse' ? ' top-menubar__menu-item--active' : ''}`}
                  onClick={() => { setFilterState(p => ({ ...p, cycleMode: 'collapse' })); closeAll(); }}
                >
                  {filterState.cycleMode === 'collapse' ? '✔ ' : '  '}Collapse Large Cycles
                </div>
                <div
                  className={`top-menubar__menu-item${filterState.cycleMode === 'show' ? ' top-menubar__menu-item--active' : ''}`}
                  onClick={() => { setFilterState(p => ({ ...p, cycleMode: 'show' })); closeAll(); }}
                >
                  {filterState.cycleMode === 'show' ? '✔ ' : '  '}Expand All Cycles
                </div>
                <div className="top-menubar__menu-sep" />
                <div
                  className="top-menubar__menu-item"
                  onClick={() => { setGitOverlayEnabled(g => !g); closeAll(); }}
                >
                  {gitOverlayEnabled ? '☑' : '☐'} Git Status Overlay
                </div>
              </div>
            )}
          </div>
        )}

        {/* Export menu */}
        {hasWorkspace && nodes.length > 0 && (
          <div className="top-menubar__item">
            <button
              className={`top-menubar__btn${openMenu === 'export' ? ' top-menubar__btn--open' : ''}`}
              onClick={e => { e.stopPropagation(); setOpenMenu(openMenu === 'export' ? null : 'export'); }}
              id="menu-export"
            >
              Export{selectedNodes.size > 0 ? ` (${selectedNodes.size})` : ''}
            </button>
            {openMenu === 'export' && (
              <div className="top-menubar__dropdown">
                <div className="top-menubar__menu-item" onClick={() => { onExportJSON(); closeAll(); }}>Export as JSON</div>
                <div className="top-menubar__menu-item" onClick={() => { onExportSVG(); closeAll(); }}>Export as SVG</div>
                {selectedNodes.size > 0 && (
                  <div className="top-menubar__menu-section">{selectedNodes.size} nodes selected (shift-click)</div>
                )}
              </div>
            )}
          </div>
        )}


        <div className="top-menubar__spacer" />

        {/* Scanning indicator */}
        {loading && (
          <span style={{ fontSize: 11, color: '#666', paddingRight: 12, fontFamily: 'var(--font-mono)', animation: 'pulse 1.5s infinite' }}>
            Scanning...
          </span>
        )}

        {/* Settings menu — far right, dropdown opens leftward */}
        <div className="top-menubar__item">
          <button
            className={`top-menubar__btn${openMenu === 'settings' ? ' top-menubar__btn--open' : ''}`}
            onClick={e => { e.stopPropagation(); setOpenMenu(openMenu === 'settings' ? null : 'settings'); }}
            id="menu-settings"
          >
            ⚙
          </button>
          {openMenu === 'settings' && (
            <div className="top-menubar__dropdown top-menubar__dropdown--right">
              <div className="top-menubar__menu-item" onClick={() => { onOpenSettings(); closeAll(); }}>Configuration...</div>
              <div className="top-menubar__menu-item" onClick={() => { onOpenAbout(); closeAll(); }}>About Loom</div>
            </div>
          )}
        </div>
      </nav>

      {/* GitHub URL modal */}
      {githubModalOpen && (
        <div className="top-menubar__github-modal-overlay" onClick={() => setGithubModalOpen(false)}>
          <div className="top-menubar__github-modal" onClick={e => e.stopPropagation()}>
            <h3>Clone GitHub Repository</h3>
            <div className="top-menubar__github-modal-row">
              <input
                className="top-menubar__github-input"
                placeholder="https://github.com/user/repo"
                value={githubUrlInput}
                onChange={e => setGithubUrlInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleGithubSubmit()}
                autoFocus
                id="menubar-github-input"
              />
              <button className="top-menubar__github-submit" onClick={handleGithubSubmit} id="menubar-github-submit">
                Analyze
              </button>
              <button className="top-menubar__github-cancel" onClick={() => setGithubModalOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const API = "http://127.0.0.1:8000";

/**
 * CameraHandler Component
 * 
 * Manages the 3D camera controls, specifically:
 * - Focusing on selected nodes
 * - Resetting view when selection clears
 * - Constraining zoom levels based on graph size
 */
function CameraHandler({ selected, layout, sphereRadius, focusSignal, dockOpen }) {
  const controls = useRef();
  useEffect(() => {
    // Defer via rAF: ensures CameraControls ref is populated after Three.js
    // has committed the scene. Without this, the ref is null on first mount
    // (e.g. after switching back from callers view) and setLookAt silently
    // no-ops, leaving the camera at the default far-out position.
    const rafId = requestAnimationFrame(() => {
      if (selected && layout[selected.id]) {
        const [x, y, z] = layout[selected.id];
        const zOffset = dockOpen ? 15 : 50;
        const yOffset = dockOpen ? 2 : 10;
        controls.current?.setLookAt(x, y + yOffset, z + zOffset, x, y, z, true);
      } else if (!selected) {
        // Only zoom out when selection is explicitly cleared, not on signal
        const defaultDistance = sphereRadius * 3.5;
        const defaultHeight   = sphereRadius * 2;
        controls.current?.setLookAt(0, defaultHeight, defaultDistance, 0, 0, 0, true);
      }
    });
    return () => cancelAnimationFrame(rafId);
  // focusSignal forces re-fire even when `selected` is the same object,
  // e.g. when "View in Main Graph" is clicked for an already-selected node.
  }, [selected, layout, sphereRadius, focusSignal, dockOpen]);
  return <CameraControls ref={controls} makeDefault minDistance={10} maxDistance={sphereRadius * 10} />;
}

/**
 * Main Application Component
 * 
 * Manages the entire application state including:
 * - Repository scanning and graph data
 * - Visualization modes (Main Graph vs Callers Graph)
 * - User interactions (selection, filtering, search)
 * - Backend communication
 */
export default function App() {
  // --- Startup Gates ---
  const [gitReady, setGitReady] = useState(false);
  const [ollamaReady, setOllamaReady] = useState(false);

  const [view, setView] = useState("map"); // 'map' | 'callers' | 'welcome'
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [leftWidth, setLeftWidth]   = useState(260);  // px — left sidebar
  const [rightWidth, setRightWidth] = useState(360);  // px — right inspector
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  // Incrementing this forces CameraHandler to re-focus even when `selected`
  // hasn't changed (same node reference, different context).
  const [cameraFocusSignal, setCameraFocusSignal] = useState(0);

  // --- Bottom Dock State ---
  const [dockOpen, setDockOpen]       = useState(false);
  const [dockHeight, setDockHeight]   = useState(320);  // px
  const [dockTab, setDockTab]         = useState('source'); // 'source' | 'chat'

  // Source editor — DECOUPLED from graph selection.
  // selectedNode drives the inspector; openDocument drives the editor.
  // Clicking a node in the graph does NOT change openDocument.
  // Only explicit actions ("View Source" button, Ctrl+1 with a node selected) do.
  const [openDocument, setOpenDocument] = useState(null); // { node, code, language }

  // AI Chat — history persists across node changes
  const [chatMessages, setChatMessages] = useState([]);   // [{role, content}]
  const [chatInput, setChatInput]       = useState('');
  const [chatLoading, setChatLoading]   = useState(false);
  // Tracks the node that was active when the most recent chat message was sent.
  // When this differs from `selected`, the context-switched banner appears.
  const [chatContextNode, setChatContextNode] = useState(null);

  const [config, setConfig] = useState({
    ollamaHost: "http://127.0.0.1:11434",
    customGitPath: ""
  });

  // --- Main Graph Data ---
  const [nodes, setNodes] = useState([]);
  const [links, setLinks] = useState([]);
  const [repoPath, setRepoPath] = useState("");
  const [loading, setLoading] = useState(false);

  // Buffer for incremental streaming: accumulates incoming nodes/links between
  // 250ms flush ticks so the 3D layout only recalculates ~4 times per second.
  const streamBufferRef = useRef({ nodes: [], links: [] });
  const [scanProgress, setScanProgress] = useState({ files: 0, total: 0, phase: '' });

  // Derived workspace display name — memoised so the regex+split doesn't run on every render
  const workspaceName = useMemo(
    () => repoPath ? repoPath.replace(/\\/g, '/').split('/').pop() || repoPath : null,
    [repoPath]
  );

  // --- Interaction State ---
  const [selected, setSelected] = useState(null);
  const abortRef = useRef(null); // Cancels in-flight AI analysis fetch when a new node is clicked
  const [details, setDetails] = useState("");
  const [search, setSearch] = useState("");

  // --- Filtering State (Main Graph) ---
  const [hiddenLangs, setHiddenLangs] = useState(new Set());
  const [hiddenTypes, setHiddenTypes] = useState(new Set());
  const [showFilterMenu, setShowFilterMenu] = useState(false);

  // --- Export & Selection State ---
  const [selectedNodes, setSelectedNodes] = useState(new Set()); // Multi-select for subgraph export
  const [gitStatus, setGitStatus] = useState({}); // nodeId -> 'M'|'A'|'D'
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);

  // --- Consolidated Dropdown State ---
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [gitOverlayEnabled, setGitOverlayEnabled] = useState(true);
  const [gitLegendExpanded, setGitLegendExpanded] = useState(false);

  // --- Callers Graph State (Canvas-based) ---
  const [callersGraphData, setCallersGraphData] = useState(null);
  const [callersSourceFile, setCallersSourceFile] = useState(null);
  const [callersLoading, setCallersLoading] = useState(false);
  const [callersDepth, setCallersDepth] = useState(2); // Rule 1: Default to 2
  const [expandedSCCs, setExpandedSCCs] = useState(new Set());
  const [hoveredCycleNode, setHoveredCycleNode] = useState(null);
  const [inspectorNode, setInspectorNode] = useState(null);
  const [callPerspective, setCallPerspective] = useState("reverse"); // 'reverse' | 'forward'

  // --- Filter State (Callers Graph) ---
  const [filterState, setFilterState] = useState({
    ...DEFAULT_FILTER_STATE,
    maxDepth: 10  // Synced with callersDepth slider
  });

  // --- Keybinds Configuration ---
  const [keybinds, setKeybinds] = useState({
    forward: 'f',
    reverse: 'r',
    toggleSCC: 's',
    export: 'e'
  });

  // --- Memoized Calculations ---

  // Compute filtered graph for rendering and stats
  const filteredGraph = useMemo(() => {
    if (!callersGraphData) return null;
    const filterConfig = { ...filterState, expandedSCCs };
    return applyFilters(callersGraphData.nodes, callersGraphData.edges, filterConfig);
  }, [callersGraphData, filterState, expandedSCCs]);

  // Flush the stream buffer into React state every 250ms while a scan is running.
  // This batches SSE events so the 3D layout useMemo doesn't fire hundreds of times.
  useEffect(() => {
    if (!loading) return;
    const interval = setInterval(() => {
      const { nodes: bn, links: bl } = streamBufferRef.current;
      if (bn.length > 0 || bl.length > 0) {
        streamBufferRef.current = { nodes: [], links: [] }; // clear first to avoid races
        setNodes(prev => {
          const existing = new Set(prev.map(n => n.id));
          return [...prev, ...bn.filter(n => !existing.has(n.id))];
        });
        setLinks(prev => [...prev, ...bl]);
      }
    }, 250);
    return () => clearInterval(interval);
  }, [loading]);

  // --- Bottom Dock Handlers ---
  const startDockResize = useCallback((e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = dockHeight;
    const maxH = window.innerHeight * 0.8;

    // Add .no-transition class during drag to prevent jank
    const dockEl = document.querySelector('.bottom-dock');
    if (dockEl) dockEl.classList.add('no-transition');

    const onMove = (ev) => {
      // Moving up (negative deltaY) increases dock height
      const deltaY = startY - ev.clientY;
      const next = Math.max(140, Math.min(maxH, startHeight + deltaY));
      setDockHeight(next);
      if (!dockOpen && next > 140) setDockOpen(true);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (dockEl) dockEl.classList.remove('no-transition');
      // Trigger a resize event to ensure Monaco updates its layout
      window.dispatchEvent(new Event('resize'));
    };

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [dockHeight, dockOpen]);

  const openSource = useCallback(async (node) => {
    if (!node) return;
    let language = 'javascript';
    if (node.type === 'function' || node.type === 'class') {
      const ext = node.id.split(':')[1]?.split('.').pop() || '';
      language = ext === 'py' ? 'python' : ext === 'ts' || ext === 'tsx' ? 'typescript' : 'javascript';
    } else if (node.type === 'file') {
      const ext = node.label.split('.').pop();
      language = ext === 'py' ? 'python' : ext === 'ts' || ext === 'tsx' ? 'typescript' : 'javascript';
    }
    
    let code = node.code;
    if (!code) {
      const isGithub = repoPath.startsWith("http") || repoPath.includes("github.com");
      const filePath = isGithub ? (node.id.split(':')[1] || node.label) : repoPath.replace(/\\/g, "/") + "/" + (node.id.split(':')[1] || node.label);
      try {
        const res = await fetch(`${API}/node-source`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ node_id: node.id, file_path: filePath })
        });
        const data = await res.json();
        if (data.code) code = data.code;
      } catch (e) {}
    }

    setOpenDocument({
      node,
      code: code || '// Source not available',
      language
    });
    setDockTab('source');
    setDockOpen(true);
  }, [repoPath]);

  const buildChatContext = useCallback(() => {
    if (!selected) {
      return {
        repoPath,
        view,
        nodeCount: nodes.length
      };
    }

    const context = {
      nodeId: selected.id,
      nodeLabel: selected.label,
      nodeType: selected.type,
      filePath: selected.id.split(':')[1] || selected.label,
      code: selected.code,
    };

    if (view === 'callers' && callersGraphData) {
      context.neighbors = {
        perspective: callPerspective,
        nodes: callersGraphData.nodes.map(n => n.label)
      };
    } else {
      const relatedLinks = links.filter(l => l.source === selected.id || l.target === selected.id);
      context.neighbors = relatedLinks.map(l => ({
        type: l.type,
        target: l.target === selected.id ? l.source : l.target
      }));
    }

    if (isGitRepo && Object.keys(gitStatus).length > 0) {
      const fileId = selected.type === 'file' ? selected.label : selected.id.split(':')[1];
      if (gitStatus[fileId]) {
        context.gitStatus = gitStatus[fileId];
      }
    }

    return context;
  }, [selected, repoPath, view, nodes.length, callersGraphData, callPerspective, links, isGitRepo, gitStatus]);

  const sendChatMessage = async (msg) => {
    if (!msg.trim() || chatLoading) return;

    const context = buildChatContext();
    setChatContextNode(selected);

    // Lazy-fetch source code at send-time so the AI always sees the actual
    // implementation. We intentionally skip file nodes (too large / no single
    // body to extract) and skip if code was somehow already populated.
    if (selected && selected.type !== 'file' && !context.code) {
      try {
        const isGithub = repoPath.startsWith('http') || repoPath.includes('github.com');
        const filePath = isGithub
          ? (selected.id.split(':')[1] || selected.label)
          : repoPath.replace(/\\/g, '/') + '/' + (selected.id.split(':')[1] || selected.label);
        const res = await fetch(`${API}/node-source`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ node_id: selected.id, file_path: filePath })
        });
        const data = await res.json();
        if (data.code) context.code = data.code;
      } catch (e) {
        // Non-fatal — chat continues without code context
        console.warn('sendChatMessage: could not fetch source for', selected.id, e);
      }
    }

    const newMessages = [...chatMessages, { role: 'user', content: msg }];
    setChatMessages(newMessages);
    setChatInput('');
    setChatLoading(true);

    try {
      const res = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          context
        })
      });

      if (!res.ok) throw new Error(`Server returned ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantMsg = '';

      setChatMessages(prev => [...prev, { role: 'assistant', content: '' }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.error) throw new Error(evt.error);
            if (evt.content) {
              assistantMsg += evt.content;
              // Spread a new object to avoid mutating the existing message in-place
              setChatMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  content: assistantMsg
                };
                return updated;
              });
            }
          } catch (e) {
            console.error('SSE Error:', e);
          }
        }
      }
    } catch (e) {
      setChatMessages(prev => [...prev, { role: 'assistant', content: `**Error:** ${e.message}` }]);
    } finally {
      setChatLoading(false);
    }
  };

  // Consolidated keyboard handler
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't trigger shortcuts when typing in input fields
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      const key = e.key.toLowerCase();

      // --- Meta/Ctrl Shortcuts ---
      if (e.ctrlKey || e.metaKey) {
        if (key === 'b') {
          e.preventDefault();
          setSidebarCollapsed(c => !c);
          return;
        }
        if (key === 'j') {
          e.preventDefault();
          setDockOpen(o => !o);
          return;
        }
        if (key === '1') {
          e.preventDefault();
          if (selected) openSource(selected);
          return;
        }
        if (key === '2') {
          e.preventDefault();
          setDockTab('chat');
          setDockOpen(true);
          return;
        }
      }

      // --- Regular Shortcuts ---
      if (key === keybinds.forward) {
        setCallPerspective('forward');
      } else if (key === keybinds.reverse) {
        setCallPerspective('reverse');
      } else if (key === keybinds.toggleSCC) {
        setFilterState(prev => ({
          ...prev,
          cycleMode: prev.cycleMode === 'collapse' ? 'show' : 'collapse'
        }));
      } else if (key === keybinds.export) {
        setShowExportMenu(prev => !prev);
        setShowModeMenu(false);
        setShowSettingsMenu(false);
      } else if (key === 'escape') {
        // Escape priority:
        // 1. Legacy Menus
        if (showModeMenu || showExportMenu || showSettingsMenu) {
          setShowModeMenu(false);
          setShowExportMenu(false);
          setShowSettingsMenu(false);
          return;
        }
        
        // 2. Bottom Dock
        if (dockOpen) {
          setDockOpen(false);
          return;
        }

        // 3. Callers View
        if (view === 'callers') {
          const targetNode = inspectorNode || selected;
          setView('map');
          setInspectorNode(null);
          if (targetNode) {
            const targetId = targetNode.id;
            const targetName = targetNode.name || targetNode.label;
            setTimeout(() => {
              let mainNode = nodes.find(n => n.id === targetId);
              if (!mainNode && targetName) {
                mainNode = nodes.find(
                  n => n.label === targetName && (n.type === 'function' || n.type === 'class')
                );
              }
              if (mainNode) {
                setSelected(null);
                setTimeout(() => setSelected(mainNode), 50);
              }
            }, 150);
          }
          return;
        }
        
        // 4. Map View (Inspector -> Selection -> Parent Navigation)
        if (view === 'map') {
          if (!inspectorCollapsed) {
            setInspectorCollapsed(true);
          } else if (selected) {
            if (['function', 'class', 'interface', 'struct'].includes(selected.type)) {
              const parts = selected.id?.split(':');
              if (parts && parts.length >= 2) {
                const filePath = parts[1];
                const parentFile = nodes.find(n => n.type === 'file' && n.id?.includes(filePath));
                if (parentFile) {
                  setSelected(parentFile);
                  return;
                }
              }
            }
            setSelected(null);
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    keybinds, view, selected, inspectorNode, nodes, 
    showModeMenu, showExportMenu, showSettingsMenu,
    dockOpen, inspectorCollapsed, openSource, dockHeight
  ]);

  /**
   * Updates global configuration on the backend.
   */
  const updateBackendConfig = async (newConfig) => {
    try {
      await fetch(`${API}/update-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newConfig)
      });
    } catch (e) { console.error("Config sync failed", e); }
  };

  /**
   * Attempts to start the Ollama service via Tauri invoke.
   */
  const startOllama = async () => {
    try {
      await invoke("run_ollama_serve");
      alert("Ollama initialization signal sent.");
    } catch (e) { alert("Failed to start Ollama: " + e); }
  };

  // ── Resize callbacks ──────────────────────────────────────────────────────
  // Both follow the same pattern: capture startX + startWidth at mousedown,
  // then compute delta on mousemove. Avoids stale closure issues because
  // startWidth is captured once (not read from state on every frame).

  const startLeftResize = useCallback((e) => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = leftWidth;
    const onMove = (ev) => {
      const next = Math.max(160, Math.min(540, startWidth + ev.clientX - startX));
      setLeftWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor     = 'ew-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  }, [leftWidth]);

  const startRightResize = useCallback((e) => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = rightWidth;
    // Moving cursor LEFT increases the right panel's width
    const onMove = (ev) => {
      const next = Math.max(240, Math.min(640, startWidth + startX - ev.clientX));
      setRightWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor     = 'ew-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  }, [rightWidth]);

  const handleClearAll = async () => {
    setLoading(true);
    try {
      await fetch(`${API}/clear-cache`, { method: "POST" });
      setNodes([]);
      setLinks([]);
      setRepoPath("");
      setSelected(null);
      setDetails("");
      alert("Canvas and Cache cleared.");
    } catch (e) {
      alert("Clear failed: " + e.message);
    }
    setLoading(false);
  };

  /**
   * Initiates a repository scan.
   * - GitHub URLs: existing fetch → JSON (streaming doesn't help clone waits)
   * - Local paths: SSE streaming via EventSource → nodes appear as parsed
   */
  const handleScan = async () => {
    if (!repoPath) return alert("Enter a path or GitHub URL.");
    setLoading(true);
    setSelected(null);
    setSelectedNodes(new Set());
    setDetails("");
    setGitStatus({});
    setIsGitRepo(false);
    setNodes([]);
    setLinks([]);
    streamBufferRef.current = { nodes: [], links: [] };
    setScanProgress({ files: 0, total: 0, phase: 'Scanning...' });

    const isGithub = repoPath.startsWith("http") || repoPath.includes("github.com");

    if (isGithub) {
      // GitHub: keep existing blocking fetch (must wait for clone anyway)
      try {
        const endpoint = `${API}/map-github?repo_url=${encodeURIComponent(repoPath.trim())}`;
        const res = await fetch(endpoint);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setNodes(data.nodes || []);
        setLinks(data.links || []);
      } catch (e) { alert("Error: " + e.message); }
      setScanProgress({ files: 0, total: 0, phase: '' });
      setLoading(false);
      return;
    }

    // Local path: stream via SSE
    const url = `${API}/map-repo-stream?path=${encodeURIComponent(repoPath.replace(/\\/g, "/"))}`;
    const es = new EventSource(url);
    const seenNodeIds = new Set();

    es.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      switch (msg.type) {
        case 'meta':
          setScanProgress(p => ({ ...p, total: msg.totalFiles, phase: 'Parsing files' }));
          break;

        case 'status':
          setScanProgress(p => ({ ...p, phase: msg.message }));
          break;

        case 'nodes': {
          const fresh = (msg.nodes || []).filter(n => !seenNodeIds.has(n.id));
          fresh.forEach(n => seenNodeIds.add(n.id));
          streamBufferRef.current.nodes.push(...fresh);
          streamBufferRef.current.links.push(...(msg.links || []));
          if (msg.progress !== undefined)
            setScanProgress(p => ({ ...p, files: msg.progress }));
          break;
        }

        case 'links':
          streamBufferRef.current.links.push(...(msg.links || []));
          break;

        case 'done': {
          // Final flush — drain whatever is left in the buffer
          const { nodes: bn, links: bl } = streamBufferRef.current;
          streamBufferRef.current = { nodes: [], links: [] };
          if (bn.length > 0 || bl.length > 0) {
            setNodes(prev => {
              const existing = new Set(prev.map(n => n.id));
              return [...prev, ...bn.filter(n => !existing.has(n.id))];
            });
            setLinks(prev => [...prev, ...bl]);
          }
          es.close();
          setLoading(false);
          setScanProgress({ files: 0, total: 0, phase: '' });
          fetchGitStatus(repoPath.replace(/\\/g, "/"));
          break;
        }

        case 'error':
          es.close();
          setLoading(false);
          setScanProgress({ files: 0, total: 0, phase: '' });
          alert("Scan error: " + msg.message);
          break;

        default: break;
      }
    };

    es.onerror = () => {
      es.close();
      setLoading(false);
      setScanProgress({ files: 0, total: 0, phase: '' });
      alert("Streaming connection lost. Check the backend is running.");
    };
  };

  /**
   * Fetches Git working-tree status and maps to graph nodes.
   */
  const fetchGitStatus = async (path) => {
    try {
      const res = await fetch(`${API}/git-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo_path: path })
      });
      const data = await res.json();
      setIsGitRepo(data.is_git_repo || false);
      setGitStatus(data.status || {});
    } catch (e) {
      console.error("Git status fetch failed:", e);
    }
  };

  /**
   * Browser fallback for file download (when not running in Tauri)
   */
  const downloadFallback = (filename, content, mimeType = 'text/plain') => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  /**
   * Exports graph to JSON file - works for main graph or callers graph
   */
  const exportJSON = async () => {
    try {
      let exportData;
      let filename;

      if (view === 'callers' && callersGraphData) {
        // Export callers graph directly (already in correct format)
        exportData = {
          schema_version: "1.0",
          meta: {
            repo: repoPath.split('/').pop() || "graph",
            generated_at: new Date().toISOString(),
            type: callPerspective === 'forward' ? 'forward_call_graph' : 'reverse_call_graph'
          },
          nodes: callersGraphData.nodes.map(n => ({
            id: n.id,
            name: n.name,
            file: n.fileId || ''
          })),
          edges: callersGraphData.edges.map(e => ({
            from: e.caller,
            to: e.callee,
            type: 'call'
          }))
        };
        filename = `${callPerspective}_callgraph_export.json`;
      } else {
        // Export main graph via backend
        const nodeIds = selectedNodes.size > 0 ? Array.from(selectedNodes) : [];
        const res = await fetch(`${API}/export-graph`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ node_ids: nodeIds })
        });
        exportData = await res.json();
        if (exportData.error) throw new Error(exportData.error);
        filename = `${exportData.meta?.repo || "graph"}_export.json`;
      }

      const content = JSON.stringify(exportData, null, 2);

      // Try Tauri save dialog, fallback to browser download
      try {
        const filePath = await save({
          filters: [{ name: "JSON", extensions: ["json"] }],
          defaultPath: filename
        });
        if (filePath) {
          await writeTextFile(filePath, content);
        }
      } catch {
        downloadFallback(filename, content, 'application/json');
      }
    } catch (e) {
      alert("Export failed: " + e.message);
    }
    setShowExportMenu(false);
  };

  /**
   * Exports graph to SVG - works for main graph or callers graph
   */
  const exportSVG = async () => {
    try {
      let targetNodes, targetLinks, positions;

      // Spacing multipliers for better readability on large graphs
      const HORIZONTAL_SPACING = 400;  // Ample space between siblings
      const VERTICAL_SPACING = 250;    // Ample space between depth levels

      if (view === 'callers' && callersGraphData && filteredGraph) {
        // Use callers graph data with hierarchical layout
        targetNodes = filteredGraph.nodes;
        targetLinks = filteredGraph.edges.map(e => ({ source: e.caller, target: e.callee, type: 'call' }));

        // Generate hierarchical 2D positions with more spacing
        positions = {};
        const nodesByDepth = {};
        targetNodes.forEach(n => {
          const depth = n.depth || 0;
          if (!nodesByDepth[depth]) nodesByDepth[depth] = [];
          nodesByDepth[depth].push(n);
        });

        // Center nodes at each depth level
        Object.entries(nodesByDepth).forEach(([depth, nodes]) => {
          const totalWidth = (nodes.length - 1) * HORIZONTAL_SPACING;
          const startX = -totalWidth / 2;
          nodes.forEach((n, i) => {
            positions[n.id] = [startX + i * HORIZONTAL_SPACING, parseInt(depth) * VERTICAL_SPACING];
          });
        });
      } else {
        // Use main graph with scaled positions
        targetNodes = selectedNodes.size > 0
          ? filteredNodes.filter(n => selectedNodes.has(n.id))
          : filteredNodes;
        targetLinks = filteredLinks.filter(l =>
          targetNodes.some(n => n.id === l.source) && targetNodes.some(n => n.id === l.target)
        );
        // Scale up main graph positions for better SVG layout
        positions = {};
        Object.entries(layoutPositions).forEach(([id, pos]) => {
          if (pos) {
            positions[id] = [pos[0] * 5, pos[1] * 5]; // 5x scale for large graphs
          }
        });
      }

      // Simple force-based separation to prevent overlaps
      const MIN_DISTANCE = 80; // Minimum distance between node centers
      const ITERATIONS = 50;
      const nodeIds = Object.keys(positions);

      for (let iter = 0; iter < ITERATIONS; iter++) {
        let moved = false;
        for (let i = 0; i < nodeIds.length; i++) {
          for (let j = i + 1; j < nodeIds.length; j++) {
            const id1 = nodeIds[i];
            const id2 = nodeIds[j];
            const p1 = positions[id1];
            const p2 = positions[id2];
            if (!p1 || !p2) continue;

            const dx = p2[0] - p1[0];
            const dy = p2[1] - p1[1];
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < MIN_DISTANCE && dist > 0) {
              // Push nodes apart
              const overlap = (MIN_DISTANCE - dist) / 2;
              const nx = dx / dist;
              const ny = dy / dist;
              p1[0] -= nx * overlap;
              p1[1] -= ny * overlap;
              p2[0] += nx * overlap;
              p2[1] += ny * overlap;
              moved = true;
            }
          }
        }
        if (!moved) break; // Converged
      }

      // Calculate bounds
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      targetNodes.forEach(n => {
        const pos = positions[n.id];
        if (pos) {
          minX = Math.min(minX, pos[0]);
          maxX = Math.max(maxX, pos[0]);
          minY = Math.min(minY, pos[1]);
          maxY = Math.max(maxY, pos[1]);
        }
      });

      const padding = 200;  // Extra room for labels and edge of viewport
      const topPadding = 80; // Extra space at top for labels above nodes
      const width = Math.max(maxX - minX + padding * 2, 800);
      const height = Math.max(maxY - minY + padding * 2 + topPadding, 600);
      const offsetX = -minX + padding;
      const offsetY = -minY + padding + topPadding;

      let svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <!-- Arrow marker for call edges -->
    <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto" markerUnits="strokeWidth">
      <polygon points="0 0, 10 3.5, 0 7" fill="#a3ff5c"/>
    </marker>
    <marker id="arrowhead-gray" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto" markerUnits="strokeWidth">
      <polygon points="0 0, 10 3.5, 0 7" fill="#666666"/>
    </marker>
  </defs>
  <style>
    .node { stroke-width: 2; }
    .label { font-family: 'JetBrains Mono', 'Courier New', monospace; font-size: 12px; fill: #e8e8ea; }
    .edge { stroke: #666666; stroke-width: 1.5; opacity: 0.7; }
    .edge-call { stroke: #a3ff5c; stroke-width: 2; }
  </style>
  <rect width="100%" height="100%" fill="#0a0a0b"/>
`;

      // Draw edges with arrows
      targetLinks.forEach(l => {
        const from = positions[l.source];
        const to = positions[l.target];
        if (from && to) {
          const x1 = from[0] + offsetX;
          const y1 = from[1] + offsetY;
          const x2 = to[0] + offsetX;
          const y2 = to[1] + offsetY;

          // Calculate arrow endpoint (stop before the node radius)
          const dx = x2 - x1;
          const dy = y2 - y1;
          const len = Math.sqrt(dx * dx + dy * dy);
          const nodeRadius = 15;
          const arrowX2 = x2 - (dx / len) * nodeRadius;
          const arrowY2 = y2 - (dy / len) * nodeRadius;

          const isCall = l.type === 'call';
          const edgeClass = isCall ? 'edge edge-call' : 'edge';
          const markerId = isCall ? 'arrowhead' : 'arrowhead-gray';

          svgContent += `  <line class="${edgeClass}" x1="${x1}" y1="${y1}" x2="${arrowX2}" y2="${arrowY2}" marker-end="url(#${markerId})"/>
`;
        }
      });

      // Draw nodes (larger for visibility)
      targetNodes.forEach(n => {
        const pos = positions[n.id];
        if (!pos) return;
        const x = pos[0] + offsetX;
        const y = pos[1] + offsetY;
        const r = n.type === "root" ? 20 : n.type === "file" ? 15 : 12;
        const color = view === 'callers' ? '#a3ff5c' : (getNodeColor ? getNodeColor(n) : '#a3ff5c');

        // Add subtle glow effect
        svgContent += `  <circle cx="${x}" cy="${y}" r="${r + 3}" fill="${color}" opacity="0.2"/>
`;
        svgContent += `  <circle cx="${x}" cy="${y}" r="${r}" fill="${color}" class="node"/>
`;
        svgContent += `  <text class="label" x="${x}" y="${y - r - 8}" text-anchor="middle">${n.name || n.label}</text>
`;
      });

      svgContent += `</svg>`;

      const filename = view === 'callers' ? 'callgraph_export.svg' : 'graph_export.svg';

      try {
        const filePath = await save({
          filters: [{ name: "SVG", extensions: ["svg"] }],
          defaultPath: filename
        });
        if (filePath) {
          await writeTextFile(filePath, svgContent);
        }
      } catch {
        downloadFallback(filename, svgContent, 'image/svg+xml');
      }
    } catch (e) {
      alert("SVG export failed: " + e.message);
    }
    setShowExportMenu(false);
  };

  /**
   * Handles node click with shift key for multi-select.
   */
  const handleNodeClick = (e, node) => {
    e.stopPropagation();
    if (e.shiftKey) {
      // Toggle node in multi-selection
      setSelectedNodes(prev => {
        const next = new Set(prev);
        if (next.has(node.id)) {
          next.delete(node.id);
        } else {
          next.add(node.id);
        }
        return next;
      });
    } else {
      // Normal click - inspect and clear multi-selection
      setSelectedNodes(new Set());
      inspectNode(node);
    }
  };

  /**
   * Selects a node and streams AI analysis details token-by-token.
   * Uses the SSE streaming endpoint so the user sees the response being
   * written in real time instead of waiting for the full generation.
   */
  const inspectNode = async (node) => {
    // Cancel any in-flight stream from a previous selection
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    // Set selected immediately so the inspector renders without waiting
    // for a network fetch. /node-source is only called by openSource() on
    // explicit user action (Ctrl+1 / View Source). Do NOT pre-fetch here.
    setSelected(node);

    // File nodes don't get AI analysis — too large for context, use AI Chat.
    if (node.type === "file") {
      setDetails("SYSTEM: FILE NODE SELECTED.\n\nPress Ctrl+1 to view source, or Ctrl+2 to ask the AI Assistant about this file.");
      return;
    }
    // Note: file nodes exit early above.

    const isGithub = repoPath.startsWith("http") || repoPath.includes("github.com");
    const filePath = isGithub
      ? (node.id.split(':')[1] || node.label)
      : repoPath.replace(/\\/g, "/") + "/" + (node.id.split(':')[1] || node.label);

    setDetails("SCANNING...\n");
    if (["function", "class", "interface", "struct"].includes(node.type)) {
      try {
        const res = await fetch(`${API}/get-details`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            node_id: node.id,
            label: node.label,
            node_type: node.type,
            file_path: filePath,
            code: node.code
          }),
          signal: controller.signal
        });

        if (!res.ok) {
          setDetails("SCAN FAILED: server returned " + res.status);
          return;
        }

        // Consume the SSE stream — each event has {content}, {error}, or {done}
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let buffer = "";

        setDetails(""); // clear placeholder as first tokens arrive

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Stop processing if this stream was superseded
          if (controller.signal.aborted) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop(); // keep incomplete last line for next iteration

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.error) {
                setDetails(evt.error.includes("Ollama is not running")
                  ? "SYSTEM ERROR: OLLAMA_OFFLINE\n\nPlease ensure Ollama is running on your system."
                  : "SCAN FAILED: " + evt.error
                );
                return;
              }
              if (evt.content) {
                accumulated += evt.content;
                setDetails(accumulated);
              }
            } catch (_) {}
          }
        }
      } catch (e) {
        if (e.name === 'AbortError') return; // Silently drop cancelled requests
        setDetails("SCAN FAILED: " + (e.message || e));
      }
    }
  };

  /**
   * Fetches the reverse OR forward call graph for a specific node.
   * Updates the `callersGraphData` state for the specialized visualization.
   */
  const fetchCallersGraph = async (node, perspective = callPerspective, depth = null) => {
    if (!node) return;
    setCallersLoading(true);
    setCallersSourceFile(node.fileId);

    // If explicit depth provided, use it. Otherwise default to 2 (Rule 1).
    const targetDepth = depth || 2;
    setCallersDepth(targetDepth);
    setInspectorNode(node);

    // Clear previous graph immediately to show loading state
    setCallersGraphData(null);
    setExpandedSCCs(new Set());

    const endpoint = perspective === 'forward' ? `${API}/forward-call-flow` : `${API}/reverse-call-flow`;

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          function_id: node.id,
          maxDepth: targetDepth,
          maxNodes: 100
        })
      });
      const data = await res.json();

      if (data.error) {
        alert("Error fetching graph: " + data.error);
      } else {
        setCallersGraphData(data);
        setView("callers"); // Switch to callers view on success
      }
    } catch (e) {
      alert("Failed to fetch graph: " + e.message);
    }
    setCallersLoading(false);
  };

  // Reset callers graph when context changes
  useEffect(() => {
    if (callersGraphData && callersSourceFile) {
      // Check if we switched files
      const currentFile = selected?.id?.split(':')[1];
      if (currentFile && currentFile !== callersSourceFile) {
        setCallersGraphData(null);
        setCallersSourceFile(null);
        setView("map");
      }
    }
  }, [selected, callersGraphData, callersSourceFile]);

  // Auto-refresh call graph when the user switches Forward ↔ Reverse while in callers view
  useEffect(() => {
    if (view === 'callers' && inspectorNode) {
      fetchCallersGraph(inspectorNode, callPerspective);
    }
  }, [callPerspective]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape key: exit call graph view and return to main map
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && view === 'callers') {
        const currentSelected = selected;
        setView('map');
        setCallersGraphData(null);
        setCallersSourceFile(null);
        if (currentSelected) {
          setSelected(null);
          setTimeout(() => setSelected(currentSelected), 100);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [view, selected]); // eslint-disable-line react-hooks/exhaustive-deps



  const layout = useMemo(() => {
    const pos = {};
    const files = nodes.filter(n => n.type === "file");
    const phi = Math.PI * (3 - Math.sqrt(5));

    const baseRadius = 90;
    const scaleFactor = Math.max(1, Math.sqrt(files.length / 50));
    const radius = baseRadius * scaleFactor;

    nodes.forEach((n) => {
      if (n.type === "root") pos[n.id] = [0, 0, 0];
      else if (n.type === "file") {
        const idx = files.indexOf(n);
        const y = 1 - (idx / (files.length - 1 || 1)) * 2;
        const radiusAtY = Math.sqrt(1 - y * y);
        const theta = phi * idx;
        pos[n.id] = [Math.cos(theta) * radiusAtY * radius, y * radius, Math.sin(theta) * radiusAtY * radius];
      } else {
        const parentLink = links.find(l => l.target === n.id && l.type !== "call");
        const pPos = pos[parentLink?.source] || [0, 0, 0];
        const siblings = links.filter(l => l.source === parentLink?.source && l.type !== "call");
        const sIdx = siblings.findIndex(l => l.target === n.id);
        const baseRingRadius = 25;
        const ringRadius = (baseRingRadius + (siblings.length * 0.2)) * scaleFactor;
        const localAngle = (sIdx / (siblings.length || 1)) * Math.PI * 2;
        pos[n.id] = [pPos[0] + Math.cos(localAngle) * ringRadius, pPos[1], pPos[2] + Math.sin(localAngle) * ringRadius];
      }
    });
    return { positions: pos, sphereRadius: radius };
  }, [nodes, links]);

  const filteredNodes = useMemo(() => {
    const getExt = (node) => (node?.type === "file" ? node.label.split('.').pop().toLowerCase() : node?.id.split(':')[1]?.split('.').pop().toLowerCase() || "");
    const baseNodes = nodes.filter(n =>
      !hiddenLangs.has(getExt(n)) &&
      !hiddenTypes.has(n.type) &&
      n.label.toLowerCase().includes(search.toLowerCase())
    );

    if (!selected) {
      return baseNodes.filter(n => n.type === "file" || n.type === "root");
    }

    const childIds = new Set(links.filter(l => l.source === selected.id).map(l => l.target));
    return baseNodes.filter(n => n.id === selected.id || childIds.has(n.id));
  }, [nodes, selected, links, hiddenLangs, hiddenTypes, search]);

  const layoutPositions = layout.positions || {};
  const sphereRadius = layout.sphereRadius || 90;

  const filteredLinks = useMemo(() => {
    const visibleIds = new Set(filteredNodes.map(n => n.id));
    return links.filter(l => visibleIds.has(l.source) && visibleIds.has(l.target));
  }, [links, filteredNodes]);

  // ---------------------------------------------------------------------------
  // Colour palettes — must stay in sync with LANG_COLOURS / TYPE_COLOURS
  // in Sidebar.js. This is the single rendering source for the 3D graph.
  // ---------------------------------------------------------------------------
  const langMap = {
    // ── Web / JS ecosystem ────────────────────────────────────────────────
    py:    { label: 'PYTHON',      color: '#c2c2c2' },
    js:    { label: 'JS',          color: '#f7df1e' },
    jsx:   { label: 'REACT',       color: '#61dafb' },
    ts:    { label: 'TS',          color: '#007acc' },
    tsx:   { label: 'TS-REACT',    color: '#3178c6' },
    // ── Systems languages ─────────────────────────────────────────────────
    c:     { label: 'C',           color: '#a8b9cc' },
    h:     { label: 'C HEADER',    color: '#a8b9cc' },
    cpp:   { label: 'C++',         color: '#f34b7d' },
    hpp:   { label: 'C++ HEADER',  color: '#f34b7d' },
    java:  { label: 'JAVA',        color: '#b07219' },
    cs:    { label: 'C#',          color: '#178600' },
    rs:    { label: 'RUST',        color: '#dea584' },
    go:    { label: 'GO',          color: '#00ADD8' },
    // ── JVM / FP ──────────────────────────────────────────────────────────
    scala: { label: 'SCALA',       color: '#DC322F' },
    kt:    { label: 'KOTLIN',      color: '#7F52FF' },
    kts:   { label: 'KOTLIN SCR',  color: '#7F52FF' },
    // ── Scripting ─────────────────────────────────────────────────────────
    rb:    { label: 'RUBY',        color: '#CC342D' },
    php:   { label: 'PHP',         color: '#777BB4' },
    lua:   { label: 'LUA',         color: '#2C7EDE' },
    pl:    { label: 'PERL',        color: '#0298C3' },
    pm:    { label: 'PERL MOD',    color: '#0298C3' },
    r:     { label: 'R',           color: '#276DC3' },
    sh:    { label: 'SHELL',       color: '#89E051' },
    bash:  { label: 'BASH',        color: '#89E051' },
    // ── Mobile / modern ───────────────────────────────────────────────────
    swift: { label: 'SWIFT',       color: '#F05138' },
    dart:  { label: 'DART',        color: '#00B4AB' },
    // ── Functional / emerging ─────────────────────────────────────────────
    ex:    { label: 'ELIXIR',      color: '#6E4A7E' },
    exs:   { label: 'ELIXIR SCR',  color: '#6E4A7E' },
    zig:   { label: 'ZIG',         color: '#F7A41D' },
    // ── Notebooks ─────────────────────────────────────────────────────────
    ipynb: { label: 'JUPYTER',     color: '#F37726' },
  };

  const typeMap = {
    function:  { label: 'FUNCTIONS', color: '#DCDCAA' },  // VSCode golden yellow
    class:     { label: 'CLASSES',   color: '#4EC9B0' },  // VSCode teal
    interface: { label: 'CONTRACTS', color: '#C792EA' },  // soft purple
    struct:    { label: 'STRUCTS',   color: '#56B6C2' },  // steel cyan
    module:    { label: 'MODULES',   color: '#E5C07B' },  // warm amber
  };

  const presentLanguages = useMemo(() => {
    const exts = new Set();
    nodes.forEach(n => n.type === "file" && exts.add(n.label.split('.').pop().toLowerCase()));
    return Array.from(exts);
  }, [nodes]);

  const getNodeColor = (node) => {
    if (selected?.id === node.id) return "#00ff88";
    if (node.type === "root") return "#ff0000";
    if (node.type === "file") {
      const ext = node.label.split('.').pop().toLowerCase();
      return langMap[ext]?.color || "#ffffff";
    }
    return typeMap[node.type]?.color || "#888888";
  };

  // --- Startup Gates ---
  // Stable callbacks so installer useEffects don't re-fire on every App render
  const handleGitReady = useCallback(() => setGitReady(true), []);
  const handleOllamaReady = useCallback(() => setOllamaReady(true), []);

  // --- Persistence: load last workspace on mount ---
  useEffect(() => {
    const last = localStorage.getItem(LAST_WORKSPACE_KEY);
    if (last) {
      setRepoPath(last);
      // Trigger auto-scan after a short delay so the app is fully mounted
      setTimeout(() => triggerScan(last), 300);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // triggerScan: reusable scan logic (used by persistence, WelcomeScreen, etc.)
  const triggerScan = useCallback(async (path) => {
    if (!path) return;
    setLoading(true);
    setSelected(null);
    setSelectedNodes(new Set());
    setDetails('');
    setGitStatus({});
    setIsGitRepo(false);
    setView('map');
    const cleanPath = path.replace(/\\/g, '/');
    let endpoint = `${API}/map-repo?path=${encodeURIComponent(cleanPath)}`;
    if (path.startsWith('http') || path.includes('github.com')) {
      endpoint = `${API}/map-github?repo_url=${encodeURIComponent(path.trim())}`;
    }
    try {
      const res = await fetch(endpoint);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setNodes(data.nodes || []);
      setLinks(data.links || []);
      // Persist
      setRepoPath(path);
      localStorage.setItem(LAST_WORKSPACE_KEY, path);
      saveRecentWorkspace(path);
      // Git status
      if (!path.startsWith('http') && !path.includes('github.com')) {
        fetchGitStatus(cleanPath);
      }
    } catch (e) { alert('Error: ' + e.message); }
    setLoading(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Open-folder handler: launch Tauri dialog
  const handleOpenFolder = useCallback(async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: 'Open Repository Folder' });
      if (selected) {
        triggerScan(selected);
      }
    } catch (e) { console.error('Folder dialog failed:', e); }
  }, [triggerScan]);

  // Close workspace
  const handleCloseWorkspace = useCallback(async () => {
    setLoading(true);
    try {
      await fetch(`${API}/clear-cache`, { method: 'POST' });
    } catch { }
    setNodes([]);
    setLinks([]);
    setRepoPath('');
    setSelected(null);
    setDetails('');
    localStorage.removeItem(LAST_WORKSPACE_KEY);
    setView('map');
    setLoading(false);
  }, []);

  // 1. Git check (silent install if missing)
  if (!gitReady) {
    return <GitInstaller onReady={handleGitReady} />;
  }

  // 2. Ollama check (requires user consent)
  if (!ollamaReady) {
    return <OllamaInstaller onReady={handleOllamaReady} />;
  }

  const hasWorkspace = nodes.length > 0 || loading;

  return (
    <div className="app-shell">
      {/* Top VSCode-style menu bar */}
      <TopMenuBar
        hasWorkspace={hasWorkspace}
        workspaceName={workspaceName}
        onOpenFolder={handleOpenFolder}
        onOpenGithub={url => triggerScan(url)}
        onCloseWorkspace={handleCloseWorkspace}
        view={view}
        callPerspective={callPerspective}
        setCallPerspective={setCallPerspective}
        filterState={filterState}
        setFilterState={setFilterState}
        gitOverlayEnabled={gitOverlayEnabled}
        setGitOverlayEnabled={setGitOverlayEnabled}
        onExportJSON={exportJSON}
        onExportSVG={exportSVG}
        onOpenSettings={() => setView('settings')}
        onOpenAbout={() => setView('about')}
        nodes={nodes}
        selectedNodes={selectedNodes}
        loading={loading}
      />

      {/* App body: sidebar + canvas */}
      <div className="app-body">
        {/* Left sidebar — shown whenever a workspace is loaded */}
        {hasWorkspace && (
          <div style={{ position: 'relative', display: 'flex', flexShrink: 0, height: '100%' }}>
            <Sidebar
              nodes={nodes}
              selectedNodeId={selected?.id}
              onNodeSelect={node => {
                if (node === null) {
                  setSelected(null);
                  setDetails('');
                } else {
                  inspectNode(node);
                }
              }}
              workspaceName={workspaceName}
              collapsed={sidebarCollapsed}
              onToggleCollapse={() => setSidebarCollapsed(c => !c)}
              width={sidebarCollapsed ? undefined : leftWidth}
            />
            {/* Left resize handle — hidden when sidebar is collapsed */}
            {!sidebarCollapsed && (
              <div
                className="resize-handle resize-handle--left"
                onMouseDown={startLeftResize}
                title="Drag to resize"
              />
            )}
          </div>
        )}

        {/* Main content area */}
        <div className="app-main-area">
          <div className="app-canvas-area">
            {/* Loading bar + streaming progress label */}
          {loading && <div className="scan-loading-bar" />}
          {loading && scanProgress.phase && (
            <div style={{
              position: 'absolute', top: 6, left: '50%', transform: 'translateX(-50%)',
              fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)',
              background: 'var(--bg-primary)', padding: '2px 10px', borderRadius: 2,
              border: '1px solid var(--border-default)', zIndex: 600, whiteSpace: 'nowrap',
              pointerEvents: 'none'
            }}>
              {scanProgress.phase}
              {scanProgress.total > 0 && ` — ${scanProgress.files} / ${scanProgress.total} files`}
            </div>
          )}


          {/* Welcome screen — when no workspace loaded and not loading */}
          {!hasWorkspace && (
            <WelcomeScreen
              onOpenFolder={path => path ? triggerScan(path) : handleOpenFolder()}
              onOpenGithub={url => triggerScan(url)}
            />
          )}

          {/* --- Overlay Modals (Settings, About) --- */}
          {view === "settings" && (
            <div style={styles.overlay} onClick={() => setView("map")}>
              <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
                <div style={styles.modalHeader}>
                  <span style={styles.modalTitle}>SYSTEM CONFIGURATION</span>
                  <button style={styles.closeBtn} onClick={() => setView("map")}>✕</button>
                </div>

                <div style={styles.modalBody}>
                  <div style={styles.formGroup}>
                    <label style={styles.label}>OLLAMA HOST</label>
                    <input
                      style={styles.settingsInput}
                      value={config.ollamaHost}
                      onChange={e => {
                        const newC = { ...config, ollamaHost: e.target.value };
                        setConfig(newC);
                        updateBackendConfig(newC);
                      }}
                      onFocus={(e) => e.target.style.borderColor = 'var(--accent-primary)'}
                      onBlur={(e) => e.target.style.borderColor = 'var(--border-default)'}
                    />
                    <button
                      style={styles.btnTertiary}
                      onClick={startOllama}
                      onMouseEnter={(e) => e.target.style.borderColor = 'var(--accent-primary)'}
                      onMouseLeave={(e) => e.target.style.borderColor = 'var(--border-default)'}
                    >
                      Re-initialize Ollama
                    </button>
                  </div>

                  <div style={styles.formGroup}>
                    <label style={styles.label}>CUSTOM GIT PATH</label>
                    <input
                      style={styles.settingsInput}
                      placeholder="Auto-detecting..."
                      value={config.customGitPath}
                      onChange={e => {
                        const newC = { ...config, customGitPath: e.target.value };
                        setConfig(newC);
                        updateBackendConfig(newC);
                      }}
                      onFocus={(e) => e.target.style.borderColor = 'var(--accent-primary)'}
                      onBlur={(e) => e.target.style.borderColor = 'var(--border-default)'}
                    />
                  </div>

                  <div style={styles.formGroup}>
                    <label style={styles.label}>KEYBOARD SHORTCUTS</label>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px', gap: '8px', alignItems: 'center' }}>
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Forward Graph</span>
                      <input
                        style={{ ...styles.settingsInput, textAlign: 'center', padding: '4px' }}
                        value={keybinds.forward}
                        maxLength={1}
                        onChange={e => setKeybinds(prev => ({ ...prev, forward: e.target.value.toLowerCase() }))}
                      />
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Reverse Graph</span>
                      <input
                        style={{ ...styles.settingsInput, textAlign: 'center', padding: '4px' }}
                        value={keybinds.reverse}
                        maxLength={1}
                        onChange={e => setKeybinds(prev => ({ ...prev, reverse: e.target.value.toLowerCase() }))}
                      />
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Toggle SCC</span>
                      <input
                        style={{ ...styles.settingsInput, textAlign: 'center', padding: '4px' }}
                        value={keybinds.toggleSCC}
                        maxLength={1}
                        onChange={e => setKeybinds(prev => ({ ...prev, toggleSCC: e.target.value.toLowerCase() }))}
                      />
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Export Menu</span>
                      <input
                        style={{ ...styles.settingsInput, textAlign: 'center', padding: '4px' }}
                        value={keybinds.export}
                        maxLength={1}
                        onChange={e => setKeybinds(prev => ({ ...prev, export: e.target.value.toLowerCase() }))}
                      />
                    </div>
                  </div>

                  <div style={styles.formGroup}>
                    <label style={styles.label}>GRAPH CACHE</label>
                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 10px 0', lineHeight: 1.5 }}>
                      Delete all cached repository graphs from disk. The next scan will re-analyse from scratch.
                    </p>
                    <button
                      id="btn-clear-cache"
                      style={{
                        width: '100%', padding: '10px',
                        background: clearingCache ? '#555' : '#ff5555',
                        border: 'none', color: '#fff', fontFamily: 'var(--font-mono)',
                        fontSize: '12px', fontWeight: 600, letterSpacing: '0.05em',
                        cursor: clearingCache ? 'not-allowed' : 'pointer', borderRadius: 2
                      }}
                      disabled={clearingCache}
                      onClick={async () => {
                        setClearingCache(true);
                        try {
                          const res = await fetch(`${API}/clear-cache`, { method: 'DELETE' });
                          const data = await res.json();
                          alert(data.status === 'ok'
                            ? `Cache cleared — ${data.deleted} file(s) removed.`
                            : `Error: ${data.message}`);
                        } catch (e) { alert('Error: ' + e.message); }
                        setClearingCache(false);
                      }}
                    >
                      {clearingCache ? 'CLEARING...' : 'CLEAR GRAPH CACHE'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {view === "about" && (
            <div style={styles.overlay} onClick={() => setView("map")}>
              <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
                <div style={styles.modalHeader}>
                  <span style={styles.modalTitle}>ABOUT LOOM</span>
                  <button style={styles.closeBtn} onClick={() => setView("map")}>✕</button>
                </div>

                <div style={styles.modalBody}>
                  <p style={styles.aboutText}>
                    <strong>Loom</strong> - Code visualization and analysis tool<br />
                    Created by Dhruv Inamdar<br /><br />

                    <span style={styles.aboutSection}>LICENSING</span><br />
                    This distribution bundles Git for Windows, which is licensed under the GNU General Public License (GPL) v2.0. In accordance with the GPL v2.0, the source code for the bundled Git components is available at: https://github.com/git/git.
                    <br /><br />
                    Loom itself is licensed under the Apache License, Version 2.0. A copy of this license is included with this distribution.<br /><br />

                    <span style={styles.aboutSection}>DISCLAIMER</span><br />
                    Loom is provided "as is", without warranties of any kind. The user assumes all risks associated with its use. The author is not liable for any damages arising from its use.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* --- Main Graph View --- */}
          {view === "map" && hasWorkspace && (
            <>
              {/* Git Status Legend — only shown when git data is present */}
              {isGitRepo && Object.keys(gitStatus).length > 0 && (
                <div style={styles.gitLegend}>
                  <span style={styles.gitLegendTitle}>GIT STATUS</span>
                  <div style={styles.gitLegendItem}>
                    <span style={{ ...styles.gitLegendDot, background: '#f0ad4e' }}></span>
                    Modified
                  </div>
                  <div style={styles.gitLegendItem}>
                    <span style={{ ...styles.gitLegendDot, background: '#5cb85c' }}></span>
                    Added
                  </div>
                  <div style={styles.gitLegendItem}>
                    <span style={{ ...styles.gitLegendDot, background: '#888888', opacity: 0.45 }}></span>
                    Deleted
                  </div>
                </div>
              )}

              {/* Node Inspector Panel */}
              {view === "map" && selected && (
                inspectorCollapsed ? (
                  /* Slim right strip — click to restore */
                  <div style={{
                    position: 'absolute', right: 0, top: 0, height: '100%',
                    width: '28px',
                    background: 'var(--bg-tertiary)',
                    borderLeft: '1px solid var(--border-default)',
                    zIndex: 500,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    paddingTop: '12px',
                    cursor: 'pointer',
                    transition: 'background var(--transition-fast)'
                  }}
                    onClick={() => setInspectorCollapsed(false)}
                    title="Show Inspector"
                  >
                    <span style={{ color: 'var(--text-tertiary)', fontSize: 16, userSelect: 'none', lineHeight: 1 }}>‹</span>
                  </div>
                ) : (
                  <div style={{ ...styles.inspector, width: rightWidth }}>
                    {/* Right resize handle — drag left edge to resize */}
                    <div
                      className="resize-handle resize-handle--right"
                      onMouseDown={startRightResize}
                      title="Drag to resize"
                    />
                    <div style={styles.inspectorHeader}>
                      <span style={styles.inspectorTitle}>NODE INSPECTOR</span>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <button
                          title="Hide inspector"
                          style={styles.inspectorClose}
                          onClick={() => setInspectorCollapsed(true)}
                        >
                          ›
                        </button>
                        <button
                          style={styles.inspectorClose}
                          onClick={() => { setSelected(null); setInspectorCollapsed(false); }}
                          onMouseEnter={e => e.target.style.color = 'var(--accent-primary)'}
                          onMouseLeave={e => e.target.style.color = 'var(--text-tertiary)'}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                    <div style={styles.inspectorBody}>
                      <div style={styles.inspectorSection}>
                        <div style={styles.inspectorLabel}>TYPE</div>
                        <div style={styles.inspectorValue}>{selected.type}</div>
                      </div>

                      <div style={styles.inspectorSection}>
                        <div style={styles.inspectorLabel}>IDENTIFIER</div>
                        <div style={styles.inspectorValue}>{selected.label}</div>
                      </div>

                      <div style={styles.inspectorSection}>
                        <div style={styles.inspectorLabel}>ANALYSIS</div>
                        <div style={styles.inspectorDetails}>
                          <ReactMarkdown
                            components={{
                              // Paragraphs
                              p: ({node, ...props}) => <p style={{margin: '0 0 8px 0', lineHeight: 1.75}} {...props} />,
                              // Bold / italic
                              strong: ({node, ...props}) => <strong style={{color: 'var(--text-primary)', fontWeight: 600}} {...props} />,
                              em: ({node, ...props}) => <em style={{color: 'var(--accent-primary)', fontStyle: 'italic'}} {...props} />,
                              // Inline code — react-markdown v10: `code` is ALWAYS inline here
                              // Block code is wrapped in `pre` which we handle separately
                              code: ({node, ...props}) => (
                                <code style={{
                                  background: 'var(--bg-secondary)',
                                  border: '1px solid var(--border-subtle)',
                                  borderRadius: '3px',
                                  padding: '1px 5px',
                                  fontSize: '11px',
                                  fontFamily: 'monospace',
                                  color: 'var(--accent-secondary)',
                                  display: 'inline',
                                }} {...props} />
                              ),
                              // Fenced code blocks (``` ... ```)
                              pre: ({node, ...props}) => (
                                <pre style={{
                                  background: 'var(--bg-secondary)',
                                  border: '1px solid var(--border-subtle)',
                                  borderRadius: '4px',
                                  padding: '10px',
                                  fontSize: '11px',
                                  overflowX: 'auto',
                                  margin: '6px 0',
                                  lineHeight: 1.5,
                                  fontFamily: 'monospace',
                                  color: 'var(--text-tertiary)',
                                }} {...props} />
                              ),
                              // Headings
                              h1: ({node, ...props}) => <div style={{color: 'var(--text-primary)', fontWeight: 700, fontSize: '13px', marginBottom: '6px', marginTop: '12px', letterSpacing: '0.05em', textTransform: 'uppercase'}} {...props} />,
                              h2: ({node, ...props}) => <div style={{color: 'var(--text-primary)', fontWeight: 600, fontSize: '12px', marginBottom: '4px', marginTop: '10px'}} {...props} />,
                              h3: ({node, ...props}) => <div style={{color: 'var(--accent-primary)', fontWeight: 600, fontSize: '12px', marginBottom: '3px', marginTop: '8px'}} {...props} />,
                              // Lists
                              ul: ({node, ...props}) => <ul style={{paddingLeft: '16px', margin: '3px 0 8px 0'}} {...props} />,
                              ol: ({node, ...props}) => <ol style={{paddingLeft: '16px', margin: '3px 0 8px 0'}} {...props} />,
                              li: ({node, ...props}) => <li style={{marginBottom: '3px', lineHeight: 1.6}} {...props} />,
                              // Blockquote
                              blockquote: ({node, ...props}) => <blockquote style={{borderLeft: '2px solid var(--accent-primary)', margin: '6px 0', paddingLeft: '10px', color: 'var(--text-tertiary)', fontStyle: 'italic'}} {...props} />,
                              // Horizontal rule
                              hr: () => <hr style={{border: 'none', borderTop: '1px solid var(--border-subtle)', margin: '10px 0'}} />,
                            }}
                          >
                            {details}
                          </ReactMarkdown>
                        </div>
                      </div>


                      {/* Dock action buttons */}
                      <div style={{ ...styles.inspectorSection, display: 'flex', gap: '8px', marginTop: '4px' }}>
                        <button
                          style={{ ...styles.btnPrimary, flex: 1, padding: '8px', fontSize: '11px' }}
                          onClick={() => openSource(selected)}
                        >
                          ◫ View Source
                        </button>
                        {/* Ask AI only for code nodes — file nodes are too large for context */}
                        {['function', 'class', 'interface', 'struct', 'method', 'variable', 'constant'].includes(selected.type) && (
                          <button
                            style={{
                              ...styles.btnPrimary,
                              flex: 1,
                              padding: '8px',
                              fontSize: '11px',
                              background: 'transparent',
                              border: '1px solid var(--accent-primary)',
                              color: 'var(--accent-primary)',
                            }}
                            onClick={() => {
                              setDockTab('chat');
                              setDockOpen(true);
                            }}
                          >
                            ✦ Ask AI
                          </button>
                        )}
                      </div>

                      {["function", "class"].includes(selected.type) && (
                        <div style={styles.inspectorSection}>
                          <button
                            style={styles.btnPrimary}
                            onClick={() => fetchCallersGraph(selected)}
                            disabled={callersLoading}
                          >
                            {callersLoading ? "Loading..." : "⚡ View Call Graph"}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )
              )}



              <Canvas shadows onPointerMissed={(e) => { if (e.button !== 0) return; setSelected(null); setShowModeMenu(false); setShowExportMenu(false); setShowSettingsMenu(false); }} style={styles.canvas}>
                <CameraHandler selected={selected} layout={layoutPositions} sphereRadius={sphereRadius} focusSignal={cameraFocusSignal} dockOpen={dockOpen} />
                <PerspectiveCamera makeDefault position={[0, sphereRadius * 2, sphereRadius * 2.8]} fov={35} far={10000} />
                <ambientLight intensity={0.15} />
                <pointLight position={[20, 100, 20]} intensity={2.5} color="#a3ff5c" />
                {filteredNodes.map(n => {
                  const status = gitOverlayEnabled ? gitStatus[n.id] : null;
                  const isMultiSelected = selectedNodes.has(n.id);
                  const isDeleted = status === 'D';
                  const nodeColor = getNodeColor(n);

                  // Determine outline color based on git status (only if enabled)
                  let outlineColor = null;
                  if (gitOverlayEnabled && status === 'M') outlineColor = '#f0ad4e'; // Amber for modified
                  else if (gitOverlayEnabled && status === 'A') outlineColor = '#5cb85c'; // Green for added
                  else if (isMultiSelected) outlineColor = '#00ffff'; // Cyan for multi-selected

                  return layoutPositions[n.id] && (
                    <Float key={`${n.id}-${isMultiSelected}`} position={layoutPositions[n.id]} speed={2}>
                      {/* Outline ring for git status or selection */}
                      {outlineColor && (
                        <mesh>
                          <ringGeometry args={[
                            (n.type === "root" ? 3.5 : n.type === "file" ? 2.2 : 0.8) * 1.3,
                            (n.type === "root" ? 3.5 : n.type === "file" ? 2.2 : 0.8) * 1.5,
                            32
                          ]} />
                          <meshBasicMaterial color={outlineColor} transparent opacity={0.8} />
                        </mesh>
                      )}
                      {/* Main node sphere */}
                      <mesh onClick={(e) => handleNodeClick(e, n)}>
                        <sphereGeometry args={[n.type === "root" ? 3.5 : n.type === "file" ? 2.2 : 0.8]} />
                        <meshStandardMaterial
                          color={nodeColor}
                          emissive={nodeColor}
                          emissiveIntensity={selected?.id === n.id ? 3 : 1.5}
                          transparent={isDeleted}
                          opacity={isDeleted ? 0.45 : 1}
                        />
                      </mesh>
                      <Billboard position={[0, 4, 0]}>
                        <Text fontSize={0.8} color={isDeleted ? "#888888" : "#e8e8ea"} fillOpacity={isDeleted ? 0.45 : 1}>{n.label}</Text>
                      </Billboard>
                    </Float>
                  );
                })}
                {filteredLinks.map((l, i) => (
                  <Line
                    key={i}
                    points={[layoutPositions[l.source], layoutPositions[l.target]]}
                    color={l.type === 'call' ? '#a3ff5c' : '#3a3a3e'}
                    lineWidth={l.type === 'call' ? 1.5 : 0.4}
                    transparent
                    opacity={0.6}
                  />
                ))}
                <ContactShadows position={[0, -40, 0]} opacity={0.3} scale={200} blur={2.5} far={40} />
              </Canvas>
            </>
          )}

          {view === "callers" && callersGraphData && (
            <>
              <div style={styles.callersControls}>
                <button
                  onClick={() => {
                    const currentSelected = selected;
                    setView("map");
                    setCallersGraphData(null);
                    setCallersSourceFile(null);
                    if (currentSelected) {
                      setSelected(null);
                      setTimeout(() => setSelected(currentSelected), 100);
                    }
                  }}
                  style={styles.btnSecondary}
                >
                  ← Back
                </button>

                {/* Perspective badge */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '3px 10px',
                  background: callPerspective === 'forward' ? 'rgba(163,255,92,0.12)' : 'rgba(92,156,255,0.12)',
                  border: `1px solid ${callPerspective === 'forward' ? 'rgba(163,255,92,0.35)' : 'rgba(92,156,255,0.35)'}`,
                  borderRadius: 2, fontSize: '11px', fontFamily: 'var(--font-mono)',
                  fontWeight: 600,
                  color: callPerspective === 'forward' ? 'var(--accent-primary)' : '#5c9cff',
                  letterSpacing: '0.04em'
                }}>
                  {callPerspective === 'forward' ? '→ FORWARD' : '← REVERSE'}
                </div>

                <label style={styles.depthControl}>
                  Depth:
                  <input
                    type="number" min="1" max="10"
                    value={callersDepth}
                    onChange={(e) => setCallersDepth(parseInt(e.target.value) || 1)}
                    style={styles.depthInput}
                  />
                </label>
                <button
                  onClick={() => fetchCallersGraph(inspectorNode || selected, callPerspective, callersDepth)}
                  style={styles.btnPrimary}
                >
                  Refresh
                </button>

                <div style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-secondary)' }}>
                  {callersGraphData.metadata.nodeCount} nodes | {callersGraphData.metadata.edgeCount || 0} edges
                  {callersGraphData.metadata.truncated && ' | TRUNCATED'}
                  {callersGraphData.metadata.hasCycles && <span style={{ color: '#ff6b6b' }}> | ♻ CYCLES</span>}
                </div>
              </div>

              <Canvas shadows onPointerMissed={() => { }} style={styles.canvas}>
                <CameraControls makeDefault minDistance={10} maxDistance={500} />
                <PerspectiveCamera makeDefault position={[0, 50, 100]} fov={35} />
                <ambientLight intensity={0.15} />
                <pointLight position={[20, 100, 20]} intensity={2.5} color="#a3ff5c" />

                {/* Render callers graph nodes */}
                {(() => {
                  // Use memoized filtered data
                  if (!filteredGraph) return null;
                  const { nodes: filteredNodes } = filteredGraph;

                  // Group nodes by depth for horizontal spacing
                  const nodesByDepth = {};
                  filteredNodes.forEach(node => {
                    if (!nodesByDepth[node.depth]) nodesByDepth[node.depth] = [];
                    nodesByDepth[node.depth].push(node);
                  });

                  // Calculate positions: selected at top, callers below in rows
                  const nodePositions = {};
                  Object.keys(nodesByDepth).forEach(depth => {
                    const nodesAtDepth = nodesByDepth[depth];
                    const spacing = 25;
                    const startX = -((nodesAtDepth.length - 1) * spacing) / 2;
                    nodesAtDepth.forEach((node, idx) => {
                      nodePositions[node.id] = [
                        startX + idx * spacing,  // X: horizontal spread
                        0,                         // Y: flat
                        parseInt(depth) * 30       // Z: depth levels go back
                      ];
                    });
                  });

                  // Use filtered nodes for rendering
                  const visibleNodes = filteredNodes;

                  // Toggle SCC expansion
                  const toggleSCC = (sccId, memberCount) => {
                    if (memberCount > 10) {
                      // Large SCC - confirm first
                      if (!window.confirm(`This cycle has ${memberCount} functions. Show all?`)) return;
                    }
                    setExpandedSCCs(prev => {
                      const next = new Set(prev);
                      if (next.has(sccId)) next.delete(sccId);
                      else next.add(sccId);
                      return next;
                    });
                  };

                  // Truncate file path for display
                  const truncatePath = (path) => {
                    if (!path) return '';
                    const parts = path.replace(/\\/g, '/').split('/');
                    if (parts.length <= 2) return parts.join('/');
                    return '.../' + parts.slice(-2).join('/');
                  };

                  return visibleNodes.map((node) => {
                    const pos = nodePositions[node.id];
                    const isCenter = node.depth === 0;
                    const inCycle = node.inCycle;
                    const isExpanded = expandedSCCs.has(node.sccId);
                    const otherCount = (node.sccInfo?.memberCount || 1) - 1;

                    // Color: green for center, red for cycle, blue for normal
                    const nodeColor = isCenter ? "#00ff88" : (inCycle ? "#ff6b6b" : "#2492ce");

                    // Complexity Badge Logic
                    const showComplexityBadge = node.truncatedCalls || (node.totalCallees && node.totalCallees > 10);
                    const hiddenChildCount = node.totalCallees ? Math.max(0, node.totalCallees - (visibleNodes.filter(n => n.depth === node.depth + 1).length)) : 0;
                    const showBadge = showComplexityBadge || (callPerspective === 'forward' && hiddenChildCount > 0 && !isCenter);

                    return (
                      <Float key={node.id} position={pos} speed={2}>
                        <mesh onClick={(e) => { e.stopPropagation(); setInspectorNode(node); }}>
                          <sphereGeometry args={[isCenter ? 3 : 1.5]} />
                          <meshStandardMaterial
                            color={nodeColor}
                            emissive={nodeColor}
                            emissiveIntensity={isCenter ? 3 : (inCycle ? 2.5 : 1.5)}
                          />
                        </mesh>
                        <Billboard position={[0, 4, 0]}>
                          <Text fontSize={0.8} color="#e8e8ea">{node.name}</Text>
                        </Billboard>
                        {/* File origin label */}
                        <Billboard position={[0, 2.5, 0]}>
                          <Text fontSize={0.35} color="#888">{truncatePath(node.fileId)}</Text>
                        </Billboard>
                        {node.isEntryPoint && (
                          <Billboard position={[0, -4, 0]}>
                            <Text fontSize={0.6} color="#ff4444">ENTRY</Text>
                          </Billboard>
                        )}
                        {inCycle && !node.isEntryPoint && (
                          <Billboard position={[0, -4, 0]}>
                            <mesh
                              onClick={(e) => { e.stopPropagation(); toggleSCC(node.sccId, node.sccInfo?.memberCount || 0); }}
                              onPointerOver={() => setHoveredCycleNode(node.id)}
                              onPointerOut={() => setHoveredCycleNode(null)}
                            >
                              <planeGeometry args={[3, 1]} />
                              <meshBasicMaterial transparent opacity={0} />
                            </mesh>
                            <Text fontSize={0.5} color="#ff6b6b">
                              {isExpanded ? "♻ ▼" : `♻ +${otherCount}`}
                            </Text>
                            {hoveredCycleNode === node.id && !isExpanded && (
                              <Html center style={{ pointerEvents: 'none' }}>
                                <div style={{
                                  background: 'rgba(0,0,0,0.85)',
                                  color: '#fff',
                                  padding: '6px 10px',
                                  borderRadius: '4px',
                                  fontSize: '12px',
                                  whiteSpace: 'nowrap',
                                  transform: 'translateY(-30px)'
                                }}>
                                  Part of a larger cycle ({node.sccInfo?.memberCount || 0} functions). Click to expand.
                                </div>
                              </Html>
                            )}
                          </Billboard>
                        )}

                        {/* Complexity / More Badge */}
                        {!inCycle && showBadge && (
                          <Billboard position={[0, -3.5, 0]}>
                            <mesh onClick={(e) => {
                              e.stopPropagation();
                              // FIX: Sync main selection to avoid view reset
                              const mainNode = nodes.find(n => n.id === node.id);
                              setSelected(mainNode || null);

                              fetchCallersGraph(node, callPerspective);
                            }}>
                              <planeGeometry args={[4, 1.2]} />
                              <meshBasicMaterial color="#333" transparent opacity={0.8} />
                            </mesh>
                            <Text fontSize={0.45} color="#fff" position={[0, 0, 0.1]}>
                              {node.truncatedCalls ? `+${node.totalCallees} (Truncated)` : `+${hiddenChildCount} more`}
                            </Text>
                          </Billboard>
                        )}
                      </Float>
                    );
                  });
                })()}

                {/* Render directional edges (caller → callee) with arrow indication */}
                {(() => {
                  // Use memoized filtered data
                  if (!filteredGraph) return null;
                  const { nodes: filteredNodes, edges: filteredEdges } = filteredGraph;

                  // Recalculate positions for edges using filtered nodes
                  const nodesByDepth = {};
                  filteredNodes.forEach(node => {
                    if (!nodesByDepth[node.depth]) nodesByDepth[node.depth] = [];
                    nodesByDepth[node.depth].push(node);
                  });

                  const nodePositions = {};
                  Object.keys(nodesByDepth).forEach(depth => {
                    const nodesAtDepth = nodesByDepth[depth];
                    const spacing = 25;
                    const startX = -((nodesAtDepth.length - 1) * spacing) / 2;
                    nodesAtDepth.forEach((node, idx) => {
                      nodePositions[node.id] = [
                        startX + idx * spacing,
                        0,
                        parseInt(depth) * 30
                      ];
                    });
                  });

                  return filteredEdges.map((edge, i) => {
                    const callerPos = nodePositions[edge.caller];
                    const calleePos = nodePositions[edge.callee];
                    if (!callerPos || !calleePos) return null;

                    // Arrow goes from caller to callee (direction of call)
                    // Calculate direction vector and arrow position
                    const dx = calleePos[0] - callerPos[0];
                    const dz = calleePos[2] - callerPos[2];
                    const angle = Math.atan2(dx, dz);

                    // Position arrow 80% along the line (closer to callee)
                    const arrowPos = [
                      callerPos[0] + dx * 0.8,
                      0,
                      callerPos[2] + dz * 0.8
                    ];

                    // Cycle edges are red/orange, normal edges are green
                    const edgeColor = edge.isCycleEdge ? "#ff6b6b" : "#a3ff5c";

                    return (
                      <group key={i}>
                        <Line
                          points={[callerPos, calleePos]}
                          color={edgeColor}
                          lineWidth={edge.isCycleEdge ? 3 : 2}
                          transparent
                          opacity={edge.isCycleEdge ? 1 : 0.8}
                        />
                        {/* Arrow head pointing toward callee */}
                        <mesh
                          position={arrowPos}
                          rotation={[Math.PI / 2, 0, -angle]}
                        >
                          <coneGeometry args={[0.6, 2, 8]} />
                          <meshStandardMaterial color={edgeColor} emissive={edgeColor} emissiveIntensity={2} />
                        </mesh>
                      </group>
                    );
                  });
                })()}

                <ContactShadows position={[0, -20, 0]} opacity={0.3} scale={100} blur={2.5} far={40} />
              </Canvas>

              {/* Transparency Indicator */}
              {filteredGraph && (filteredGraph.hiddenStats.nodes > 0 || filteredGraph.hiddenStats.sccs > 0) && (
                <div style={styles.hiddenIndicator}>
                  ⚠
                  {filteredGraph.hiddenStats.nodes > 0 && ` ${filteredGraph.hiddenStats.nodes} nodes hidden`}
                  {filteredGraph.hiddenStats.sccs > 0 && ` | 🔁 ${filteredGraph.hiddenStats.sccs} SCCs collapsed`}
                  <button
                    onClick={() => setFilterState({ ...DEFAULT_FILTER_STATE, expandedSCCs: new Set() })}
                    style={{
                      background: 'transparent',
                      border: '1px solid #ffc107',
                      color: '#ffc107',
                      padding: '2px 8px',
                      fontSize: '10px',
                      cursor: 'pointer'
                    }}
                  >
                    Show all
                  </button>
                </div>
              )}

              {/* Node Inspector Panel */}
              {inspectorNode && (
                <div style={styles.inspectorPanel}>
                  <div style={styles.inspectorPanelHeader}>
                    <span style={styles.inspectorPanelTitle}>
                      {inspectorNode.type === 'class' ? '📦' : '⚡'} {inspectorNode.name}
                    </span>
                    <button
                      onClick={() => setInspectorNode(null)}
                      style={styles.inspectorCloseBtn}
                    >×</button>
                  </div>
                  <div style={styles.inspectorMeta}>
                    <span style={styles.inspectorMetaItem}>📁 {inspectorNode.fileId}</span>
                    <span style={styles.inspectorMetaItem}>📊 Depth: {inspectorNode.depth}</span>
                    {inspectorNode.inCycle && <span style={{ ...styles.inspectorMetaItem, color: '#ff6b6b' }}>♻ In Cycle</span>}
                  </div>
                  <div style={styles.inspectorActions}>
                    <button
                      onClick={() => {
                        // Navigate to main graph and focus on this node
                        const nodeId = inspectorNode.id;
                        const nodeName = inspectorNode.name;
                        setView("map");
                        setInspectorNode(null);
                        // Find the sorting node in main graph by ID (with delay for layout)
                        setTimeout(() => {
                          // Try exact ID match first
                          let mainNode = nodes.find(n => n.id === nodeId);
                          // Fallback: match by label/name and type
                          if (!mainNode) {
                            mainNode = nodes.find(n => n.label === nodeName && (n.type === "function" || n.type === "class"));
                          }
                          if (mainNode) {
                            setSelected(mainNode);
                            // Always increment signal so CameraHandler re-fires
                            // even if mainNode === previously selected node
                            setCameraFocusSignal(k => k + 1);
                          } else {
                            console.warn("Node not found in main graph:", nodeId, nodeName);
                          }
                        }, 150);
                      }}
                      style={styles.btnSecondary}
                    >
                      View in Main Graph →
                    </button>
                    <button
                      onClick={() => {
                        // FIX: Sync main selection to avoid view reset due to file context mismatch
                        const mainNode = nodes.find(n => n.id === inspectorNode.id);
                        setSelected(mainNode || null);

                        // Go deeper from this node
                        setInspectorNode(null);
                        fetchCallersGraph(inspectorNode, callPerspective);
                      }}
                      style={{ ...styles.btnPrimary, flex: 1 }}
                    >
                      Pivot to this Node ⚡
                    </button>
                  </div>
                  <div style={styles.inspectorCodeHeader}>SOURCE CODE</div>
                  <pre style={styles.inspectorCode}>
                    <code>{inspectorNode.code || '// No code available'}</code>
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
        
        {/* Bottom Dock component */}
        <BottomDock 
          dockOpen={dockOpen}
          setDockOpen={setDockOpen}
          dockHeight={dockHeight}
          dockTab={dockTab}
          setDockTab={setDockTab}
          openDocument={openDocument}
          setOpenDocument={setOpenDocument}
          chatMessages={chatMessages}
          setChatMessages={setChatMessages}
          chatInput={chatInput}
          setChatInput={setChatInput}
          chatLoading={chatLoading}
          sendChatMessage={sendChatMessage}
          chatContextNode={chatContextNode}
          setChatContextNode={setChatContextNode}
          selected={selected}
          startDockResize={startDockResize}
        />
        </div>
      </div>
    </div>
  );
}




const styles = {
  container: {
    width: '100vw',
    height: '100vh',
    background: 'var(--bg-primary)',
    fontFamily: 'var(--font-mono)',
    overflow: 'hidden',
    position: 'relative'
  },

  canvas: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%'
  },

  commandBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '48px',
    background: 'var(--bg-secondary)',
    borderBottom: `1px solid var(--border-default)`,
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    padding: '0 var(--space-lg)',
    gap: 'var(--space-xl)',
    boxSizing: 'border-box'
  },

  branding: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-sm)',
    cursor: 'pointer',
    transition: 'opacity var(--transition-fast)'
  },

  logoIcon: {
    width: '20px',
    height: '20px',
    objectFit: 'contain',
    opacity: 0.9
  },

  logoText: {
    fontSize: '12px',
    fontWeight: 600,
    letterSpacing: '0.15em',
    color: 'var(--text-secondary)',
    textTransform: 'uppercase'
  },

  tabNav: {
    display: 'flex',
    gap: 'var(--space-xs)',
    flex: 1
  },

  tab: {
    background: 'none',
    border: 'none',
    color: 'var(--text-tertiary)',
    padding: '8px 16px',
    cursor: 'pointer',
    fontSize: '13px',
    fontFamily: 'var(--font-mono)',
    transition: 'all var(--transition-fast)',
    borderBottom: '2px solid transparent',
    marginBottom: '-1px'
  },

  tabActive: {
    color: 'var(--text-primary)',
    borderBottomColor: 'var(--accent-primary)'
  },

  scanControls: {
    display: 'flex',
    gap: 'var(--space-sm)',
    alignItems: 'center'
  },

  pathInput: {
    background: 'var(--bg-tertiary)',
    border: `1px solid var(--border-default)`,
    color: 'var(--text-primary)',
    padding: '8px 12px',
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
    width: '320px',
    outline: 'none',
    transition: 'border-color var(--transition-fast)'
  },

  btnPrimary: {
    background: 'var(--accent-primary)',
    border: 'none',
    color: 'var(--bg-primary)',
    padding: '8px 20px',
    fontSize: '12px',
    fontWeight: 600,
    fontFamily: 'var(--font-mono)',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
    letterSpacing: '0.02em'
  },

  btnSecondary: {
    background: 'transparent',
    border: `1px solid var(--border-default)`,
    color: 'var(--text-secondary)',
    padding: '7px 16px',
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)'
  },

  btnTertiary: {
    background: 'transparent',
    border: `1px solid var(--border-default)`,
    color: 'var(--text-tertiary)',
    padding: '8px 12px',
    fontSize: '11px',
    fontFamily: 'var(--font-mono)',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
    marginTop: 'var(--space-sm)',
    width: '100%',
    textAlign: 'left'
  },

  controlStrip: {
    position: 'absolute',
    bottom: 'var(--space-lg)',
    left: 'var(--space-lg)',
    zIndex: 100,
    display: 'flex',
    gap: 'var(--space-md)',
    alignItems: 'center'
  },

  controlBtn: {
    background: 'var(--bg-tertiary)',
    border: `1px solid var(--border-emphasis)`,
    color: 'var(--text-secondary)',
    padding: '10px 16px',
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
    backdropFilter: 'blur(10px)'
  },

  searchInput: {
    background: 'var(--bg-tertiary)',
    border: `1px solid var(--border-emphasis)`,
    color: 'var(--text-primary)',
    padding: '10px 14px',
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
    width: '200px',
    outline: 'none',
    transition: 'border-color var(--transition-fast)',
    backdropFilter: 'blur(10px)'
  },

  filterPanel: {
    position: 'absolute',
    bottom: '52px',
    left: 0,
    width: '240px',
    background: 'var(--bg-tertiary)',
    border: `1px solid var(--border-emphasis)`,
    padding: 'var(--space-lg)',
    zIndex: 200,
    animation: 'slideDown 0.2s ease',
    backdropFilter: 'blur(10px)'
  },

  filterSection: {
    marginBottom: 'var(--space-sm)'
  },

  filterHeader: {
    fontSize: '10px',
    color: 'var(--text-tertiary)',
    letterSpacing: '0.1em',
    marginBottom: 'var(--space-sm)',
    fontWeight: 600,
    textTransform: 'uppercase'
  },

  filterItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 'var(--space-sm)',
    fontSize: '12px',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
    marginBottom: '2px'
  },

  inspector: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: '360px',
    height: '100%',
    background: 'var(--bg-tertiary)',
    borderLeft: `1px solid var(--border-default)`,
    zIndex: 500,
    display: 'flex',
    flexDirection: 'column',
    animation: 'slideInRight 0.25s ease'
  },

  inspectorHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 'var(--space-lg)',
    borderBottom: `1px solid var(--border-subtle)`
  },

  inspectorTitle: {
    fontSize: '10px',
    color: 'var(--text-tertiary)',
    letterSpacing: '0.1em',
    fontWeight: 600,
    textTransform: 'uppercase'
  },

  inspectorClose: {
    background: 'none',
    border: 'none',
    color: 'var(--text-tertiary)',
    fontSize: '18px',
    cursor: 'pointer',
    padding: 'var(--space-xs)',
    transition: 'color var(--transition-fast)'
  },

  inspectorBody: {
    flex: 1,
    overflowY: 'auto',
    padding: 'var(--space-lg)'
  },

  inspectorSection: {
    marginBottom: 'var(--space-xl)'
  },

  inspectorLabel: {
    fontSize: '10px',
    color: 'var(--text-tertiary)',
    letterSpacing: '0.1em',
    marginBottom: 'var(--space-sm)',
    fontWeight: 600,
    textTransform: 'uppercase'
  },

  inspectorValue: {
    fontSize: '14px',
    color: 'var(--text-primary)',
    lineHeight: 1.6
  },

  inspectorDetails: {
    fontSize: '13px',
    color: 'var(--text-secondary)',
    lineHeight: 1.7,
  },

  codeBlock: {
    background: 'var(--bg-secondary)',
    border: `1px solid var(--border-subtle)`,
    padding: 'var(--space-md)',
    fontSize: '11px',
    color: 'var(--text-tertiary)',
    lineHeight: 1.6,
    overflowX: 'auto',
    maxHeight: '300px',
    margin: 0
  },

  callersControls: {
    position: 'absolute',
    top: '12px',
    left: 'var(--space-lg)',
    zIndex: 100,
    display: 'flex',
    gap: 'var(--space-md)',
    alignItems: 'center',
    background: 'var(--bg-tertiary)',
    padding: 'var(--space-md)',
    border: '1px solid var(--border-emphasis)',
    backdropFilter: 'blur(10px)'
  },

  depthControl: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-sm)',
    fontSize: '11px',
    color: 'var(--text-secondary)'
  },

  depthInput: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-primary)',
    padding: '4px 8px',
    fontSize: '11px',
    width: '40px',
    fontFamily: 'var(--font-mono)'
  },

  callersTree: {
    marginTop: 'var(--space-md)'
  },

  callerNode: {
    padding: '8px',
    fontSize: '11px',
    color: 'var(--text-primary)',
    borderLeft: '2px solid var(--border-emphasis)',
    marginBottom: '4px',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-sm)'
  },

  depthBadge: {
    background: 'var(--accent-primary)',
    color: 'var(--bg-primary)',
    padding: '2px 6px',
    fontSize: '9px',
    fontWeight: 600,
    borderRadius: '2px'
  },

  entryPointBadge: {
    background: 'var(--error)',
    color: '#fff',
    padding: '2px 6px',
    fontSize: '9px',
    fontWeight: 600,
    borderRadius: '2px',
    marginLeft: 'auto'
  },

  warningBadge: {
    background: 'rgba(255, 193, 7, 0.1)',
    border: '1px solid rgba(255, 193, 7, 0.3)',
    color: '#ffc107',
    padding: '8px',
    fontSize: '11px',
    marginTop: 'var(--space-sm)',
    marginBottom: 'var(--space-md)'
  },

  errorMessage: {
    background: 'rgba(244, 67, 54, 0.1)',
    border: '1px solid rgba(244, 67, 54, 0.3)',
    color: '#f44336',
    padding: 'var(--space-md)',
    fontSize: '11px',
    lineHeight: 1.5
  },

  perspectiveToggle: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    fontSize: '10px',
    color: 'var(--text-secondary)',
    marginBottom: '0px'
  },

  radioLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    cursor: 'pointer',
    fontSize: '11px',
    color: 'var(--text-primary)'
  },

  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100vw',
    height: '100vh',
    background: 'rgba(10, 10, 11, 0.92)',
    zIndex: 1000,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    animation: 'fadeIn 0.2s ease'
  },

  modal: {
    width: '640px',
    maxHeight: '80vh',
    background: 'var(--bg-secondary)',
    border: `1px solid var(--border-emphasis)`,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column'
  },

  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 'var(--space-xl)',
    borderBottom: `1px solid var(--border-subtle)`
  },

  modalTitle: {
    fontSize: '10px',
    color: 'var(--accent-primary)',
    letterSpacing: '0.15em',
    fontWeight: 600,
    textTransform: 'uppercase'
  },

  closeBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-tertiary)',
    fontSize: '16px',
    cursor: 'pointer',
    padding: 'var(--space-xs)',
    transition: 'color var(--transition-fast)'
  },

  modalBody: {
    padding: 'var(--space-xl)',
    overflowY: 'auto',
    flex: 1
  },

  formGroup: {
    marginBottom: 'var(--space-xl)'
  },

  label: {
    display: 'block',
    fontSize: '10px',
    color: 'var(--text-tertiary)',
    letterSpacing: '0.1em',
    marginBottom: 'var(--space-sm)',
    fontWeight: 600,
    textTransform: 'uppercase'
  },

  settingsInput: {
    width: '100%',
    background: 'var(--bg-tertiary)',
    border: `1px solid var(--border-default)`,
    color: 'var(--text-primary)',
    padding: '12px',
    fontSize: '13px',
    fontFamily: 'var(--font-mono)',
    outline: 'none',
    transition: 'border-color var(--transition-fast)',
    boxSizing: 'border-box'
  },

  aboutText: {
    fontSize: '13px',
    color: 'var(--text-secondary)',
    lineHeight: 1.8,
    margin: 0
  },

  aboutSection: {
    fontSize: '10px',
    color: 'var(--accent-primary)',
    letterSpacing: '0.1em',
    fontWeight: 600,
    textTransform: 'uppercase',
    display: 'inline-block',
    marginTop: 'var(--space-md)'
  },

  link: {
    color: 'var(--accent-primary)',
    textDecoration: 'none',
    borderBottom: `1px solid transparent`,
    transition: 'border-color var(--transition-fast)'
  },

  // Inspector Panel (Callers Graph)
  inspectorPanel: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: '400px',
    height: '100%',
    background: 'var(--bg-tertiary)',
    borderLeft: `1px solid var(--border-default)`,
    zIndex: 600,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  },

  inspectorPanelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 'var(--space-md) var(--space-lg)',
    borderBottom: `1px solid var(--border-subtle)`,
    background: 'var(--bg-secondary)'
  },

  inspectorPanelTitle: {
    fontSize: '14px',
    color: 'var(--text-primary)',
    fontWeight: 600
  },

  inspectorCloseBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-tertiary)',
    fontSize: '20px',
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: 1
  },

  inspectorMeta: {
    padding: 'var(--space-md) var(--space-lg)',
    borderBottom: `1px solid var(--border-subtle)`,
    display: 'flex',
    flexWrap: 'wrap',
    gap: 'var(--space-md)'
  },

  inspectorMetaItem: {
    fontSize: '11px',
    color: 'var(--text-tertiary)'
  },

  inspectorActions: {
    padding: 'var(--space-md) var(--space-lg)',
    borderBottom: `1px solid var(--border-subtle)`
  },

  inspectorCodeHeader: {
    fontSize: '10px',
    color: 'var(--text-tertiary)',
    letterSpacing: '0.1em',
    fontWeight: 600,
    padding: 'var(--space-md) var(--space-lg)',
    borderBottom: `1px solid var(--border-subtle)`
  },

  inspectorCode: {
    flex: 1,
    overflow: 'auto',
    margin: 0,
    padding: 'var(--space-lg)',
    fontSize: '12px',
    lineHeight: 1.6,
    color: 'var(--text-secondary)',
    background: 'var(--bg-primary)',
    fontFamily: 'var(--font-mono)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word'
  },

  filterControls: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-md)',
    marginLeft: 'var(--space-lg)',
    padding: 'var(--space-xs) 0'
  },

  filterSelect: {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-primary)',
    padding: '4px 8px',
    fontSize: '11px',
    fontFamily: 'var(--font-mono)',
    cursor: 'pointer',
    outline: 'none'
  },

  filterCheckbox: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-xs)',
    fontSize: '11px',
    color: 'var(--text-secondary)',
    cursor: 'pointer'
  },

  hiddenIndicator: {
    position: 'absolute',
    bottom: 'var(--space-lg)',
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(255, 193, 7, 0.15)',
    border: '1px solid rgba(255, 193, 7, 0.3)',
    color: '#ffc107',
    padding: 'var(--space-sm) var(--space-lg)',
    fontSize: '11px',
    fontFamily: 'var(--font-mono)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-md)',
    zIndex: 100
  },

  // Export Dropdown Styles
  exportDropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    marginTop: '4px',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-emphasis)',
    minWidth: '160px',
    zIndex: 1000,
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)'
  },

  exportOption: {
    padding: '10px 14px',
    fontSize: '12px',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    fontFamily: 'var(--font-mono)',
    transition: 'background var(--transition-fast)'
  },

  exportHint: {
    padding: '8px 14px',
    fontSize: '10px',
    color: 'var(--text-tertiary)',
    borderTop: '1px solid var(--border-subtle)',
    fontStyle: 'italic'
  },

  // Git Status Legend Styles
  gitLegend: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginLeft: '16px',
    padding: '6px 12px',
    background: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid var(--border-subtle)',
    fontSize: '10px',
    color: 'var(--text-secondary)'
  },

  gitLegendTitle: {
    fontSize: '9px',
    color: 'var(--text-tertiary)',
    letterSpacing: '0.1em',
    fontWeight: 600,
    textTransform: 'uppercase'
  },

  gitLegendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    fontSize: '10px',
    color: 'var(--text-secondary)'
  },

  gitLegendDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    display: 'inline-block'
  },

  // Consolidated Dropdown Styles
  dropdownContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginLeft: 'auto'
  },

  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    marginTop: '4px',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-emphasis)',
    minWidth: '180px',
    zIndex: 1000,
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)'
  },

  dropdownSection: {
    padding: '8px 14px 4px',
    fontSize: '9px',
    color: 'var(--text-tertiary)',
    letterSpacing: '0.1em',
    fontWeight: 600,
    textTransform: 'uppercase'
  },

  dropdownOption: {
    padding: '10px 14px',
    fontSize: '12px',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    fontFamily: 'var(--font-mono)',
    transition: 'background var(--transition-fast)',
    ':hover': {
      background: 'var(--bg-tertiary)'
    }
  },

  dropdownOptionActive: {
    background: 'rgba(163, 255, 92, 0.1)',
    color: 'var(--accent-primary)'
  },

  dropdownDivider: {
    height: '1px',
    background: 'var(--border-subtle)',
    margin: '4px 0'
  },

  dropdownHint: {
    padding: '8px 14px',
    fontSize: '10px',
    color: 'var(--text-tertiary)',
    borderTop: '1px solid var(--border-subtle)',
    fontStyle: 'italic'
  }
};