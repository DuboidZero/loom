/**
 * Graph Filtering System
 * 
 * Implements the filter pipeline:
 * 1. SCC handling (collapse/hide/show/only)
 * 2. Utility filtering (at SCC level)
 * 3. Depth limiting
 * 4. Edge pruning
 */

/**
 * Groups nodes recursively by their Strongly Connected Component (SCC) ID.
 * 
 * @param {Array<Object>} nodes - The list of graph nodes.
 * @returns {Map<number, Array<Object>>} Map of sccId -> array of nodes.
 */
export function groupByScc(nodes) {
    const groups = new Map();
    nodes.forEach(node => {
        if (node.inCycle && node.sccId != null) {
            if (!groups.has(node.sccId)) {
                groups.set(node.sccId, []);
            }
            groups.get(node.sccId).push(node);
        }
    });
    return groups;
}

/**
 * Generates a consistent hash string based on member IDs.
 * Used to ensure summary nodes maintain stable IDs across renders.
 * 
 * @param {Array<Object>} members - Array of node objects in the SCC.
 * @returns {string} Base36 encoded hash string.
 */
function hashMemberIds(members) {
    const sorted = members.map(m => m.id).sort().join('|');
    let hash = 0;
    for (let i = 0; i < sorted.length; i++) {
        const char = sorted.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
}

/**
 * Creates a synthetic summary node representing a collapsed SCC.
 * 
 * @param {number} sccId - The ID of the component.
 * @param {Array<Object>} members - The members being collapsed.
 * @returns {Object} A new summary node object.
 */
export function createSccSummaryNode(sccId, members) {
    const stableId = `scc-summary:${hashMemberIds(members)}`;

    return {
        id: stableId,
        type: 'scc-summary',
        name: `♻ Cycle (${members.length})`,
        memberCount: members.length,
        memberNames: members.slice(0, 5).map(m => m.name),
        memberIds: members.map(m => m.id),
        sccId: sccId,
        depth: Math.min(...members.map(m => m.depth)),
        expandable: true,
        originalIds: new Set(members.map(m => m.id)),
        // Use first member's file for positioning
        fileId: members[0]?.fileId || ''
    };
}

/**
 * Rewrites graph edges to point to summary nodes instead of their original targets
 * when those targets are part of a collapsed SCC.
 * 
 * @param {Array<Object>} edges - The original edges.
 * @param {Array<Object>} nodes - The nodes (including new summary nodes).
 * @returns {Array<Object>} The edges with remapped source/targets.
 */
function remapEdgesToSummaryNodes(edges, nodes) {
    // Build lookup: original ID → summary node ID
    const idToSummary = new Map();
    nodes.forEach(n => {
        if (n.type === 'scc-summary' && n.originalIds) {
            n.originalIds.forEach(origId => {
                idToSummary.set(origId, n.id);
            });
        }
    });

    if (idToSummary.size === 0) return edges;

    // Remap edges
    let remapped = edges.map(edge => ({
        ...edge,
        caller: idToSummary.get(edge.caller) || edge.caller,
        callee: idToSummary.get(edge.callee) || edge.callee
    }));

    // Deduplicate
    const seen = new Set();
    remapped = remapped.filter(e => {
        const key = `${e.caller}→${e.callee}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // Remove self-loops
    remapped = remapped.filter(e => e.caller !== e.callee);

    return remapped;
}

/**
 * Main graph filtering pipeline.
 * Applies filters in a strict order:
 * 1. SCC Handling (Show/Hide/Collapse/Only)
 * 2. Utility Filtering (at SCC level)
 * 3. Depth Limiting
 * 4. Edge Pruning
 * 
 * @param {Array<Object>} truthNodes - The complete list of nodes from backend.
 * @param {Array<Object>} truthEdges - The complete list of edges.
 * @param {Object} filterState - Configuration for filters.
 * @param {string} filterState.cycleMode - 'show'|'hide'|'collapse'|'only'.
 * @param {number} filterState.maxSccSize - Threshold for collapsing SCCs.
 * @param {boolean} filterState.hideUtility - Whether to hide utility functions.
 * @param {number} filterState.utilityThreshold - Score threshold (0-1).
 * @param {number} filterState.maxDepth - Maximum call depth to show.
 * @param {Set} filterState.expandedSCCs - Set of manually expanded SCC IDs.
 * 
 * @returns {Object} { nodes, edges, hiddenStats }
 */
export function applyFilters(truthNodes, truthEdges, filterState) {
    let nodes = [...truthNodes];
    let edges = [...truthEdges];
    const hiddenStats = { nodes: 0, sccs: 0, utility: 0 };

    // ═══════════════════════════════════════════════════════
    // STEP 1: SCC HANDLING
    // ═══════════════════════════════════════════════════════

    const sccGroups = groupByScc(nodes);

    switch (filterState.cycleMode) {
        case 'hide':
            // Remove SCCs entirely — NO summary nodes
            const cycleNodeIds = new Set(
                nodes.filter(n => n.inCycle).map(n => n.id)
            );
            hiddenStats.sccs = sccGroups.size;
            hiddenStats.nodes += cycleNodeIds.size;
            nodes = nodes.filter(n => !n.inCycle);
            break;

        case 'collapse':
            // Replace large SCCs with summary nodes (respecting manual expansion)
            sccGroups.forEach((members, sccId) => {
                const shouldCollapse =
                    members.length > filterState.maxSccSize &&
                    !filterState.expandedSCCs.has(sccId);

                if (shouldCollapse) {
                    const memberIds = new Set(members.map(m => m.id));
                    nodes = nodes.filter(n => !memberIds.has(n.id));
                    nodes.push(createSccSummaryNode(sccId, members));
                    hiddenStats.sccs++;
                    hiddenStats.nodes += members.length;
                }
            });
            break;

        case 'only':
            // Keep only cycle nodes
            hiddenStats.nodes = nodes.filter(n => !n.inCycle).length;
            nodes = nodes.filter(n => n.inCycle);
            break;

        case 'show':
        default:
            // Show mode: by default show only representative node, expand on click
            // This preserves the old behavior before the filter system
            sccGroups.forEach((members, sccId) => {
                // If SCC not expanded, show only representative
                if (!filterState.expandedSCCs.has(sccId)) {
                    const memberIds = new Set(members.map(m => m.id));
                    // Keep only nodes that are NOT in this SCC, or ARE the representative
                    nodes = nodes.filter(n =>
                        !memberIds.has(n.id) || n.sccInfo?.isRepresentative === true
                    );
                }
            });
            break;
    }

    // ═══════════════════════════════════════════════════════
    // STEP 2: DEPTH LIMITING
    // ═══════════════════════════════════════════════════════

    if (filterState.maxDepth != null && filterState.maxDepth > 0) {
        const depthFiltered = nodes.filter(n => n.depth > filterState.maxDepth);
        hiddenStats.nodes += depthFiltered.length;
        nodes = nodes.filter(n => n.depth <= filterState.maxDepth);
    }

    // ═══════════════════════════════════════════════════════
    // STEP 3: EDGE PRUNING (both endpoints must exist)
    // ═══════════════════════════════════════════════════════

    const visibleIds = new Set(nodes.map(n => n.id));
    edges = edges.filter(
        e => visibleIds.has(e.caller) && visibleIds.has(e.callee)
    );

    // ═══════════════════════════════════════════════════════
    // STEP 4: REMAP EDGES FOR SUMMARY NODES
    // ═══════════════════════════════════════════════════════

    edges = remapEdgesToSummaryNodes(edges, nodes);

    return { nodes, edges, hiddenStats };
}

/**
 * Default filter state
 */
export const DEFAULT_FILTER_STATE = {
    cycleMode: 'show',
    maxSccSize: 5,
    maxDepth: 10,
    expandedSCCs: new Set()
};

/**
 * Filter presets
 */
export const FILTER_PRESETS = {
    readable: {
        cycleMode: 'collapse',
        hideUtility: true,
        maxSccSize: 5,
        maxDepth: 10
    },
    full: {
        cycleMode: 'show',
        hideUtility: false,
        maxSccSize: Infinity,
        maxDepth: Infinity
    },
    cyclesOnly: {
        cycleMode: 'only',
        hideUtility: false,
        maxSccSize: Infinity,
        maxDepth: Infinity
    },
    minimal: {
        cycleMode: 'hide',
        hideUtility: true,
        maxSccSize: 3,
        maxDepth: 5
    }
};
