/**
 * IBS DIMAG Academic Family Tree
 * D3.js v7 — timeline (year-ordered) force layout
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────

const NODE_RADIUS = {
  current:       18,
  former:        14,
  ancestor:      9,
  ancestor_deep: 6,
  no_mgp:        14,
};

const NODE_COLOR = {
  current:       '#f5a800',   // amber-gold
  former:        '#18aa80',   // emerald teal
  ancestor:      '#5070c8',   // cobalt blue
  ancestor_deep: '#9aabcf',   // muted blue-gray
};

// Timeline world-space: year → X pixel (older = smaller X = left on screen)
const YEAR_MIN    = 1750;
const YEAR_MAX    = 2030;
const PX_PER_YEAR = 28;    // world pixels per year
const AXIS_HEIGHT = 40;    // top margin reserved for year axis (screen px)

function yearToWorld(year) {
  return (YEAR_MAX - (year || 2000)) * PX_PER_YEAR;
}

function labelFontSizeForZoom(k) {
  const lo = Math.max(7,  baseFontSize * 0.6);
  const hi = Math.max(30, baseFontSize * 2.5);
  return Math.max(lo, Math.min(hi, baseFontSize / k));
}

function labelIsVisibleForNode(n, k) {
  if (isFiltered) return true;
  if (n.dimag_status) return true;
  return k >= LABEL_HIDE_ZOOM;
}

function estimateLabelWorldWidth(n, k) {
  if (!labelIsVisibleForNode(n, k)) return 0;
  const fontSize = labelFontSizeForZoom(k);
  return Math.min(520, (n.name || '').length * fontSize * 0.58);
}

const LABEL_HIDE_ZOOM   = 0.22;  // below: hide non-DIMAG labels
const NODE_HIDE_ZOOM    = 0.12;  // below: hide deep ancestor nodes

// ── State ─────────────────────────────────────────────────────────────────

let allNodes   = [];
let allEdges   = [];
let members    = { current: [], former: [] };
let wikipediaUrls = {};  // mgp_id (string) → Wikipedia page URL

let visibleNodes = [];
let visibleEdges = [];

let simulation;
let activeFilter    = 'all';
let selectedNode    = null;
let currentTransform= d3.zoomIdentity;
let isFiltered      = false;   // true when double-click hide is active
let filteredNodeIds = null;    // ids kept by the active double-click lineage filter
let baseFontSize    = 12;      // user-controlled label font size (px)

// ── DOM refs ──────────────────────────────────────────────────────────────

const svg            = d3.select('#graph');
const yearAxisGroup  = svg.select('#year-axis');
const zoomLayer      = d3.select('#zoom-layer');
const gridLayer      = d3.select('#grid-layer');
const edgesLayer     = d3.select('#edges-layer');
const nodesLayer     = d3.select('#nodes-layer');
const labelsLayer    = d3.select('#labels-layer');
const tooltip        = document.getElementById('tooltip');
const sidebar        = document.getElementById('sidebar');
const sidebarContent = document.getElementById('sidebar-content');
const loadingEl      = document.getElementById('loading');
const noDataEl       = document.getElementById('no-data');
const searchInput    = document.getElementById('search-input');
const searchResults  = document.getElementById('search-results');
const fontSlider     = document.getElementById('font-slider');
const fontValue      = document.getElementById('font-value');
const resetBtn       = document.getElementById('reset-btn');
const yearScrollbar  = document.getElementById('year-scrollbar');

// Mobile refs
const mobileSearchBtn    = document.getElementById('mobile-search-btn');
const mobileSettingsBtn  = document.getElementById('mobile-settings-btn');
const mobileSearchBar    = document.getElementById('mobile-search-bar');
const mobileSearchInput  = document.getElementById('mobile-search-input');
const mobileSearchResults= document.getElementById('mobile-search-results');
const mobileSearchClose  = document.getElementById('mobile-search-close');
const mobileSheet        = document.getElementById('mobile-sheet');
const mobileOverlay      = document.getElementById('mobile-overlay');
const mobileSheetClose   = document.getElementById('mobile-sheet-close');
const mobileFontSlider   = document.getElementById('mobile-font-slider');
const mobileFontValue    = document.getElementById('mobile-font-value');
const mobileResetBtn     = document.getElementById('mobile-reset-btn');

// ── Zoom behavior ─────────────────────────────────────────────────────────

const zoom = d3.zoom()
  .scaleExtent([0.04, 10])
  .on('zoom', ({ transform }) => {
    currentTransform = transform;
    zoomLayer.attr('transform', transform);
    updateYearAxis(transform);
    updateLOD(transform.k);
    syncScrollbar(transform);
  })
  .on('end', () => {
    refreshLayoutForCurrentView();
  });

svg.call(zoom);

// ── Year scrollbar sync ───────────────────────────────────────────────────

function syncScrollbar(transform) {
  // Compute which year is at the horizontal center of the viewport
  const W = svg.node().clientWidth;
  const worldXCenter = (W / 2 - transform.x) / transform.k;
  const yearCenter   = YEAR_MAX - worldXCenter / PX_PER_YEAR;
  // Invert scrollbar value so thumb left = recent years (left on screen)
  yearScrollbar.value = Math.max(YEAR_MIN, Math.min(YEAR_MAX, YEAR_MIN + YEAR_MAX - yearCenter));
}

// Prevent ALL pointer events on the scrollbar from reaching the SVG
// (otherwise they can trigger pan/click handlers that wipe highlight state)
const _scrollWrap = document.getElementById('year-scroll-wrap');
['pointerdown','pointermove','pointerup','click','mousedown','mousemove','mouseup']
  .forEach(type => _scrollWrap.addEventListener(type, e => e.stopPropagation()));

yearScrollbar.addEventListener('input', () => {
  // Invert scrollbar value back to year (thumb left = recent = low scrollbar value)
  const year  = YEAR_MIN + YEAR_MAX - (+yearScrollbar.value);
  const W     = svg.node().clientWidth;
  const k     = currentTransform.k;
  const newTx = W / 2 - k * yearToWorld(year);

  // Build new transform directly — do NOT go through svg.call(zoom.transform)
  // because that fires the zoom event which triggers updateLOD and other handlers
  // that conflict with the hide/highlight state.
  currentTransform = d3.zoomIdentity.translate(newTx, currentTransform.y).scale(k);

  // Apply visuals manually
  zoomLayer.attr('transform', currentTransform);
  updateYearAxis(currentTransform);

  // Sync D3 zoom's internal state so wheel/drag zoom starts from correct position
  svg.node().__zoom = currentTransform;
});

// ── Year axis (fixed, not inside zoom layer) ──────────────────────────────

// Horizontal axis line
yearAxisGroup.append('line')
  .attr('id', 'axis-line')
  .attr('y1', AXIS_HEIGHT - 1).attr('y2', AXIS_HEIGHT - 1)
  .attr('stroke', '#2a3550')
  .attr('stroke-width', 1);

function updateYearAxis(transform) {
  const svgWidth = svg.node().clientWidth;

  // Update axis line width
  yearAxisGroup.select('#axis-line')
    .attr('x1', 0).attr('x2', svgWidth);

  // Determine visible year range from horizontal transform
  const worldXLeft  = (0        - transform.x) / transform.k;
  const worldXRight = (svgWidth - transform.x) / transform.k;
  const yearLeft  = YEAR_MIN + worldXLeft  / PX_PER_YEAR;
  const yearRight = YEAR_MIN + worldXRight / PX_PER_YEAR;

  // Choose tick interval based on zoom
  let interval;
  if      (transform.k > 2.0)  interval = 5;
  else if (transform.k > 0.8)  interval = 10;
  else if (transform.k > 0.3)  interval = 25;
  else if (transform.k > 0.12) interval = 50;
  else                          interval = 100;

  const startYear = Math.ceil(yearLeft / interval) * interval;
  const ticks = [];
  for (let y = startYear; y <= Math.min(yearRight, YEAR_MAX); y += interval) {
    if (y >= YEAR_MIN) ticks.push(y);
  }

  const sel = yearAxisGroup.selectAll('g.x-tick').data(ticks, d => d);
  sel.exit().remove();

  const enter = sel.enter().append('g').attr('class', 'x-tick');
  enter.append('line')
    .attr('y1', AXIS_HEIGHT - 8).attr('y2', AXIS_HEIGHT - 1)
    .attr('stroke', '#2a3550').attr('stroke-width', 1);
  enter.append('text')
    .attr('y', AXIS_HEIGHT - 12)
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'auto')
    .attr('font-size', '13px')
    .attr('font-family', 'Inter, system-ui, sans-serif')
    .attr('fill', '#6a7fa8');

  const all = sel.merge(enter);
  all.attr('transform', d => {
    const screenX = transform.k * yearToWorld(d) + transform.x;
    return `translate(${screenX}, 0)`;
  });
  all.select('text').text(d => d);
}

// ── Grid lines (inside zoom layer, move with graph) ───────────────────────

function buildGridLines() {
  const decades = d3.range(
    Math.ceil(YEAR_MIN / 10) * 10,
    YEAR_MAX + 1,
    10
  );
  const H = 60000; // very tall so always visible when panning vertically
  gridLayer.selectAll('line.grid').data(decades)
    .join('line')
    .attr('class', 'grid')
    .attr('x1', d => yearToWorld(d)).attr('x2', d => yearToWorld(d))
    .attr('y1', -H / 2).attr('y2', H / 2)
    .attr('stroke', d => d % 100 === 0 ? '#2a3550' : '#1c2333')
    .attr('stroke-width', d => d % 100 === 0 ? 1 : 0.5)
    .attr('opacity', 0.6);
}

// ── Load Data ─────────────────────────────────────────────────────────────

async function loadData() {
  try {
    const [genealogyRes, membersRes, wikiRes] = await Promise.all([
      fetch('data/genealogy.json'),
      fetch('data/members.json'),
      fetch('data/wikipedia_urls.json'),
    ]);

    if (!genealogyRes.ok) throw new Error('genealogy.json not found');

    const genealogy = await genealogyRes.json();
    members = await membersRes.json();
    if (wikiRes.ok) wikipediaUrls = await wikiRes.json();

    allNodes = genealogy.nodes || [];
    allEdges = genealogy.edges || [];

    buildLookups();
    estimateMissingYears();
    updateScrollbarRange();
    loadingEl.classList.add('hidden');
    init();
  } catch (err) {
    console.error('Failed to load data:', err);
    loadingEl.classList.add('hidden');

    if (err.message.includes('genealogy.json') || err instanceof TypeError) {
      try {
        const membersRes = await fetch('data/members.json');
        members = await membersRes.json();
        allNodes = buildNodesFromMembers(members);
        allEdges = [];
        buildLookups();
        estimateMissingYears();
        updateScrollbarRange();
        loadingEl.classList.add('hidden');
        init();
      } catch {
        noDataEl.classList.remove('hidden');
      }
    } else {
      noDataEl.classList.remove('hidden');
    }
  }
}

function buildNodesFromMembers(mem) {
  const nodes = [];
  for (const m of mem.current) {
    nodes.push({ id: m.mgp_id || `no-mgp-${m.name}`, name: m.name,
      dimag_status: 'current', mgp_id: m.mgp_id, advisors: [], students: [] });
  }
  for (const m of mem.former) {
    nodes.push({ id: m.mgp_id || `no-mgp-${m.name}`, name: m.name,
      dimag_status: 'former', mgp_id: m.mgp_id, advisors: [], students: [] });
  }
  return nodes;
}

// ── Lookup maps ───────────────────────────────────────────────────────────

let nodeById = new Map();
let depthMap = new Map();  // id → generations from nearest DIMAG member (0 = DIMAG)

function buildLookups() {
  nodeById.clear();
  for (const n of allNodes) {
    // Numeric id IS the MGP id — expose it as mgp_id for photo lookups
    if (typeof n.id === 'number') n.mgp_id = n.id;
    const info = findMemberInfo(n.id);
    if (info) {
      n.dimag_status = info.status;
      n.role         = info.role;
      n.name_kr      = info.name_kr;
      n.url          = info.url;
      if (!n.name) n.name = info.name;
    }
    nodeById.set(n.id, n);
  }

  // BFS upward from DIMAG seeds to assign ancestor depth
  depthMap.clear();
  const advisorOf = new Map();
  for (const n of allNodes) advisorOf.set(n.id, n.advisors || []);

  const queue = [];
  for (const n of allNodes) {
    if (n.dimag_status) { depthMap.set(n.id, 0); queue.push(n.id); }
  }
  let qi = 0;
  while (qi < queue.length) {
    const id = queue[qi++];
    const d  = depthMap.get(id);
    for (const aid of (advisorOf.get(id) || [])) {
      if (!depthMap.has(aid)) { depthMap.set(aid, d + 1); queue.push(aid); }
    }
  }
}

function findMemberInfo(mgpId) {
  for (const m of members.current) if (m.mgp_id === mgpId) return { ...m, status: 'current' };
  for (const m of members.former)  if (m.mgp_id === mgpId) return { ...m, status: 'former' };
  return null;
}

// Set scrollbar min/max to match actual data range so the thumb reaches both ends
function updateScrollbarRange() {
  const years = allNodes.map(n => n.year).filter(Boolean);
  if (!years.length) return;
  const dataMin = Math.min(...years);
  const dataMax = Math.max(...years);
  const pad = 10; // years of padding beyond the data at each end
  // scrollbar.value = (YEAR_MIN + YEAR_MAX) - yearCenter, so:
  //   min value → newest year (dataMax + pad)
  //   max value → oldest year (dataMin - pad)
  yearScrollbar.min = Math.floor((YEAR_MIN + YEAR_MAX) - (dataMax + pad));
  yearScrollbar.max = Math.ceil( (YEAR_MIN + YEAR_MAX) - (dataMin - pad));
}

// Estimate missing years from neighbor years.
// Uses a snapshot of known years at the start of each pass so that
// within-pass estimates never feed into other estimates in the same pass.
// This prevents cascading errors through long chains of no-year nodes.
function estimateMissingYears() {
  const MAX_PASSES = 5;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const snapshot = new Map(allNodes.map(n => [n.id, n.year]));
    let anyChange = false;
    for (const n of allNodes) {
      if (n.year) continue;
      const studentYears = (n.students || [])
        .map(id => snapshot.get(id)).filter(Boolean);
      if (studentYears.length) {
        n.year = Math.min(...studentYears) - 8;
        n.yearEstimated = true;
        anyChange = true;
        continue;
      }
      const advisorYears = (n.advisors || [])
        .map(id => snapshot.get(id)).filter(Boolean);
      if (advisorYears.length) {
        n.year = Math.max(...advisorYears) + 8;
        n.yearEstimated = true;
        anyChange = true;
      }
    }
    if (!anyChange) break;
  }
}

// ── Depth filtering ───────────────────────────────────────────────────────

function getVisibleNodes(depth, filter) {
  return allNodes.filter(n => {
    if (filter === 'current' && n.dimag_status !== 'current') return false;
    if (filter === 'former'  && n.dimag_status !== 'former')  return false;
    if (filter === 'dimag'   && !n.dimag_status)              return false;
    return (depthMap.get(n.id) ?? Infinity) <= depth;
  });
}

function getVisibleEdges(visSet) {
  return allEdges.filter(e => {
    const s = typeof e.source === 'object' ? e.source.id : e.source;
    const t = typeof e.target === 'object' ? e.target.id : e.target;
    return visSet.has(s) && visSet.has(t);
  });
}

function collectLineageNodeIds(rootId) {
  const keep = new Set([rootId]);

  // BFS upward — all ancestors
  const upQ = [rootId];
  while (upQ.length) {
    const id = upQ.pop();
    for (const aid of (nodeById.get(id)?.advisors || [])) {
      if (!keep.has(aid)) {
        keep.add(aid);
        upQ.push(aid);
      }
    }
  }

  // BFS downward — all descendants
  const downQ = [rootId];
  const seenD = new Set([rootId]);
  while (downQ.length) {
    const id = downQ.pop();
    for (const sid of (nodeById.get(id)?.students || [])) {
      if (!seenD.has(sid)) {
        seenD.add(sid);
        keep.add(sid);
        downQ.push(sid);
      }
    }
  }

  return keep;
}

function buildAncestryChain(d) {
  const ancestors = [];
  const visited = new Set([d.id]);
  const queue = [d.id];
  while (queue.length) {
    const id = queue.shift();
    const node = nodeById.get(id);
    for (const aid of (node?.advisors || [])) {
      if (!visited.has(aid)) {
        visited.add(aid);
        const a = nodeById.get(aid);
        if (a) { ancestors.push(a); queue.push(aid); }
      }
    }
  }
  return ancestors.sort((a, b) => (a.year || 9999) - (b.year || 9999));
}

// ── Node visual helpers ───────────────────────────────────────────────────

function nodeRadius(n) {
  if (!n.mgp_id && n.dimag_status) return NODE_RADIUS.no_mgp;
  if (n.dimag_status === 'current') return NODE_RADIUS.current;
  if (n.dimag_status === 'former')  return NODE_RADIUS.former;
  const d = depthMap.get(n.id) ?? 99;
  return d <= 3 ? NODE_RADIUS.ancestor : NODE_RADIUS.ancestor_deep;
}

function pillHeight(n) {
  // Height scales with baseFontSize; minimum sizes preserve visual hierarchy
  const fs = baseFontSize;
  if (n.dimag_status === 'current') return Math.max(30, fs + 14);
  if (n.dimag_status === 'former')  return Math.max(26, fs + 12);
  return Math.max(18, fs + 8);  // all ancestors
}

function isPillNode(n) { return true; }  // all nodes are pill-shaped

function pillWidth(n) {
  const h = pillHeight(n);
  // Reserve photo slot for any pill node that has an mgp_id
  const photoSlot = n.mgp_id ? (h - 4 + 8) : 0;  // circle diameter + gap
  const textW     = (n.name || '').length * baseFontSize * 0.56;
  const pad = 12;
  return Math.max(h * 2.5, photoSlot + textW + pad * 2);
}

function nodeCollisionRadius(n, k) {
  const h = pillHeight(n), w = pillWidth(n);
  return Math.sqrt((w / 2) ** 2 + (h / 2) ** 2) + 6;
}

function layoutLinkDistance(k) {
  return 60 + Math.min(110, labelFontSizeForZoom(k) * 2.2);
}

function layoutChargeStrength(k) {
  return -250 - Math.min(260, labelFontSizeForZoom(k) * 11);
}

function nodeColor(n) {
  if (n.dimag_status === 'current') return NODE_COLOR.current;
  if (n.dimag_status === 'former')  return NODE_COLOR.former;
  const d = depthMap.get(n.id) ?? 99;
  return d <= 3 ? NODE_COLOR.ancestor : NODE_COLOR.ancestor_deep;
}

function nodeGlow(n) {
  if (n.dimag_status === 'current') return 'url(#glow-current)';
  if (n.dimag_status === 'former')  return 'url(#glow-former)';
  return 'none';
}

function edgeClass(e) {
  const sid = typeof e.source === 'object' ? e.source.id : e.source;
  const tid = typeof e.target === 'object' ? e.target.id : e.target;
  const sn = nodeById.get(sid), tn = nodeById.get(tid);
  if (sn?.dimag_status || tn?.dimag_status) return 'edge hi';
  const d = Math.max(depthMap.get(sid) ?? 99, depthMap.get(tid) ?? 99);
  return d <= 3 ? 'edge mid' : 'edge lo';
}

// ── Init ──────────────────────────────────────────────────────────────────

function init() {
  buildGridLines();
  applyFilter(activeFilter);

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      render();
    });
  });

  fontSlider.addEventListener('input', () => {
    baseFontSize = +fontSlider.value;
    fontValue.textContent = baseFontSize;
    // Re-render recalculates all pill geometry (height/width/font depend on baseFontSize)
    render();
  });

  resetBtn.addEventListener('click', resetView);
  document.getElementById('sidebar-close').addEventListener('click', closeSidebar);
  setupSearch();
  setupMobile();
  syncScrollbar(currentTransform);
}

function applyFilter(filter) {
  activeFilter = filter;
  render();
}

// ── Render ────────────────────────────────────────────────────────────────

function render() {
  visibleNodes = getVisibleNodes(Infinity, activeFilter);
  if (isFiltered && filteredNodeIds) {
    visibleNodes = visibleNodes.filter(n => filteredNodeIds.has(n.id));
  }
  const visSet = new Set(visibleNodes.map(n => n.id));
  visibleEdges = getVisibleEdges(visSet);
  renderGraph();
}

let linkSel, nodeSel, labelSel;

function refreshLayoutForCurrentView() {
  if (!simulation) return;
  const k = currentTransform.k || 1;

  simulation
    .force('link', d3.forceLink(visibleEdges)
      .id(d => d.id)
      .distance(() => layoutLinkDistance(k))
      .strength(0.16)
    )
    .force('charge', d3.forceManyBody().strength(layoutChargeStrength(k)))
    .force('collision', d3.forceCollide().radius(d => nodeCollisionRadius(d, k)).strength(1.0));

  simulation.alphaTarget(0.16).restart();
  clearTimeout(refreshLayoutForCurrentView._timer);
  refreshLayoutForCurrentView._timer = setTimeout(() => {
    simulation?.alphaTarget(0);
  }, 260);
}

function renderGraph() {
  const width  = svg.node().clientWidth;
  const k      = currentTransform.k || 1;

  // ── Edges ──────────────────────────────────────────────────────────────
  linkSel = edgesLayer.selectAll('path.edge')
    .data(visibleEdges, d => {
      const s = typeof d.source === 'object' ? d.source.id : d.source;
      const t = typeof d.target === 'object' ? d.target.id : d.target;
      return `${s}-${t}`;
    });

  linkSel.exit().remove();

  const linkEnter = linkSel.enter().append('path')
    .attr('class', d => edgeClass(d))
    .attr('marker-end', d => {
      const cls = edgeClass(d);
      return cls.includes('lo') ? 'url(#arrow-lo)' : 'url(#arrow)';
    })
    .style('opacity', 0)
    .transition().duration(400).style('opacity', 1);

  linkSel = linkSel.merge(linkEnter);

  // ── Nodes ──────────────────────────────────────────────────────────────
  nodeSel = nodesLayer.selectAll('g.node')
    .data(visibleNodes, d => d.id);

  nodeSel.exit().transition().duration(300).style('opacity', 0).remove();

  const nodeEnter = nodeSel.enter().append('g')
    .attr('class', d => {
      let c = 'node';
      if (d.dimag_status === 'current') c += ' node-current';
      if (d.dimag_status === 'former')  c += ' node-former';
      if (!d.mgp_id && d.dimag_status)  c += ' node-no-mgp';
      return c;
    })
    .style('opacity', 0)
    .call(d3.drag()
      .on('start', dragStart)
      .on('drag',  dragged)
      .on('end',   dragEnd))
    .on('mouseover', showTooltip)
    .on('mousemove', moveTooltip)
    .on('mouseout',  hideTooltip)
    .on('click',     clickNode)
    .on('dblclick',  dblClickNode);

  // ── Pill nodes ───────────────────────────────────────────────────────────
  const pillEnter = nodeEnter.filter(d => isPillNode(d));

  pillEnter.append('rect')
    .attr('class', 'node-pill')
    .attr('x', d => -pillWidth(d) / 2)
    .attr('y', d => -pillHeight(d) / 2)
    .attr('width',  d => pillWidth(d))
    .attr('height', d => pillHeight(d))
    .attr('rx', d => pillHeight(d) / 2)
    .attr('fill',   nodeColor)
    .attr('stroke', d => d3.color(nodeColor(d))?.brighter(0.5).toString())
    .attr('stroke-width', 1.5)
    .attr('stroke-dasharray', d => (!d.mgp_id && d.dimag_status) ? '5 3' : null)
    .attr('filter', nodeGlow);

  // Photo image (for any pill node with mgp_id)
  pillEnter.filter(d => d.mgp_id)
    .append('image')
    .attr('class', 'node-photo')
    .attr('x', d => -pillWidth(d) / 2 + 3)
    .attr('y', d => -(pillHeight(d) - 4) / 2)
    .attr('width',  d => pillHeight(d) - 4)
    .attr('height', d => pillHeight(d) - 4)
    .attr('preserveAspectRatio', 'xMidYMid slice')
    .attr('href', d => `data/photos/${d.mgp_id}.jpg`)
    .attr('clip-path', 'url(#photo-circle-clip)')
    .on('error', function() { d3.select(this).style('display', 'none'); });

  // Name text inside pill
  pillEnter.append('text')
    .attr('class', d => 'node-pill-label' + (d.dimag_status ? ' label-dimag' : ''))
    .attr('x', d => {
      if (!d.mgp_id) return 0;                              // no photo → centered
      return -pillWidth(d) / 2 + (pillHeight(d) - 4) + 10; // right of photo
    })
    .attr('y', 0)
    .attr('text-anchor',       d => d.mgp_id ? 'start' : 'middle')
    .attr('dominant-baseline', 'middle')
    .attr('font-size', baseFontSize + 'px')
    .attr('font-family', 'Inter, system-ui, sans-serif')
    .attr('fill', d =>
      d.dimag_status === 'current' ? '#3a2000' :
      d.dimag_status === 'former'  ? '#0a2a20' : '#ffffff')
    .text(d => d.name || '?');

  nodeEnter.transition().duration(500).delay((_, i) => i * 6).style('opacity', 1);

  nodeSel = nodeSel.merge(nodeEnter);

  // ── Update pill geometry for all nodes (handles font-size changes) ───────
  nodeSel.select('rect.node-pill')
    .attr('x', d => -pillWidth(d) / 2)
    .attr('y', d => -pillHeight(d) / 2)
    .attr('width',  d => pillWidth(d))
    .attr('height', d => pillHeight(d))
    .attr('rx', d => pillHeight(d) / 2);

  nodeSel.select('image.node-photo')
    .attr('x', d => -pillWidth(d) / 2 + 3)
    .attr('y', d => -(pillHeight(d) - 4) / 2)
    .attr('width',  d => pillHeight(d) - 4)
    .attr('height', d => pillHeight(d) - 4);

  nodeSel.selectAll('text.node-pill-label')
    .attr('x', d => {
      if (!d.mgp_id) return 0;
      return -pillWidth(d) / 2 + (pillHeight(d) - 4) + 10;
    })
    .attr('font-size', baseFontSize + 'px');

  // ── Labels (circle nodes only — pill nodes have text built in) ──────────
  labelSel = labelsLayer.selectAll('text.node-label')
    .data(visibleNodes.filter(n => !isPillNode(n)), d => d.id);

  labelSel.exit().remove();

  const labelEnter = labelSel.enter().append('text')
    .attr('class', d => 'node-label' + (d.dimag_status ? ' label-dimag' : ''))
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'hanging')
    .style('opacity', 0)
    .text(d => d.name || '?');

  labelEnter.transition().duration(500).delay((_, i) => i * 6).style('opacity', 1);

  labelSel = labelSel.merge(labelEnter);

  // ── Force Simulation ───────────────────────────────────────────────────
  if (simulation) simulation.stop();

  // Cache existing positions so nodes don't teleport on re-render
  const posCache = new Map();
  visibleNodes.forEach(n => {
    if (n.x != null) posCache.set(n.id, { x: n.x, y: n.y, vx: n.vx ?? 0, vy: n.vy ?? 0 });
  });

  const height = svg.node().clientHeight;

  // Seed initial positions for new nodes
  visibleNodes.forEach(n => {
    if (!posCache.has(n.id)) {
      n.x  = yearToWorld(n.year);
      n.y  = height / 2 + (Math.random() - 0.5) * 400;
      n.vx = 0; n.vy = 0;
    } else {
      const p = posCache.get(n.id);
      n.x = p.x; n.y = p.y; n.vx = p.vx; n.vy = p.vy;
    }
  });

  simulation = d3.forceSimulation(visibleNodes)
    .force('link', d3.forceLink(visibleEdges)
      .id(d => d.id)
      .distance(() => layoutLinkDistance(k))
      .strength(0.15)   // weak link tension — doesn't pull nodes off their year column
    )
    .force('charge', d3.forceManyBody().strength(layoutChargeStrength(k)))  // Y spreading
    .force('x', d3.forceX(d => yearToWorld(d.year)).strength(0.98))  // nearly rigid X
    .force('y', d3.forceY(height / 2).strength(0.03))                // gentle center pull on Y
    .force('collision', d3.forceCollide().radius(d => nodeCollisionRadius(d, k)).strength(1.0))
    .alphaDecay(0.025)
    .on('tick', ticked)
    .on('end', () => {
      updateLOD(currentTransform.k);
      if (posCache.size === 0) resetView();
    });

  simulation.alpha(posCache.size === 0 ? 1 : 0.3).restart();

  // Apply font size immediately (updateLOD is otherwise only called on zoom events)
  updateLOD(currentTransform.k);
}

// Edge endpoint helpers
function pillEdgeX(n, targetX) {
  return n.x + (targetX >= n.x ? pillWidth(n) / 2 : -pillWidth(n) / 2);
}
function circleEdgePoint(n, tx, ty) {
  const dx = tx - n.x, dy = ty - n.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const r = nodeRadius(n);
  return { x: n.x + r * dx / len, y: n.y + r * dy / len };
}

function ticked() {
  edgesLayer.selectAll('path.edge').attr('d', d => {
    const s = d.source, t = d.target;
    if (!s || !t || s.x == null) return '';

    let sx, sy, tx2, ty2;

    if (isPillNode(s)) {
      sx = pillEdgeX(s, t.x); sy = s.y;
    } else {
      const ep = circleEdgePoint(s, t.x, t.y); sx = ep.x; sy = ep.y;
    }
    if (isPillNode(t)) {
      tx2 = pillEdgeX(t, s.x); ty2 = t.y;
    } else {
      const ep = circleEdgePoint(t, s.x, s.y); tx2 = ep.x; ty2 = ep.y;
    }

    const mx = (sx + tx2) / 2 + (ty2 - sy) * 0.12;
    const my = (sy + ty2) / 2 - (tx2 - sx) * 0.12;
    return `M${sx},${sy} Q${mx},${my} ${tx2},${ty2}`;
  });

  nodesLayer.selectAll('g.node')
    .attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);

  labelsLayer.selectAll('text.node-label')
    .attr('x', d => d.x ?? 0)
    .attr('y', d => (d.y ?? 0) + nodeRadius(d) + 5);
}

// ── LOD by zoom ───────────────────────────────────────────────────────────

function updateLOD(k) {
  if (!labelSel) return;

  // In lineage-filtered mode all rendered nodes belong to the kept subset,
  // so keep their labels visible regardless of zoom.
  labelSel.style('display', d => {
    if (isFiltered) return null;
    if (d.dimag_status) return null;
    return k >= LABEL_HIDE_ZOOM ? null : 'none';
  });

  const fontSize = labelFontSizeForZoom(k) + 'px';
  labelSel?.style('font-size', fontSize);
}

// ── Drag ─────────────────────────────────────────────────────────────────

function dragStart(event, d) {
  if (!event.active) simulation.alphaTarget(0.2).restart();
  d.fx = d.x; d.fy = d.y;
}
function dragged(event, d) {
  d.fx = yearToWorld(d.year);  // X is always pinned to PhD year — not draggable
  d.fy = event.y;
}
function dragEnd(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null; d.fy = null;
}

// ── Tooltip ───────────────────────────────────────────────────────────────

function showTooltip(event, d) {
  const badge = d.dimag_status
    ? `<span class="tt-badge badge-${d.dimag_status}">${d.dimag_status === 'current' ? 'Current DIMAG' : 'Former DIMAG'}</span>`
    : '';
  tooltip.innerHTML = `
    <div class="tt-name">${d.name || 'Unknown'}</div>
    ${badge}
    ${d.institution ? `<div class="tt-row">Institution: <span>${d.institution}</span></div>` : ''}
    ${d.year        ? `<div class="tt-row">PhD year: <span>${d.yearEstimated ? '~' : ''}${d.year}</span></div>` : ''}
    ${d.dissertation ? `<div class="tt-row">Dissertation: <span>${d.dissertation.slice(0,120)}${d.dissertation.length > 120 ? '…' : ''}</span></div>` : ''}
  `.trim();
  tooltip.classList.remove('hidden');
  moveTooltip(event);
}

function moveTooltip(event) {
  const pad = 14, tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  let x = event.clientX + pad, y = event.clientY + pad;
  if (x + tw > window.innerWidth)  x = event.clientX - tw - pad;
  if (y + th > window.innerHeight) y = event.clientY - th - pad;
  tooltip.style.left = `${x}px`;
  tooltip.style.top  = `${y}px`;
}

function hideTooltip() { tooltip.classList.add('hidden'); }

// ── Sidebar ───────────────────────────────────────────────────────────────

function clickNode(event, d) {
  event.stopPropagation();
  if (selectedNode === d.id) { closeSidebar(); return; }
  selectedNode = d.id;
  openSidebar(d);
  if (!isFiltered) highlightConnected(d);
}

function openSidebar(d) {
  const mgpUrl  = d.mgp_id ? `https://www.mathgenealogy.org/id.php?id=${d.mgp_id}` : null;
  const wikiUrl = d.mgp_id ? (wikipediaUrls[String(d.mgp_id)] ?? null) : null;
  const badgeHtml = d.dimag_status
    ? `<span class="sb-badge sb-badge-${d.dimag_status}">${d.dimag_status === 'current' ? 'Current DIMAG member' : 'Former DIMAG member'}</span>`
    : '';
  const krHtml    = d.name_kr ? ` <span style="color:var(--text-dim);font-size:0.85em">${d.name_kr}</span>` : '';
  const roleHtml  = d.role ? `<div class="sb-section"><div class="sb-label">Role</div><div class="sb-value">${d.role}</div></div>` : '';

  const advisorNodes = (d.advisors || []).map(id => nodeById.get(id)).filter(Boolean);
  const studentNodes = (d.students || []).map(id => nodeById.get(id)).filter(Boolean);

  const advisorsHtml = advisorNodes.length
    ? `<div class="sb-section"><div class="sb-label">Advisors</div>
       <ul class="sb-people-list">${advisorNodes.map(a => `<li data-id="${a.id}">${a.name || a.id}</li>`).join('')}</ul></div>`
    : '';

  const studentsHtml = studentNodes.length
    ? `<div class="sb-section"><div class="sb-label">Students (${studentNodes.length})</div>
       <ul class="sb-people-list">${studentNodes.slice(0,15).map(s =>
         `<li data-id="${s.id}">${s.name || s.id}${s.year ? ` (${s.year})` : ''}</li>`
       ).join('')}${studentNodes.length > 15 ? `<li style="color:var(--text-dim)">…and ${studentNodes.length - 15} more</li>` : ''}</ul></div>`
    : '';

  const ancestors = buildAncestryChain(d);
  const ancestryHtml = ancestors.length
    ? `<div class="sb-section">
         <div class="sb-label">Ancestry chain — ${ancestors.length} ancestor${ancestors.length !== 1 ? 's' : ''}</div>
         <ol class="sb-ancestry-list">
           ${ancestors.map(a => `<li data-id="${a.id}">${a.name || a.id}${a.year ? ` <span class="sb-year">(${a.yearEstimated ? '~' : ''}${a.year})</span>` : ''}</li>`).join('')}
         </ol>
         <div class="sb-ancestry-self">${d.name} ← you</div>
       </div>`
    : '';

  const photoHtml = d.mgp_id
    ? `<img class="sb-photo" src="data/photos/${d.mgp_id}.jpg" alt="${d.name}" onerror="this.style.display='none'">`
    : '';

  sidebarContent.innerHTML = `
    ${photoHtml}
    <h2>${d.name || 'Unknown'}${krHtml}</h2>
    ${badgeHtml}
    ${roleHtml}
    ${d.institution ? `<div class="sb-section"><div class="sb-label">Institution</div><div class="sb-value">${d.institution}</div></div>` : ''}
    ${d.year        ? `<div class="sb-section"><div class="sb-label">PhD Year${d.yearEstimated ? ' (estimated)' : ''}</div><div class="sb-value">${d.yearEstimated ? '~' : ''}${d.year}</div></div>` : ''}
    ${d.dissertation ? `<div class="sb-section"><div class="sb-label">Dissertation</div><div class="sb-value" style="font-style:italic">${d.dissertation}</div></div>` : ''}
    <hr class="sb-divider">
    ${ancestryHtml}
    ${advisorsHtml}
    ${studentsHtml}
    ${mgpUrl  ? `<a class="sb-mgp-link" href="${mgpUrl}"  target="_blank" rel="noopener">View on Math Genealogy Project ↗</a>` : ''}
    ${wikiUrl ? `<a class="sb-mgp-link" href="${wikiUrl}" target="_blank" rel="noopener">View on Wikipedia ↗</a>` : ''}
  `.trim();

  sidebarContent.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = +el.dataset.id || el.dataset.id;
      const n = nodeById.get(id);
      if (n) navigateTo(n);
    });
  });

  sidebar.classList.remove('hidden');
  if (window.innerWidth <= 600) mobileOverlay.classList.remove('hidden');
}

function closeSidebar() {
  selectedNode = null;
  sidebar.classList.add('hidden');
  if (window.innerWidth <= 600) mobileOverlay.classList.add('hidden');
  if (!isFiltered) clearHighlight();
}

// Only close sidebar on a genuine stationary background click.
// Panning (drag-and-release) generates a click event that D3 zoom
// suppresses via event.defaultPrevented. We also guard with a movement
// threshold so any scroll/pan interaction never wipes the state.
let _bgPointerMoved = false;
svg.on('pointerdown.bg', () => { _bgPointerMoved = false; });
svg.on('pointermove.bg', () => { _bgPointerMoved = true;  });
svg.on('click.bg', (event) => {
  if (event.defaultPrevented) return;  // D3 zoom suppresses post-drag clicks
  if (_bgPointerMoved) return;         // was a pan, not a tap
  closeSidebar();
});

// ── Highlight ─────────────────────────────────────────────────────────────

function highlightConnected(d) {
  const highlighted = new Set([d.id]);

  // BFS upward — all ancestors
  const upQueue = [d.id];
  while (upQueue.length) {
    const id   = upQueue.pop();
    const node = nodeById.get(id);
    for (const aid of (node?.advisors || [])) {
      if (!highlighted.has(aid)) { highlighted.add(aid); upQueue.push(aid); }
    }
  }

  // BFS downward — all descendants
  const downQueue = [d.id];
  const seenDown  = new Set([d.id]);
  while (downQueue.length) {
    const id   = downQueue.pop();
    const node = nodeById.get(id);
    for (const sid of (node?.students || [])) {
      if (!seenDown.has(sid)) { seenDown.add(sid); highlighted.add(sid); downQueue.push(sid); }
    }
  }

  nodeSel?.style('opacity', n => highlighted.has(n.id) ? 1 : 0.08);
  linkSel?.style('opacity', e => {
    const s = typeof e.source === 'object' ? e.source.id : e.source;
    const t = typeof e.target === 'object' ? e.target.id : e.target;
    return (highlighted.has(s) && highlighted.has(t)) ? 1 : 0.04;
  });
}

// Restore only opacity (leaves display/filter state untouched)
function clearHighlight() {
  nodeSel?.style('opacity', 1);
  linkSel?.style('opacity', 1);
}

// Restore display + opacity — called by Reset and double-click toggle
function clearFilter() {
  isFiltered = false;
  filteredNodeIds = null;
  render();
  nodeSel?.style('opacity', 1);
  labelSel?.style('opacity', 1);
  linkSel?.style('opacity', 1);
  resetBtn.classList.remove('reset-active');
}

// ── Double-click: hide all except ancestors + descendants ─────────────────

function dblClickNode(event, d) {
  event.stopPropagation();

  // If already filtered, clicking again resets
  if (isFiltered) { clearFilter(); return; }

  isFiltered = true;
  filteredNodeIds = collectLineageNodeIds(d.id);
  resetBtn.classList.add('reset-active');
  render();
}

// ── Search ────────────────────────────────────────────────────────────────

function performSearch(q, inputEl, resultsEl) {
  q = q.trim().toLowerCase();
  if (q.length < 2) { resultsEl.classList.add('hidden'); return; }
  const matches = allNodes.filter(n => n.name?.toLowerCase().includes(q)).slice(0, 10);
  if (!matches.length) { resultsEl.classList.add('hidden'); return; }

  resultsEl.innerHTML = matches.map(n => `
    <div class="search-result-item" data-id="${n.id}">
      ${n.name}
      <span class="dim">${n.institution || ''}${n.year ? ` · ${n.year}` : ''}</span>
    </div>`).join('');

  resultsEl.querySelectorAll('.search-result-item').forEach(el => {
    el.addEventListener('click', () => {
      const n = nodeById.get(+el.dataset.id || el.dataset.id);
      if (n) { navigateTo(n); resultsEl.classList.add('hidden'); inputEl.value = ''; }
    });
  });
  resultsEl.classList.remove('hidden');
}

function setupSearch() {
  let timer;
  searchInput.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => performSearch(searchInput.value, searchInput, searchResults), 200);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrap')) searchResults.classList.add('hidden');
  });
}

// ── Navigate to node ──────────────────────────────────────────────────────

function navigateTo(n) {
  if (n.x == null) return;
  const W = svg.node().clientWidth, H = svg.node().clientHeight;
  const k = Math.max(currentTransform.k, 0.8);
  svg.transition().duration(750).call(
    zoom.transform,
    d3.zoomIdentity.translate(W / 2 - k * n.x, H / 2 - k * n.y).scale(k)
  );
  setTimeout(() => {
    nodesLayer.selectAll('g.node').filter(d => d.id === n.id).classed('node-flash', true);
    setTimeout(() => nodesLayer.selectAll('g.node').classed('node-flash', false), 900);
  }, 500);
  openSidebar(n); selectedNode = n.id;
}

// ── Fit viewport to a set of nodes ───────────────────────────────────────

function fitNodes(nodes, pad = 80, maxScale = 2.5, duration = 700) {
  if (!nodes.length) return;
  const W  = svg.node().clientWidth, H = svg.node().clientHeight;
  const xs = nodes.map(d => d.x), ys = nodes.map(d => d.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const kx = (W - pad * 2)               / Math.max(x1 - x0, 1);
  const ky = (H - AXIS_HEIGHT - pad * 2) / Math.max(y1 - y0, 1);
  const k  = Math.min(kx, ky, maxScale);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const ty = (H + AXIS_HEIGHT) / 2 - k * cy;
  svg.transition().duration(duration).call(
    zoom.transform,
    d3.zoomIdentity.translate(W / 2 - k * cx, ty).scale(k)
  );
}

// ── Reset view ────────────────────────────────────────────────────────────

function resetView() {
  closeSidebar(); clearFilter();

  const dimagNodes = visibleNodes.filter(n => n.dimag_status && n.x != null);
  if (!dimagNodes.length) { svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity); return; }
  fitNodes(dimagNodes);
}

// ── Mobile controls ────────────────────────────────────────────────────────

function setupMobile() {
  if (!mobileSearchBtn) return;

  // Search toggle
  mobileSearchBtn.addEventListener('click', () => {
    mobileSearchBar.classList.remove('hidden');
    mobileSearchInput.focus();
  });
  mobileSearchClose.addEventListener('click', closeMobileSearch);
  mobileSearchInput.addEventListener('click', e => e.stopPropagation());

  let mobileTimer;
  mobileSearchInput.addEventListener('input', () => {
    clearTimeout(mobileTimer);
    mobileTimer = setTimeout(() => performSearch(mobileSearchInput.value, mobileSearchInput, mobileSearchResults), 200);
  });

  // Settings sheet
  mobileSettingsBtn.addEventListener('click', openMobileSheet);
  mobileSheetClose.addEventListener('click', closeMobileSheet);
  mobileOverlay.addEventListener('click', () => { closeMobileSheet(); closeSidebar(); });

  // Font slider
  mobileFontSlider.addEventListener('input', () => {
    baseFontSize = +mobileFontSlider.value;
    mobileFontValue.textContent = baseFontSize;
    fontValue.textContent = baseFontSize;
    fontSlider.value = mobileFontSlider.value;
    render();
  });

  // Reset
  mobileResetBtn.addEventListener('click', () => { closeMobileSheet(); resetView(); });
}

function openMobileSheet() {
  mobileSheet.classList.remove('hidden');
  mobileOverlay.classList.remove('hidden');
}

function closeMobileSheet() {
  mobileSheet.classList.add('hidden');
  mobileOverlay.classList.add('hidden');
}

function closeMobileSearch() {
  mobileSearchBar.classList.add('hidden');
  mobileSearchInput.value = '';
  mobileSearchResults.classList.add('hidden');
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

loadData();
