/**
 * Sidebar Component
 *
 * VSCode-style Explorer sidebar. Renders a collapsible hierarchical tree:
 *   Source Files  → expandable containers (default collapsed)
 *     Classes     → expandable sub-groups
 *       Methods   → leaf items
 *     Functions   → leaf items (direct children of file)
 *
 * No physical directories are shown — files are the outermost level.
 * Also hosts: Search input + Language/Type Filter popover at the top.
 */
import React, { useState, useMemo, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Colour palettes — match App.js langMap and typeMap exactly
// ---------------------------------------------------------------------------
const LANG_COLOURS = {
  py:    '#c2c2c2',
  js:    '#f7df1e',
  jsx:   '#61dafb',
  ts:    '#007acc',
  tsx:   '#3178c6',
  cpp:   '#f34b7d',
  c:     '#a8b9cc',
  java:  '#b07219',
  cs:    '#178600',
  go:    '#00ADD8',
  rs:    '#dea584',
  ipynb: '#cccac8',
};

const TYPE_COLOURS = {
  function:  '#DCDCAA',  // VSCode soft yellow
  class:     '#4EC9B0',  // VSCode teal
  interface: '#C792EA',  // purple
  struct:    '#56B6C2',  // cyan
  module:    '#E5C07B',  // amber
};

// ---------------------------------------------------------------------------
// Tree building: files as outermost level, no directory grouping
// Returns:  [ { type:'file', name, fileNode, children:[...] }, ... ]
//   children: [ { type:'class', ...children:[{type:'symbol',...}] }, {type:'symbol',...}, ... ]
// ---------------------------------------------------------------------------
function buildTree(nodes) {
  const fileNodes = nodes.filter(n => n.type === 'file');
  const symbolNodes = nodes.filter(n =>
    ['function', 'class', 'interface', 'struct', 'module'].includes(n.type)
  );

  return fileNodes
    .map(fileNode => {
      // backend ID format: "file:relPath"
      const relPath = fileNode.id.replace(/^file:/, '');

      // Collect symbols belonging to this file
      const fileSymbols = symbolNodes.filter(sym => {
        const parts = sym.id.split(':');
        // ID format: "type:relPath:name"
        return parts.length >= 3 && parts.slice(1, -1).join(':') === relPath;
      });

      const classes   = fileSymbols.filter(s => s.type === 'class');
      const functions = fileSymbols.filter(s => s.type !== 'class');

      // Try to nest functions under their parent class (code-inclusion heuristic)
      const classItems = classes.map(cls => {
        const methods = functions.filter(fn =>
          cls.code && cls.code.includes(fn.label.replace(/\(\)$/, ''))
        );
        const standalone = functions.filter(fn =>
          !classes.some(c => c.code && c.code.includes(fn.label.replace(/\(\)$/, '')))
        );
        return {
          type: 'class',
          name: cls.label,
          node: cls,
          children: methods
            .sort((a, b) => a.label.localeCompare(b.label))
            .map(m => ({ type: 'symbol', name: m.label, node: m }))
        };
        void standalone; // unused here; handled below
      });

      // Standalone functions (not in any class)
      const nestedInClass = new Set(
        classes.flatMap(cls =>
          functions
            .filter(fn => cls.code && cls.code.includes(fn.label.replace(/\(\)$/, '')))
            .map(fn => fn.id)
        )
      );
      const standaloneSymbols = functions
        .filter(fn => !nestedInClass.has(fn.id))
        .sort((a, b) => a.label.localeCompare(b.label))
        .map(fn => ({ type: 'symbol', name: fn.label, node: fn }));

      const children = [
        ...classItems.sort((a, b) => a.name.localeCompare(b.name)),
        ...standaloneSymbols
      ];

      return {
        type: 'file',
        name: fileNode.label,
        path: relPath,
        fileNode,
        children
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Search match helper
// ---------------------------------------------------------------------------
function treeMatchesSearch(item, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  if (item.name?.toLowerCase().includes(q)) return true;
  if (item.type === 'file')  return item.children?.some(c => treeMatchesSearch(c, query));
  if (item.type === 'class') return item.children?.some(c => treeMatchesSearch(c, query));
  return false;
}

// ---------------------------------------------------------------------------
// SVG icon components
// ---------------------------------------------------------------------------
function ChevronRight({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M4.5 2.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronDown({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M2.5 4.5l3.5 4 3.5-4" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FileIcon({ ext }) {
  const color = LANG_COLOURS[ext] || '#858585';
  return (
    <svg width="13" height="14" viewBox="0 0 13 16" fill="none" style={{ flexShrink: 0 }}>
      <path d="M1 1.5A.5.5 0 0 1 1.5 1H8L12 5V14.5a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5v-13Z" fill={color} opacity="0.9" />
      <path d="M8 1l4 4H8V1Z" fill={color} opacity="0.5" />
    </svg>
  );
}

function ClassIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
      <rect x="1" y="2" width="12" height="10" rx="1" stroke={TYPE_COLOURS.class} strokeWidth="1.3" fill="none" />
      <line x1="1" y1="6" x2="13" y2="6" stroke={TYPE_COLOURS.class} strokeWidth="1" />
    </svg>
  );
}

function SymbolIcon({ type }) {
  const color = TYPE_COLOURS[type] || '#858585';
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="7" cy="7" r="3.5" stroke={color} strokeWidth="1.3" fill="none" />
      <circle cx="7" cy="7" r="1.2" fill={color} />
    </svg>
  );
}

function ExplorerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3 7h4l2-3h12" /><rect x="3" y="7" width="18" height="13" rx="1" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Tree item renderer
// ---------------------------------------------------------------------------
function TreeItem({ item, depth, selectedNodeId, onNodeSelect, search, filterLangs, filterTypes }) {
  // All items start collapsed
  const [expanded, setExpanded] = useState(false);
  const indent = depth * 12;

  if (item.type === 'file') {
    const ext = item.name.split('.').pop().toLowerCase();
    if (filterLangs.size > 0 && filterLangs.has(ext)) return null;

    const visibleChildren = search
      ? item.children?.filter(c => treeMatchesSearch(c, search))
      : item.children;

    if (search && !item.name.toLowerCase().includes(search.toLowerCase()) && !visibleChildren?.length) return null;

    const isSelected = selectedNodeId === item.fileNode?.id;

    return (
      <div>
        <div
          className={`tree-row tree-row--file${isSelected ? ' tree-row--active' : ''}`}
          style={{ paddingLeft: 8 + indent }}
          onClick={() => {
            if (isSelected && expanded) {
              // Second click: collapse and deselect
              setExpanded(false);
              onNodeSelect(null);
            } else {
              setExpanded(e => !e);
              if (item.fileNode) onNodeSelect(item.fileNode);
            }
          }}
        >
          <span className="tree-chevron">
            {item.children?.length > 0
              ? (expanded ? <ChevronDown /> : <ChevronRight />)
              : <span style={{ width: 12, display: 'inline-block' }} />}
          </span>
          <span className="tree-icon"><FileIcon ext={ext} /></span>
          <span className="tree-label">{item.name}</span>
          {item.children?.length > 0 && !expanded && (
            <span className="tree-badge">{item.children.length}</span>
          )}
        </div>
        {expanded && (visibleChildren || []).map((child, i) => (
          <TreeItem
            key={i} item={child} depth={depth + 1}
            selectedNodeId={selectedNodeId} onNodeSelect={onNodeSelect}
            search={search} filterLangs={filterLangs} filterTypes={filterTypes}
          />
        ))}
      </div>
    );
  }

  if (item.type === 'class') {
    if (filterTypes.has('class')) return null;
    if (search && !item.name.toLowerCase().includes(search.toLowerCase()) && !item.children?.some(c => treeMatchesSearch(c, search))) return null;

    const isSelected = selectedNodeId === item.node?.id;

    return (
      <div>
        <div
          className={`tree-row tree-row--class${isSelected ? ' tree-row--active' : ''}`}
          style={{ paddingLeft: 8 + indent }}
          onClick={() => {
            if (isSelected && expanded) {
              setExpanded(false);
              onNodeSelect(null);
            } else {
              setExpanded(e => !e);
              if (item.node) onNodeSelect(item.node);
            }
          }}
        >
          <span className="tree-chevron">
            {item.children?.length > 0
              ? (expanded ? <ChevronDown /> : <ChevronRight />)
              : <span style={{ width: 12, display: 'inline-block' }} />}
          </span>
          <span className="tree-icon"><ClassIcon /></span>
          <span className="tree-label tree-label--class">{item.name}</span>
        </div>
        {expanded && item.children?.map((child, i) => (
          <TreeItem
            key={i} item={child} depth={depth + 1}
            selectedNodeId={selectedNodeId} onNodeSelect={onNodeSelect}
            search={search} filterLangs={filterLangs} filterTypes={filterTypes}
          />
        ))}
      </div>
    );
  }

  // symbol (function / interface / struct / module)
  if (item.type === 'symbol') {
    const nodeType = item.node?.type || 'function';
    if (filterTypes.has(nodeType)) return null;
    if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return null;

    const isSelected = selectedNodeId === item.node?.id;

    return (
      <div
        className={`tree-row tree-row--symbol${isSelected ? ' tree-row--active' : ''}`}
        style={{ paddingLeft: 8 + indent + 12 }}
        onClick={() => item.node && onNodeSelect(item.node)}
      >
        <span className="tree-icon"><SymbolIcon type={nodeType} /></span>
        <span className={`tree-label tree-label--${nodeType}`}>{item.name}</span>
      </div>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main Sidebar
// ---------------------------------------------------------------------------
const ALL_LANGS  = ['py', 'js', 'jsx', 'ts', 'tsx', 'cpp', 'c', 'java', 'cs', 'go', 'rs', 'ipynb'];
const ALL_TYPES  = ['function', 'class', 'interface', 'struct', 'module'];

export default function Sidebar({ nodes, selectedNodeId, onNodeSelect, workspaceName, collapsed, onToggleCollapse }) {
  const [search, setSearch] = useState('');
  const [showFilter, setShowFilter] = useState(false);
  const [filterLangs, setFilterLangs] = useState(new Set());
  const [filterTypes, setFilterTypes] = useState(new Set());

  const tree = useMemo(() => buildTree(nodes), [nodes]);

  const toggleLang = useCallback(lang => {
    setFilterLangs(prev => { const n = new Set(prev); n.has(lang) ? n.delete(lang) : n.add(lang); return n; });
  }, []);

  const toggleType = useCallback(type => {
    setFilterTypes(prev => { const n = new Set(prev); n.has(type) ? n.delete(type) : n.add(type); return n; });
  }, []);

  const presentLangs = useMemo(() => {
    const exts = new Set();
    nodes.forEach(n => { if (n.type === 'file') exts.add(n.label.split('.').pop().toLowerCase()); });
    return Array.from(exts).filter(e => ALL_LANGS.includes(e));
  }, [nodes]);

  // --- Collapsed state: render slim icon strip ---
  if (collapsed) {
    return (
      <div className="sidebar sidebar--collapsed">
        <button
          className="sidebar-collapse-btn sidebar-collapse-btn--expand"
          onClick={onToggleCollapse}
          title="Show Explorer"
        >
          <ExplorerIcon />
        </button>
      </div>
    );
  }

  return (
    <div className="sidebar">
      {/* Header row: EXPLORER title + collapse button */}
      <div className="sidebar-explorer-header">
        <span className="sidebar-explorer-title">EXPLORER</span>
        <button
          className="sidebar-collapse-btn"
          onClick={onToggleCollapse}
          title="Collapse Explorer"
        >
          {/* «  chevrons-left */}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M9 3L5 7l4 4M5 3l-4 4 4 4" />
          </svg>
        </button>
      </div>

      {/* Workspace root label */}
      {workspaceName && (
        <div className="sidebar-workspace-row">
          <ChevronDown size={11} />
          <span className="sidebar-workspace-name">{workspaceName.toUpperCase()}</span>
        </div>
      )}

      {/* Search + Filter row */}
      <div className="sidebar-search-row">
        <div className="sidebar-search-container">
          <svg className="sidebar-search-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.099zm-5.242 1.656a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z" />
          </svg>
          <input
            className="sidebar-search-input"
            placeholder="Search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            id="sidebar-search"
          />
        </div>
        <button
          className={`sidebar-filter-btn${showFilter ? ' sidebar-filter-btn--active' : ''}${(filterLangs.size + filterTypes.size) > 0 ? ' sidebar-filter-btn--dirty' : ''}`}
          onClick={() => setShowFilter(f => !f)}
          title="Filter"
          id="sidebar-filter-toggle"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6 10.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5zm-2-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zm-2-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5z" />
          </svg>
          {(filterLangs.size + filterTypes.size) > 0 && (
            <span className="sidebar-filter-badge">{filterLangs.size + filterTypes.size}</span>
          )}
        </button>
      </div>

      {/* Filter popover */}
      {showFilter && (
        <div className="sidebar-filter-panel">
          {presentLangs.length > 0 && (
            <div className="sidebar-filter-section">
              <div className="sidebar-filter-section-title">LANGUAGES</div>
              {presentLangs.map(lang => (
                <label key={lang} className="sidebar-filter-item">
                  <input type="checkbox" checked={filterLangs.has(lang)} onChange={() => toggleLang(lang)} />
                  <span className="sidebar-filter-dot" style={{ background: LANG_COLOURS[lang] || '#858585' }} />
                  <span>{lang.toUpperCase()}</span>
                </label>
              ))}
            </div>
          )}
          <div className="sidebar-filter-section">
            <div className="sidebar-filter-section-title">SYMBOL TYPES</div>
            {ALL_TYPES.map(type => (
              <label key={type} className="sidebar-filter-item">
                <input type="checkbox" checked={filterTypes.has(type)} onChange={() => toggleType(type)} />
                <span className="sidebar-filter-dot" style={{ background: TYPE_COLOURS[type] || '#858585' }} />
                <span>{type.toUpperCase()}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Tree */}
      <div className="sidebar-tree" id="sidebar-tree">
        {tree.length === 0 && (
          <div className="sidebar-empty">No symbols found.</div>
        )}
        {tree.map((item, i) => (
          <TreeItem
            key={i} item={item} depth={0}
            selectedNodeId={selectedNodeId} onNodeSelect={onNodeSelect}
            search={search} filterLangs={filterLangs} filterTypes={filterTypes}
          />
        ))}
      </div>
    </div>
  );
}
