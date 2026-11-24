const API = "/api";
const DEFAULT_SPACE_ID = "00000000-0000-0000-0000-000000000001";
const NODE_POSITIONS_KEY = "mnemosyne-node-positions";
const RECENT_DRAFT_NODE_KINDS_KEY = "mnemosyne-recent-draft-node-kinds";
const ACTIVE_VIEW_KEY = "mnemosyne-active-view";
const WORKSPACE_VIEWS = new Set(["graph", "search", "timeline", "connections", "decisions"]);
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
function readNodePositions() {
  try {
    const stored = localStorage.getItem(NODE_POSITIONS_KEY);
    if (!stored) return new Map();
    const positions = JSON.parse(stored);
    if (!positions || typeof positions !== "object" || Array.isArray(positions)) {
      throw new TypeError("Saved graph positions must be an object");
    }

    return new Map(
      Object.entries(positions).filter(([, point]) =>
        point && Number.isFinite(point.x) && Number.isFinite(point.y)),
    );
  } catch (error) {
    console.error("Could not load saved graph positions.", error);
    return new Map();
  }
}
const state = {
  view: "spaces", graph: { nodes: [], edges: [] }, scale: 1,
  offsetX: 0, offsetY: 0, selected: null, filter: "all",
  linkSourceId: null, linkTargetId: null, nodeDrag: null, suppressNodeClick: null,
  nodePositions: readNodePositions(), spaceId: localStorage.getItem("mnemosyne-space-id"),
  spaces: [], graphCache: new Map(), graphLoadedSpaces: new Set(),
  graphRequests: new Map(), graphRequestId: 0,
  itemsById: new Map(), relatedById: new Map(), relatedErrors: new Map(),
  detailRequestId: 0, searchRequestId: 0, connectionsRequestId: 0, searchMode: "text",
  editingEdge: null, decisions: [], editingDecision: null, confirmResolver: null,
  documentPreview: null,
};
const COLORS = { note: "#67d694", document: "#e2d571", bookmark: "#90a8d7", decision: "#9c87d8" };
const FILTERS = ["all", "note", "document", "bookmark", "decision"];
const SUGGESTED_DRAFT_NODE_KINDS = [
  "topic", "concept", "person", "organization", "place", "event", "project",
  "programming language", "tool", "technology", "decision", "resource", "skill",
];

function recentDraftNodeKinds() {
  try {
    const stored = JSON.parse(localStorage.getItem(RECENT_DRAFT_NODE_KINDS_KEY) || "[]");
    if (!Array.isArray(stored)) throw new TypeError("Recent node types must be an array");
    return stored.filter((kind) => typeof kind === "string" && kind.trim()).slice(0, 5);
  } catch (error) {
    console.error("Could not load recently used node types.", error);
    return [];
  }
}

function rememberDraftNodeKind(value) {
  const kind = value.trim().slice(0, 64);
  if (!kind) return;
  const recent = [
    kind,
    ...recentDraftNodeKinds().filter((entry) => entry.toLocaleLowerCase() !== kind.toLocaleLowerCase()),
  ].slice(0, 5);
  try {
    localStorage.setItem(RECENT_DRAFT_NODE_KINDS_KEY, JSON.stringify(recent));
  } catch (error) {
    console.error("Could not save recently used node types.", error);
  }
}

function draftNodeKindEditor(value, onChange) {
  const editor = document.createElement("div");
  editor.className = "draft-type-editor";
  const input = document.createElement("input");
  input.type = "text";
  input.required = true;
  input.maxLength = 64;
  input.value = value;
  input.placeholder = "Type any node category";
  input.setAttribute("aria-label", "Node type");
  input.addEventListener("input", () => onChange(input.value));
  input.addEventListener("blur", () => {
    input.value = input.value.trim();
    onChange(input.value);
    rememberDraftNodeKind(input.value);
    renderSuggestions();
  });
  editor.append(input);

  const suggestions = document.createElement("div");
  suggestions.className = "draft-type-suggestions";
  editor.append(suggestions);

  function renderSuggestions() {
    suggestions.replaceChildren();
    const recent = recentDraftNodeKinds();
    const groups = [
      { title: "Recently used", kinds: recent },
      {
        title: "Suggestions",
        kinds: SUGGESTED_DRAFT_NODE_KINDS
          .filter((kind) => !recent.some((entry) => entry.toLocaleLowerCase() === kind.toLocaleLowerCase()))
          .slice(0, 6),
      },
    ];
    for (const group of groups) {
      if (!group.kinds.length) continue;
      const section = document.createElement("div");
      section.className = "draft-type-suggestion-group";
      const heading = document.createElement("span");
      heading.textContent = group.title;
      const choices = document.createElement("div");
      choices.className = "draft-type-chip-list";
      for (const kind of group.kinds) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "draft-type-chip";
        chip.textContent = kind;
        chip.addEventListener("click", () => {
          input.value = kind;
          onChange(kind);
          rememberDraftNodeKind(kind);
          input.focus();
          renderSuggestions();
        });
        choices.append(chip);
      }
      section.append(heading, choices);
      suggestions.append(section);
    }
  }

  renderSuggestions();
  return editor;
}

function apiKey() {
  return localStorage.getItem("mnemosyne-api-key") || "";
}

async function request(path, options = {}) {
  if (state.spaceId && !path.startsWith("/spaces")) {
    const separator = path.includes("?") ? "&" : "?";
    path = `${path}${separator}space_id=${encodeURIComponent(state.spaceId)}`;
  }
  const headers = new Headers(options.headers || {});
  headers.set("X-API-Key", apiKey());
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${API}${path}`, { ...options, headers });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { message = (await response.json()).detail || message; } catch { /* use status text */ }
    if (response.status === 401) message = "Set the API key in Settings to use this workspace.";
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("visible");
  window.setTimeout(() => node.classList.remove("visible"), 2600);
}

function askConfirmation(message, title = "Delete this item?") {
  return new Promise((resolve) => {
    state.confirmResolver = resolve;
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    $("#confirm-dialog").showModal();
  });
}

function finishConfirmation(accepted) {
  const resolve = state.confirmResolver;
  state.confirmResolver = null;
  if ($("#confirm-dialog").open) $("#confirm-dialog").close();
  if (resolve) resolve(accepted);
}

function niceDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown date" : new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", year: "numeric",
  }).format(date);
}

function shortDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(date);
}

function setSync(online, text = online ? "Connected" : "Offline") {
  const node = $("#sync-state");
  node.classList.toggle("online", online);
  node.lastChild.textContent = text;
}

function readActiveView() {
  try {
    const saved = sessionStorage.getItem(ACTIVE_VIEW_KEY);
    return WORKSPACE_VIEWS.has(saved) ? saved : "spaces";
  } catch (error) {
    console.error("Could not restore the active view.", error);
    return "spaces";
  }
}

function showView(name) {
  state.view = name;
  const isSpacesHome = name === "spaces";
  try {
    if (isSpacesHome) sessionStorage.removeItem(ACTIVE_VIEW_KEY);
    else sessionStorage.setItem(ACTIVE_VIEW_KEY, name);
  } catch (error) {
    console.error("Could not save the active view.", error);
  }
  $("#app-shell").classList.toggle("spaces-home-mode", isSpacesHome);
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $$(".view-panel").forEach((panel) => panel.classList.toggle("hidden", panel.id !== `${name}-view`));
  if (isSpacesHome) {
    renderSpacesHome($("#spaces-home-search").value);
    return;
  }
  const activeSpace = state.spaces.find((space) => space.id === state.spaceId);
  $("#breadcrumb-space").textContent = activeSpace?.name || "Workspace";
  $("#view-label").textContent = name.charAt(0).toUpperCase() + name.slice(1);
  if (name === "graph") loadGraph(false);
  if (name === "timeline") loadTimeline();
  if (name === "connections") loadConnections();
  if (name === "decisions") loadDecisions();
  if (name === "search") $("#search-query").focus();
}

function graphPoint(index, total, node) {
  const hash = [...node.id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
  const angle = (index / Math.max(total, 1)) * Math.PI * 2 + (hash % 23) / 100;
  const ring = 70 + (hash % 240);
  return { x: 550 + Math.cos(angle) * ring, y: 337 + Math.sin(angle) * ring * .65 };
}

function eventPointInSvg(event, svg) {
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  const pointer = svg.createSVGPoint();
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  const point = pointer.matrixTransform(matrix.inverse());
  return { x: point.x, y: point.y };
}

function zoomMainGraph(factor, anchorX = 550, anchorY = 340) {
  const previousScale = state.scale;
  const nextScale = Math.max(.45, Math.min(2.8, previousScale * factor));
  if (nextScale === previousScale) return;
  const ratio = nextScale / previousScale;
  state.offsetX = anchorX - 550 - ratio * (anchorX - 550 - state.offsetX);
  state.offsetY = anchorY - 340 - ratio * (anchorY - 340 - state.offsetY);
  state.scale = nextScale;
  renderGraph(state.graph);
}

function renderGraph(data) {
  state.graph = data;
  if (state.graphLoadedSpaces.has(state.spaceId)) cacheGraph(state.spaceId, data);
  $("#count-connections").textContent = String(
    data.edges.filter((edge) => edge.kind !== "semantic" && edge.kind !== "suppressed_semantic").length,
  );
  const svg = $("#graph-canvas");
  svg.replaceChildren();
  const allNodes = data.nodes || [];
  const nodeSet = allNodes.filter((node) => state.filter === "all" || node.type === state.filter);
  const visibleIds = new Set(nodeSet.map((node) => node.id));
  const edges = (data.edges || []).filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const nodes = nodeSet;
  $("#count-items").textContent = allNodes.length;
  $("#graph-count").textContent = `${nodes.length} notes · ${edges.length} connections`;
  $("#graph-filter").firstChild.textContent =
    state.filter === "all" ? "All notes " : `${state.filter[0].toUpperCase()}${state.filter.slice(1)} `;
  $("#graph-empty").classList.toggle("hidden", nodes.length > 0);
  if (!nodes.length) return;

  const positions = new Map(nodes.map((node, index) => [
    node.id,
    state.nodePositions.get(node.id) || graphPoint(index, nodes.length, node),
  ]));
  const drawing = document.createElementNS("http://www.w3.org/2000/svg", "g");
  drawing.setAttribute("class", "graph-drawing");
  drawing.setAttribute(
    "transform",
    `translate(${550 + state.offsetX} ${340 + state.offsetY}) scale(${state.scale}) translate(-550 -340)`,
  );
  svg.append(drawing);

  const edgeLines = [];
  for (const edge of edges) {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (!from || !to) continue;
    const line = document.createElementNS(svg.namespaceURI, "line");
    let hitLine = null;
    let edgeLabel = null;
    line.setAttribute("x1", from.x); line.setAttribute("y1", from.y);
    line.setAttribute("x2", to.x); line.setAttribute("y2", to.y);
    line.setAttribute("class", `graph-edge ${edge.kind === "semantic" ? "semantic" : ""}`);
    drawing.append(line);
    hitLine = document.createElementNS(svg.namespaceURI, "line");
    hitLine.setAttribute("x1", from.x); hitLine.setAttribute("y1", from.y);
    hitLine.setAttribute("x2", to.x); hitLine.setAttribute("y2", to.y);
    hitLine.setAttribute("class", "graph-edge-hit");
    hitLine.setAttribute("tabindex", "0");
    hitLine.setAttribute("role", "button");
    hitLine.setAttribute(
      "aria-label",
      edge.kind === "semantic" ? "Review suggested connection" : `Edit connection: ${edge.label || edge.kind}`,
    );
    hitLine.addEventListener("click", (event) => {
      event.stopPropagation();
      openEdgeEditor(edge);
    });

    hitLine.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openEdgeEditor(edge);
      }
    });
    drawing.append(hitLine);
    if (edge.label) {
      edgeLabel = document.createElementNS(svg.namespaceURI, "text");
      edgeLabel.setAttribute("x", String((from.x + to.x) / 2));
      edgeLabel.setAttribute("y", String((from.y + to.y) / 2 - 5));
      edgeLabel.setAttribute("class", "graph-edge-label");
      edgeLabel.textContent = edge.label;
      drawing.append(edgeLabel);
    }
    edgeLines.push({ line, hitLine, edgeLabel, edge });
  }
  function updateEdges(nodeId) {
    for (const { line, hitLine, edgeLabel, edge } of edgeLines) {
      if (edge.source !== nodeId && edge.target !== nodeId) continue;
      const from = positions.get(edge.source);
      const to = positions.get(edge.target);
      line.setAttribute("x1", from.x); line.setAttribute("y1", from.y);
      line.setAttribute("x2", to.x); line.setAttribute("y2", to.y);
      if (hitLine) {
        hitLine.setAttribute("x1", from.x); hitLine.setAttribute("y1", from.y);
        hitLine.setAttribute("x2", to.x); hitLine.setAttribute("y2", to.y);
      }
      if (edgeLabel) {
        edgeLabel.setAttribute("x", String((from.x + to.x) / 2));
        edgeLabel.setAttribute("y", String((from.y + to.y) / 2 - 5));
      }
    }
  }
  nodes.forEach((node) => {
    const point = positions.get(node.id);
    const color = COLORS[node.type] || COLORS.note;
    const group = document.createElementNS(svg.namespaceURI, "g");
    group.setAttribute("class", `graph-node${state.selected?.id === node.id ? " selected" : ""}`);
    group.setAttribute("transform", `translate(${point.x} ${point.y})`);
    group.dataset.id = node.id;
    group.setAttribute("role", "button");
    group.setAttribute("tabindex", "0");
    group.setAttribute("aria-label", `Open node: ${node.title}`);
    const halo = document.createElementNS(svg.namespaceURI, "circle");
    halo.setAttribute("r", "14");
    halo.setAttribute("fill", color);
    halo.setAttribute("class", "node-halo");
    const core = document.createElementNS(svg.namespaceURI, "circle");
    core.setAttribute("r", "6");
    core.setAttribute("fill", color);
    core.setAttribute("class", "node-core");
    const kind = document.createElementNS(svg.namespaceURI, "text");
    kind.setAttribute("x", "21");
    kind.setAttribute("y", "-5");
    kind.setAttribute("class", "node-kind");
    kind.textContent = node.type.toLocaleUpperCase();
    const label = document.createElementNS(svg.namespaceURI, "text");
    label.setAttribute("x", "21");
    label.setAttribute("y", "11");
    label.setAttribute("class", "node-label");
    label.textContent = node.title.length > 20 ? `${node.title.slice(0, 19)}…` : node.title;
    group.append(halo, core, kind, label);
    group.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || state.nodeDrag || state.linkSourceId) return;
      const pointer = eventPointInDrawing(event, drawing);
      if (!pointer) return;
      event.stopPropagation();
      const position = positions.get(node.id);
      state.nodeDrag = {
        id: node.id,
        start: pointer,
        position,
        moved: false,
        pointerId: event.pointerId,
      };
      group.classList.add("dragging");
      group.setPointerCapture(event.pointerId);
    });
    group.addEventListener("pointermove", (event) => {
      const active = state.nodeDrag;
      if (!active || active.id !== node.id) return;
      const pointer = eventPointInDrawing(event, drawing);
      if (!pointer) return;
      const dx = pointer.x - active.start.x;
      const dy = pointer.y - active.start.y;
      if (!active.moved && Math.hypot(dx, dy) < 2) return;
      active.moved = true;
      const position = { x: active.position.x + dx, y: active.position.y + dy };
      positions.set(node.id, position);
      state.nodePositions.set(node.id, position);
      group.setAttribute("transform", `translate(${position.x} ${position.y})`);
      updateEdges(node.id);
    });
    const finishNodeDrag = () => {
      const active = state.nodeDrag;
      if (!active || active.id !== node.id) return;
      group.classList.remove("dragging");
      state.nodeDrag = null;
      if (active.moved) {
        saveNodePositions();
        state.suppressNodeClick = node.id;
        window.setTimeout(() => {
          if (state.suppressNodeClick === node.id) state.suppressNodeClick = null;
        }, 0);
      }
    };
    group.addEventListener("pointerup", finishNodeDrag);
    group.addEventListener("pointercancel", finishNodeDrag);
    group.addEventListener("click", () => {
      if (state.suppressNodeClick === node.id) {
        state.suppressNodeClick = null;
        return;
      }
      if (state.linkSourceId) {
        if (state.linkSourceId === node.id) {
          toast("Choose a different node for the connection");
          return;
        }
        state.linkTargetId = node.id;
        $("#link-source-label").textContent =
          `${itemTitle(state.linkSourceId)}  →  ${node.title}`;
        $("#link-label").value = "";
        $("#link-message").textContent = "";
        $("#link-mode-banner").classList.add("hidden");
        $("#link-dialog").showModal();
        return;
      }
      selectItem(node.id);
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (state.linkSourceId) {
          if (state.linkSourceId === node.id) {
            toast("Choose a different node for the connection");
            return;
          }
          state.linkTargetId = node.id;
          $("#link-source-label").textContent =
            `${itemTitle(state.linkSourceId)}  →  ${node.title}`;
          $("#link-label").value = "";
          $("#link-message").textContent = "";
          $("#link-mode-banner").classList.add("hidden");
          $("#link-dialog").showModal();
        } else {
          selectItem(node.id);
        }
      }
    });
    drawing.append(group);
  });
}

function updateSelectedGraphNode(id) {
  for (const node of $$("#graph-canvas .graph-node")) {
    node.classList.toggle("selected", node.dataset.id === id);
  }
}

function eventPointInDrawing(event, drawing) {
  const matrix = drawing.getScreenCTM();
  if (!matrix) return null;
  const pointer = graphSvg.createSVGPoint();
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  const point = pointer.matrixTransform(matrix.inverse());
  return { x: point.x, y: point.y };
}

function saveNodePositions() {
  try {
    localStorage.setItem(NODE_POSITIONS_KEY, JSON.stringify(Object.fromEntries(state.nodePositions)));
  } catch (error) {
    console.error("Could not save graph positions.", error);
    toast("Could not save node positions in this browser");
  }
}

function cacheGraph(spaceId, data) {
  if (!spaceId) return;
  state.graphCache.delete(spaceId);
  state.graphCache.set(spaceId, data);
  while (state.graphCache.size > 4) {
    state.graphCache.delete(state.graphCache.keys().next().value);
  }
}

async function loadGraph(force = true) {
  const spaceId = state.spaceId;
  const cached = state.graphCache.get(spaceId);
  if (!force && cached && state.graphLoadedSpaces.has(spaceId)) {
    $("#graph-loading").classList.add("hidden");
    renderGraph(cached);
    setSync(true);
    return true;
  }
  const pending = state.graphRequests.get(spaceId);
  if (!force && pending) return pending.promise;
  if (!state.graph.nodes.length) {
    $("#graph-empty").classList.add("hidden");
    $("#graph-loading").classList.remove("hidden");
  }
  const requestId = ++state.graphRequestId;
  const promise = (async () => {
    try {
      const data = await request("/graph");
      if (state.graphRequests.get(spaceId)?.id !== requestId) return false;
      state.graphLoadedSpaces.add(spaceId);
      cacheGraph(spaceId, data);
      if (state.spaceId !== spaceId) return false;
      $("#graph-loading").classList.add("hidden");
      state.relatedById.clear();
      state.relatedErrors.clear();
      renderGraph(data);
      setSync(true);
      return true;
    } catch (error) {
      if (state.graphRequests.get(spaceId)?.id !== requestId || state.spaceId !== spaceId) {
        return false;
      }
      $("#graph-loading").classList.add("hidden");
      setSync(false, "Not connected");
      $("#graph-empty").classList.remove("hidden");
      toast(error.message);
      return false;
    } finally {
      if (state.graphRequests.get(spaceId)?.id === requestId) {
        state.graphRequests.delete(spaceId);
      }
    }
  })();
  state.graphRequests.set(spaceId, { id: requestId, promise });
  return promise;
}

async function selectItem(id) {
  const requestId = ++state.detailRequestId;
  const spaceId = state.spaceId;
  try {
    const item = state.itemsById.get(id) || await request(`/items/${id}`);
    if (requestId !== state.detailRequestId || spaceId !== state.spaceId) return;
    state.itemsById.set(id, item);
    state.selected = item;
    updateSelectedGraphNode(id);
    const related = state.relatedById.get(id);
    const decision = state.decisions.find((entry) => entry.item_id === item.id) || null;
    renderDetail(
      item,
      related || [],
      decision,
      related ? null : state.relatedErrors.get(id) || "loading",
    );
    if (!related) void loadRelatedForSelection(item, requestId, spaceId);
    if (item.type === "decision" && !decision) {
      void loadDecisionForSelection(item, requestId, spaceId);
    }
  } catch (error) {
    if (requestId === state.detailRequestId && spaceId === state.spaceId) toast(error.message);
  }
}

async function loadRelatedForSelection(item, requestId, spaceId) {
  try {
    const hits = await request(`/items/${item.id}/related?limit=4`);
    if (spaceId !== state.spaceId) return;
    state.relatedById.set(item.id, hits);
    state.relatedErrors.delete(item.id);
    for (const hit of hits) state.itemsById.set(hit.item.id, hit.item);
    if (requestId === state.detailRequestId) {
      renderDetail(item, hits, state.decisions.find((entry) => entry.item_id === item.id) || null);
    }
  } catch (error) {
    if (requestId === state.detailRequestId && spaceId === state.spaceId) {
      state.relatedErrors.set(item.id, error.message);
      renderDetail(item, [], state.decisions.find((entry) => entry.item_id === item.id) || null, error.message);
    }
  }
}

async function loadDecisionForSelection(item, requestId, spaceId) {
  try {
    const decisions = await request("/decisions");
    if (spaceId !== state.spaceId) return;
    state.decisions = decisions;
    if (requestId === state.detailRequestId) {
      renderDetail(
        item,
        state.relatedById.get(item.id) || [],
        decisions.find((entry) => entry.item_id === item.id) || null,
        state.relatedById.has(item.id) ? null : state.relatedErrors.get(item.id) || "loading",
      );
    }
  } catch (error) {
    if (requestId === state.detailRequestId && spaceId === state.spaceId) toast(error.message);
  }
}

function renderDetail(item, related = [], decision = null, relatedStatus = null) {
  state.itemsById.set(item.id, item);
  const container = $("#detail-content");
  container.classList.remove("detail-placeholder");
  const type = document.createElement("span");
  type.className = "detail-type";
  type.textContent = `${item.type} · ${niceDate(item.captured_at)}`;
  const title = document.createElement("h2");
  title.className = "detail-title"; title.textContent = item.title;
  const date = document.createElement("div");
  date.className = "detail-date"; date.textContent = `UPDATED ${shortDate(item.updated_at).toUpperCase()}`;
  const content = document.createElement("div");
  content.className = "detail-body"; content.textContent = item.content;
  container.replaceChildren(type, title, date, content);
  const connect = document.createElement("button");
  connect.className = "button secondary";
  connect.textContent = "Connect to node";
  connect.addEventListener("click", () => openLinkDialog(item));
  const edit = document.createElement("button");
  edit.className = "button secondary";
  edit.textContent = decision ? "Edit decision" : "Edit";
  edit.addEventListener("click", () => {
    if (decision) openDecisionEditor(decision);
    else openNodeEditor(item);
  });
  const remove = document.createElement("button");
  remove.className = "button danger-button";
  remove.textContent = "Delete";
  remove.addEventListener("click", () => deleteNode(item));
  const actions = document.createElement("div");
  actions.className = "detail-actions";
  if (item.type === "document") {
    const preview = document.createElement("button");
    preview.className = "button secondary";
    preview.textContent = "Preview";
    preview.addEventListener("click", () => openSavedDocument(item));
    actions.append(edit, preview, remove);
  } else {
    actions.append(edit, remove);
  }
  container.append(actions);
  connect.classList.add("detail-connect");
  container.append(connect);
  if (item.source_uri) {
    const divider = document.createElement("div"); divider.className = "detail-divider";
    const source = document.createElement("a");
    const parsedSource = URL.canParse(item.source_uri) ? new URL(item.source_uri) : null;
    if (parsedSource && ["http:", "https:"].includes(parsedSource.protocol)) {
      source.className = "related-link";
      source.href = parsedSource.href; source.target = "_blank"; source.rel = "noreferrer";
      source.textContent = "Open source ↗"; container.append(divider, source);
    }
  }
  if (related.length || relatedStatus) {
    const divider = document.createElement("div"); divider.className = "detail-divider";
    const subhead = document.createElement("div"); subhead.className = "detail-subhead"; subhead.textContent = "Related notes";
    container.append(divider, subhead);
    for (const hit of related) {
      const link = document.createElement("button"); link.className = "related-link";
      link.textContent = hit.item.title; link.addEventListener("click", () => selectItem(hit.item.id));
      container.append(link);
    }
    if (relatedStatus) {
      const status = document.createElement("p");
      status.className = "related-status";
      status.textContent = relatedStatus === "loading"
        ? "Finding related notes…"
        : relatedStatus;
      container.append(status);
    } else if (!related.length) {
      const status = document.createElement("p");
      status.className = "related-status";
      status.textContent = "No related notes found yet.";
      container.append(status);
    }
  }
}

async function requestDocumentFile(itemId) {
  let path = `/items/${itemId}/file`;
  if (state.spaceId) path += `?space_id=${encodeURIComponent(state.spaceId)}`;
  const response = await fetch(`${API}${path}`, {
    headers: { "X-API-Key": apiKey() },
  });
  if (!response.ok) {
    let message = `Could not open document (${response.status})`;
    try { message = (await response.json()).detail || message; } catch { /* use status message */ }
    throw new Error(message);
  }
  return response.blob();
}

function documentFileName(item) {
  if (item?.source_uri) {
    try {
      const source = new URL(item.source_uri);
      const pathName = source.pathname.split("/").pop();
      if (pathName) return decodeURIComponent(pathName.replace(/^[a-f0-9]{32}_/i, ""));
    } catch { /* keep the item title */ }
  }
  return item?.title || "Document";
}

async function openDocumentPreview({ item = null, file = null, jobId = null, status = "Saved in this space" }) {
  if ($("#document-viewer-dialog").open) $("#document-viewer-dialog").close();
  const name = file?.name || documentFileName(item);
  const isPdf = name.toLocaleLowerCase().endsWith(".pdf");
  let previewUrl = null;
  let content = item?.content || "";
  if (isPdf) {
    const blob = file || await requestDocumentFile(item.id);
    previewUrl = URL.createObjectURL(blob);
  } else if (file) {
    content = await file.text();
  }

  if (state.documentPreview?.url) URL.revokeObjectURL(state.documentPreview.url);
  state.documentPreview = { itemId: item?.id || null, jobId, url: previewUrl };
  $("#document-viewer-name").textContent = name;
  $("#document-viewer-status").textContent = status;
  $("#document-page").replaceChildren();
  if (isPdf && previewUrl) {
    const frame = document.createElement("iframe");
    frame.title = `PDF preview: ${name}`;
    frame.src = previewUrl;
    $("#document-page").append(frame);
  } else {
    const paper = document.createElement("article");
    paper.className = "document-text-preview";
    const heading = document.createElement("h1");
    heading.textContent = item?.title || name.replace(/\.[^.]+$/, "");
    const text = document.createElement("pre");
    text.textContent = content || "No text could be extracted from this document.";
    paper.append(heading, text);
    $("#document-page").append(paper);
  }
  $("#document-extracted").textContent = content
    ? content.slice(0, 12000)
    : isPdf ? "Text extraction is still in progress." : "No extracted text is available.";
  $("#document-related").replaceChildren();
  if (item) {
    try {
      const related = await request(`/items/${item.id}/related?limit=6`);
      if (related.length) {
        for (const hit of related) {
          const link = document.createElement("button");
          link.className = "related-link";
          link.textContent = hit.item.title;
          link.addEventListener("click", () => {
            $("#document-viewer-dialog").close();
            selectItem(hit.item.id);
          });
          $("#document-related").append(link);
        }
      } else {
        $("#document-related").textContent = "No related notes yet.";
      }
    } catch (error) {
      $("#document-related").textContent = `Could not load related notes: ${error.message}`;
    }
  } else {
    $("#document-related").textContent = "Related ideas will appear after indexing completes.";
  }
  $("#document-viewer-dialog").showModal();
}

async function openSavedDocument(item) {
  try {
    await openDocumentPreview({ item });
  } catch (error) {
    toast(error.message);
  }
}

function openLinkDialog(source) {
  const targets = state.graph.nodes.filter((node) => node.id !== source.id);
  if (!targets.length) {
    toast("Add another node before creating a connection");
    return;
  }
  state.linkSourceId = source.id;
  state.linkTargetId = null;
  $("#link-mode-banner").classList.remove("hidden");
  toast("Choose the target node on the graph");
}

function itemTitle(id) {
  return state.graph.nodes.find((node) => node.id === id)?.title || "Selected node";
}

function cancelLinkMode() {
  state.linkSourceId = null;
  state.linkTargetId = null;
  $("#link-mode-banner").classList.add("hidden");
}

function openNodeEditor(item) {
  state.selected = item;
  $("#node-edit-title").value = item.title;
  $("#node-edit-content").value = item.content;
  $("#node-edit-message").textContent = "";
  $("#node-edit-dialog").showModal();
}

function openDecisionEditor(decision) {
  state.editingDecision = decision;
  $("#decision-edit-question").value = decision.question;
  $("#decision-edit-choice").value = decision.choice;
  $("#decision-edit-rationale").value = decision.rationale;
  $("#decision-edit-status").value = decision.status;
  $("#decision-edit-outcome").value = decision.outcome || "";
  const revisit = decision.revisit_at ? new Date(decision.revisit_at) : null;
  if (revisit && !Number.isNaN(revisit.valueOf())) {
    revisit.setMinutes(revisit.getMinutes() - revisit.getTimezoneOffset());
    $("#decision-edit-revisit").value = revisit.toISOString().slice(0, 16);
  } else {
    $("#decision-edit-revisit").value = "";
  }
  $("#decision-edit-message").textContent = "";
  $("#decision-edit-dialog").showModal();
}

async function deleteNode(item) {
  if (!(await askConfirmation(
    `Delete “${item.title}” and its connections? This cannot be undone.`,
    "Delete this node?",
  ))) return;
  try {
    await request(`/items/${item.id}`, { method: "DELETE" });
    state.graph.nodes = state.graph.nodes.filter((node) => node.id !== item.id);
    state.graph.edges = state.graph.edges.filter(
      (edge) => edge.source !== item.id && edge.target !== item.id,
    );
    state.selected = null;
    $("#close-detail").click();
    renderGraph(state.graph);
    toast("Node deleted");
    void loadGraph();
  } catch (error) {
    toast(error.message);
  }
}

function openEdgeEditor(edge) {
  state.editingEdge = edge;
  const suggested = edge.kind === "semantic";
  $("#edge-edit-title").textContent = suggested ? "Suggested connection" : "Edit the relationship";
  $("#edge-edit-hint").textContent = suggested
    ? "Save to accept this suggestion as a connection, or delete it to dismiss the suggestion."
    : "Rename this connection or remove it from the graph.";
  $("#edge-endpoints").textContent =
    `${itemTitle(edge.source)}  →  ${itemTitle(edge.target)}`;
  $("#edge-edit-label").value = edge.label || "";
  $("#edge-edit-form").querySelector(".form-message")?.replaceChildren();
  $("#edge-edit-dialog").showModal();
}

async function loadTimeline() {
  const list = $("#timeline-list");
  list.replaceChildren();
  try {
    const items = await request("/timeline?limit=150");
    if (!items.length) return empty(list, "Nothing in your timeline yet.");
    for (const item of items) {
      const card = document.createElement("article"); card.className = "timeline-card";
      card.innerHTML = `<div class="timeline-date"></div><h3></h3><p></p>`;
      card.querySelector(".timeline-date").textContent = shortDate(item.captured_at);
      card.querySelector("h3").textContent = item.title;
      card.querySelector("p").textContent = item.excerpt;
      card.addEventListener("click", () => selectItem(item.id));
      list.append(card);
    }
  } catch (error) { empty(list, error.message); }
}

async function loadConnections() {
  const savedList = $("#saved-connection-list");
  const suggestedList = $("#suggested-connection-list");
  const spaceId = state.spaceId;
  const requestId = ++state.connectionsRequestId;
  if (state.graphCache.has(spaceId)) {
    renderSavedConnections();
  } else {
    savedList.replaceChildren();
    empty(savedList, "Loading saved connections…");
    void loadGraph(false).then((loaded) => {
      if (state.spaceId !== spaceId) return;
      if (loaded) renderSavedConnections();
      else {
        savedList.replaceChildren();
        empty(savedList, "Could not load saved connections. Try refreshing the graph.");
      }
    });
  }
  suggestedList.replaceChildren();
  empty(suggestedList, "Looking for ideas worth connecting…");
  try {
    const pairs = await request("/connections/forgotten?limit=30");
    if (state.spaceId !== spaceId || requestId !== state.connectionsRequestId) return;
    suggestedList.replaceChildren();
    if (!pairs.length) {
      return empty(
        suggestedList,
        "No suggestions yet. Mnemosyne looks for similar, indexed notes captured at least 30 days apart that are not already linked.",
      );
    }
    for (const pair of pairs) {
      const card = document.createElement("article"); card.className = "connection-card";
      card.innerHTML = `<span class="similarity"></span><div class="connection-pair"><div class="connection-note"><strong></strong><small></small></div><div class="connection-arrow">↔</div><div class="connection-note"><strong></strong><small></small></div></div><p class="explanation"></p><button class="button secondary suggestion-connect" type="button">Connect these notes</button>`;
      card.querySelector(".similarity").textContent = `${Math.round(pair.similarity * 100)}%`;
      const notes = card.querySelectorAll(".connection-note");
      notes[0].querySelector("strong").textContent = pair.left.title;
      notes[0].querySelector("small").textContent = "Earlier thought";
      notes[1].querySelector("strong").textContent = pair.right.title;
      notes[1].querySelector("small").textContent = "Later thought";
      card.querySelector(".explanation").textContent = pair.explanation;
      card.addEventListener("click", () => selectItem(pair.left.id));
      card.querySelector(".suggestion-connect").addEventListener("click", async (event) => {
        event.stopPropagation();
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await request(`/items/${pair.left.id}/links/${pair.right.id}`, { method: "POST" });
          if (state.spaceId !== spaceId) return;
          if (!state.graph.edges.some((edge) =>
            edge.kind !== "semantic"
            && ((edge.source === pair.left.id && edge.target === pair.right.id)
              || (edge.source === pair.right.id && edge.target === pair.left.id)))) {
            state.graph.edges.push({
              source: pair.left.id,
              target: pair.right.id,
              kind: "manual",
              label: null,
            });
          }
          renderGraph(state.graph);
          renderSavedConnections();
          card.remove();
          if (!suggestedList.children.length) {
            empty(suggestedList, "You’ve reviewed all current suggestions.");
          }
          toast("Connection saved");
        } catch (error) {
          button.disabled = false;
          toast(error.message);
        }
      });
      suggestedList.append(card);
    }
  } catch (error) {
    if (state.spaceId === spaceId && requestId === state.connectionsRequestId) {
      suggestedList.replaceChildren();
      empty(suggestedList, `Could not load suggestions: ${error.message}`);
    }
  }
}

function renderSavedConnections() {
  const list = $("#saved-connection-list");
  list.replaceChildren();
  const nodes = new Map(state.graph.nodes.map((node) => [node.id, node]));
  const edges = state.graph.edges.filter(
    (edge) => edge.kind !== "semantic" && edge.kind !== "suppressed_semantic",
  );
  $("#saved-connection-count").textContent = String(edges.length);
  if (!edges.length) {
    empty(list, "No saved links yet. Connect two notes from the graph, or accept a suggestion below.");
    return;
  }
  for (const edge of edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) continue;
    const card = document.createElement("article");
    card.className = "connection-card saved-connection-card";
    card.innerHTML = `<div class="connection-pair"><button class="connection-note" type="button"><strong></strong><small>Open note</small></button><div class="connection-arrow">↔</div><button class="connection-note" type="button"><strong></strong><small>Open note</small></button></div><p class="explanation"></p>`;
    const notes = card.querySelectorAll(".connection-note");
    notes[0].querySelector("strong").textContent = source.title;
    notes[1].querySelector("strong").textContent = target.title;
    notes[0].addEventListener("click", () => selectItem(source.id));
    notes[1].addEventListener("click", () => selectItem(target.id));
    card.querySelector(".explanation").textContent = edge.label || "Saved connection";
    list.append(card);
  }
}

async function loadDecisions() {
  const list = $("#decision-list");
  list.replaceChildren();
  try {
    const decisions = await request("/decisions");
    state.decisions = decisions;
    if (!decisions.length) return empty(list, "No decisions logged yet. Record the question and the reasoning behind your choice.");
    for (const decision of decisions) {
      const card = document.createElement("article"); card.className = "decision-card";
      const status = decision.status === "active" ? "Active" : decision.status;
      card.innerHTML = `<div class="card-kicker"></div><h3></h3><p></p><div class="card-meta"><span></span><span></span></div>`;
      card.querySelector(".card-kicker").textContent = status;
      card.querySelector("h3").textContent = decision.question;
      card.querySelector("p").textContent = `${decision.choice}${decision.rationale ? ` — ${decision.rationale}` : ""}`;
      card.querySelector(".card-meta span:first-child").textContent = `Logged ${niceDate(decision.created_at)}`;
      card.querySelector(".card-meta span:last-child").textContent = decision.revisit_at ? `Revisit ${niceDate(decision.revisit_at)}` : "No revisit date";
      card.addEventListener("click", () => selectItem(decision.item_id));
      list.append(card);
    }
  } catch (error) { empty(list, error.message); }
}

function empty(container, message) {
  const node = document.createElement("div"); node.className = "empty-state"; node.textContent = message;
  container.append(node);
}

function renderResults(hits) {
  const list = $("#search-results");
  list.replaceChildren();
  if (!hits.length) return empty(list, "No matches yet. Try another phrase or capture more context.");
  for (const hit of hits) {
    const item = hit.item;
    state.itemsById.set(item.id, item);
    const card = document.createElement("article"); card.className = "result-card";
    card.innerHTML = `<div class="card-kicker"></div><h3></h3><p></p><div class="card-meta"><span></span><span></span></div>`;
    card.querySelector(".card-kicker").textContent = item.type;
    card.querySelector("h3").textContent = item.title;
    card.querySelector("p").textContent = searchExcerpt(item.content, $("#search-query").value);
    card.querySelector(".card-meta span:first-child").textContent = niceDate(item.captured_at);
    card.querySelector(".card-meta span:last-child").textContent =
      hit.matched_by.length > 1 ? "Text + vector"
        : hit.matched_by[0] === "vector" ? "Vector similarity" : "Text match";
    card.addEventListener("click", () => selectItem(item.id));
    list.append(card);
  }
}

function searchExcerpt(content, query) {
  const text = content.trim();
  const matchAt = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  const start = matchAt > 90 ? matchAt - 70 : 0;
  const excerpt = text.slice(start, start + 240);
  return `${start ? "… " : ""}${excerpt}${start + excerpt.length < text.length ? " …" : ""}`;
}

async function runSearch(query, mode = state.searchMode) {
  const requestId = ++state.searchRequestId;
  const startedAt = performance.now();
  $("#search-welcome").classList.add("hidden");
  $("#search-results").replaceChildren();
  $("#search-meta").textContent = "Searching this space…";
  $("#search-results").setAttribute("aria-busy", "true");
  empty($("#search-results"), "Searching your memory…");
  try {
    const hits = await request(
      `/search?q=${encodeURIComponent(query)}&limit=30&mode=${encodeURIComponent(mode)}`,
    );
    if (requestId !== state.searchRequestId) return;
    const modeLabel = mode === "text" ? "Text"
      : mode === "vector" ? "Vector" : "Hybrid";
    const duration = Math.max(1, Math.round(performance.now() - startedAt));
    $("#search-meta").textContent =
      `${hits.length} ${hits.length === 1 ? "result" : "results"} · ${modeLabel} · ${duration} ms`;
    renderResults(hits);
    $("#search-welcome").classList.add("hidden");
  } catch (error) {
    if (requestId !== state.searchRequestId) return;
    $("#search-meta").textContent = error.message;
    $("#search-results").replaceChildren();
    $("#search-welcome").classList.add("hidden");
  } finally {
    if (requestId === state.searchRequestId) {
      $("#search-results").setAttribute("aria-busy", "false");
    }
  }
}

function openCapture() {
  $("#capture-message").textContent = "";
  updateCaptureWordCount();
  $("#capture-dialog").showModal();
  $("#capture-content").focus();
}

function updateCaptureWordCount() {
  const count = $("#capture-content").value.trim().split(/\s+/).filter(Boolean).length;
  $("#capture-word-count").textContent = `${count} ${count === 1 ? "word" : "words"}`;
}

async function renderCapturePreview() {
  const content = $("#capture-content").value.trim();
  if (!content) {
    $("#capture-message").textContent = "Write something before previewing it.";
    return;
  }
  const button = $("#preview-capture");
  button.disabled = true;
  button.textContent = "Interpreting…";
  $("#capture-message").textContent = "Building a draft from your paragraph…";
  try {
    const draft = await request("/drafts", {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    state.pendingCapture = {
      title: draft.title,
      model: draft.model,
      content,
      source: $("#capture-source").value.trim(),
      nodes: draft.nodes.map((node) => ({ ...node, selected: true })),
      relationships: draft.relationships.map((relationship) => ({ ...relationship, selected: true })),
      questions: draft.questions,
      previewView: "map",
      activeSelection: { type: "root" },
      mapPositions: {},
    };
    renderDraftPreview();
    $("#capture-message").textContent = "";
    $("#map-message").textContent = "";
    $("#capture-dialog").close();
    $("#map-preview-dialog").showModal();
  } catch (error) {
    $("#capture-message").textContent = error.message;
  } finally {
    button.disabled = false;
    button.innerHTML = "Shape into a map <span>↗</span>";
  }
}

function draftSvgElement(svg, name, attributes = {}) {
  const element = document.createElementNS(svg.namespaceURI, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function draftMapPoint(index, total) {
  const center = { x: 550, y: 310 };
  if (index < 8) {
    const ringSize = Math.min(total, 8);
    const angle = (index / ringSize) * Math.PI * 2 - Math.PI / 2;
    return {
      x: center.x + Math.cos(angle) * 265,
      y: center.y + Math.sin(angle) * 170,
    };
  }
  const outerIndex = index - 8;
  const outerCount = total - 8;
  const angle = (outerIndex / outerCount) * Math.PI * 2 - Math.PI / 2;
  return {
    x: center.x + Math.cos(angle) * 465,
    y: center.y + Math.sin(angle) * 245,
  };
}

function draftCanvasPoint(event, svg, pending) {
  const viewportPoint = eventPointInSvg(event, svg);
  if (!viewportPoint) return null;
  const scale = pending.mapScale || 1;
  return {
    x: (viewportPoint.x - 550 - (pending.mapOffsetX || 0)) / scale + 550,
    y: (viewportPoint.y - 310 - (pending.mapOffsetY || 0)) / scale + 310,
  };
}

function applyDraftMapTransform(pending, svg) {
  const drawing = svg.querySelector(".draft-map-drawing");
  if (!drawing) return;
  drawing.setAttribute(
    "transform",
    `translate(${550 + (pending.mapOffsetX || 0)} ${310 + (pending.mapOffsetY || 0)}) scale(${pending.mapScale || 1}) translate(-550 -310)`,
  );
}

function zoomDraftMap(pending, svg, factor, anchorX = 550, anchorY = 310) {
  const previousScale = pending.mapScale || 1;
  const nextScale = Math.max(.45, Math.min(3, previousScale * factor));
  if (nextScale === previousScale) return;
  const ratio = nextScale / previousScale;
  pending.mapOffsetX = anchorX - 550 - ratio * (anchorX - 550 - (pending.mapOffsetX || 0));
  pending.mapOffsetY = anchorY - 310 - ratio * (anchorY - 310 - (pending.mapOffsetY || 0));
  pending.mapScale = nextScale;
  applyDraftMapTransform(pending, svg);
  const level = $("#draft-map-zoom-level");
  if (level) level.textContent = `${Math.round(nextScale * 100)}%`;
}

function setupDraftCanvas(pending, svg) {
  let pan = null;
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const anchor = eventPointInSvg(event, svg);
    if (anchor) zoomDraftMap(pending, svg, Math.exp(-event.deltaY * .001), anchor.x, anchor.y);
  }, { passive: false });
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".draft-map-node, .draft-map-relationship")) return;
    const point = eventPointInSvg(event, svg);
    if (!point) return;
    pan = {
      point,
      offsetX: pending.mapOffsetX || 0,
      offsetY: pending.mapOffsetY || 0,
      pointerId: event.pointerId,
    };
    svg.setPointerCapture(event.pointerId);
    svg.classList.add("panning");
  });
  svg.addEventListener("pointermove", (event) => {
    if (!pan || pan.pointerId !== event.pointerId) return;
    const point = eventPointInSvg(event, svg);
    if (!point) return;
    const scale = pending.mapScale || 1;
    pending.mapOffsetX = Math.max(-900, Math.min(900,
      pan.offsetX + (point.x - pan.point.x) / scale));
    pending.mapOffsetY = Math.max(-500, Math.min(500,
      pan.offsetY + (point.y - pan.point.y) / scale));
    applyDraftMapTransform(pending, svg);
  });
  const finishPan = () => {
    pan = null;
    svg.classList.remove("panning");
  };
  svg.addEventListener("pointerup", finishPan);
  svg.addEventListener("pointercancel", finishPan);
}

function renderDraftGraph(pending, svg) {
  svg.replaceChildren();
  pending.mapScale = pending.mapScale || 1;
  const rootId = "root";
  const rootPosition = pending.mapPositions.root || { x: 550, y: 310 };
  const draftNodes = pending.nodes;
  const draftIds = new Set(draftNodes.map((node) => node.id));
  const externalIds = new Set();
  for (const relationship of pending.relationships) {
    for (const endpoint of [relationship.source, relationship.target]) {
      if (endpoint !== rootId && !draftIds.has(endpoint)) externalIds.add(endpoint);
    }
  }
  const externalNodes = [...externalIds]
    .map((id) => state.graph.nodes.find((node) => node.id === id))
    .filter(Boolean);
  const mapNodes = [
    ...draftNodes.map((node) => ({ ...node, external: false })),
    ...externalNodes.map((node) => ({ ...node, external: true })),
  ];
  const positions = new Map([[rootId, rootPosition]]);
  mapNodes.forEach((node, index) => {
    positions.set(
      node.id,
      pending.mapPositions[node.id] || draftMapPoint(index, mapNodes.length),
    );
  });
  const edgeReferences = [];
  const drawing = draftSvgElement(svg, "g", { class: "draft-map-drawing" });
  const edgeLayer = draftSvgElement(svg, "g", { class: "draft-map-edges" });
  drawing.append(edgeLayer);
  svg.append(drawing);

  pending.relationships.forEach((relationship) => {
    const from = positions.get(relationship.source);
    const to = positions.get(relationship.target);
    if (!from || !to) return;
    const group = draftSvgElement(drawing, "g", {
      class: `draft-map-relationship${relationship.selected ? "" : " excluded"}`,
      role: "button",
      tabindex: "0",
      "aria-label": `Edit connection: ${relationship.label || "unnamed connection"}`,
    });
    const line = draftSvgElement(drawing, "line", {
      x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: "draft-map-edge",
    });
    const hit = draftSvgElement(drawing, "line", {
      x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: "draft-map-edge-hit",
    });
    const label = draftSvgElement(drawing, "text", {
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2 - 7,
      class: "draft-map-edge-label",
    });
    label.textContent = relationship.label.trim();
    group.append(line, hit, label);
    const selectRelationship = () => {
      pending.activeSelection = { type: "relationship", relationship };
      setDraftMapSelection(pending, svg, group);
    };
    group.addEventListener("click", selectRelationship);
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectRelationship();
      }
    });
    edgeLayer.append(group);
    edgeReferences.push({ group, line, hit, label, relationship });
  });

  const updateEdges = (nodeId) => {
    for (const edge of edgeReferences) {
      if (edge.relationship.source !== nodeId && edge.relationship.target !== nodeId) continue;
      const from = positions.get(edge.relationship.source);
      const to = positions.get(edge.relationship.target);
      if (!from || !to) continue;
      for (const line of [edge.line, edge.hit]) {
        line.setAttribute("x1", from.x);
        line.setAttribute("y1", from.y);
        line.setAttribute("x2", to.x);
        line.setAttribute("y2", to.y);
      }
      edge.label.setAttribute("x", String((from.x + to.x) / 2));
      edge.label.setAttribute("y", String((from.y + to.y) / 2 - 7));
    }
  };
  const items = [
    { id: rootId, title: pending.title || "Main note", kind: "MAIN NOTE", root: true },
    ...mapNodes.map((node) => ({
      id: node.id,
      title: node.title || "Untitled node",
      kind: node.external ? node.type : node.kind,
      external: node.external,
    })),
  ];
  items.forEach((item) => {
    const point = positions.get(item.id);
    const selected = pending.activeSelection?.type === "root" && item.root
      || pending.activeSelection?.type === "node" && pending.activeSelection.id === item.id
      || pending.activeSelection?.type === "external" && pending.activeSelection.id === item.id;
    const group = draftSvgElement(drawing, "g", {
      class: `draft-map-node${item.root ? " root" : ""}${item.external ? " external" : ""}${selected ? " selected" : ""}${item.root || item.external || draftNodes.find((node) => node.id === item.id)?.selected ? "" : " excluded"}`,
      transform: `translate(${point.x} ${point.y})`,
      "data-draft-id": item.id,
      role: "button",
      tabindex: "0",
      "aria-label": `${item.root ? "Edit main note" : item.external ? "Existing note" : "Edit topic"}: ${item.title}`,
    });
    const color = item.external ? COLORS.bookmark : COLORS.note;
    group.append(
      draftSvgElement(svg, "circle", {
        r: 14, fill: color, class: "draft-map-node-halo",
      }),
      draftSvgElement(svg, "circle", {
        r: 6, fill: color, class: "draft-map-node-core",
      }),
    );
    const eyebrow = draftSvgElement(svg, "text", {
      x: 21, y: "-5", class: "draft-map-node-kind",
    });
    eyebrow.textContent = item.kind || "TOPIC";
    const title = draftSvgElement(svg, "text", {
      x: 21, y: 11, class: "draft-map-node-title",
    });
    title.textContent = item.title.length > 25
      ? `${item.title.slice(0, 24)}…`
      : item.title;
    group.append(eyebrow, title);
    group.addEventListener("click", () => {
      if (group.dataset.dragged === "true") {
        delete group.dataset.dragged;
        return;
      }
      pending.activeSelection = item.root
        ? { type: "root" }
        : { type: item.external ? "external" : "node", id: item.id };
      setDraftMapSelection(pending, svg, group);
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        group.click();
      }
    });
    group.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || item.external) return;
      const start = draftCanvasPoint(event, svg, pending);
      if (!start) return;
      group.setPointerCapture(event.pointerId);
      group.dataset.dragged = "false";
      group._draftDrag = { start, point, pointerId: event.pointerId };
    });
    group.addEventListener("pointermove", (event) => {
      const drag = group._draftDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const current = draftCanvasPoint(event, svg, pending);
      if (!current) return;
      const dx = current.x - drag.start.x;
      const dy = current.y - drag.start.y;
      if (Math.hypot(dx, dy) < 3 && group.dataset.dragged !== "true") return;
      group.dataset.dragged = "true";
      const next = {
        x: Math.max(100, Math.min(1000, drag.point.x + dx)),
        y: Math.max(45, Math.min(575, drag.point.y + dy)),
      };
      positions.set(item.id, next);
      pending.mapPositions[item.id] = next;
      group.setAttribute("transform", `translate(${next.x} ${next.y})`);
      updateEdges(item.id);
    });
    const finishDrag = () => { group._draftDrag = null; };
    group.addEventListener("pointerup", finishDrag);
    group.addEventListener("pointercancel", finishDrag);
    drawing.append(group);
  });
  for (const edge of edgeReferences) {
    const selected = pending.activeSelection?.type === "relationship"
      && pending.activeSelection.relationship === edge.relationship;
    edge.group.classList.toggle("selected", selected);
  }
  if (!mapNodes.length) {
    const empty = draftSvgElement(drawing, "text", {
      x: "550", y: "450", class: "draft-map-empty",
    });
    empty.textContent = "Add a topic to begin building this map";
    drawing.append(empty);
  }
  applyDraftMapTransform(pending, svg);
}

function setDraftMapSelection(pending, svg, selectedElement) {
  svg.querySelectorAll(".draft-map-node, .draft-map-relationship").forEach((element) => {
    element.classList.remove("selected");
  });
  selectedElement.classList.add("selected");
  renderDraftInspector(pending, $("#draft-map-inspector"), svg);
}

function appendDraftField(container, labelText, control) {
  const field = document.createElement("label");
  field.className = "draft-inspector-field";
  if (control.type === "checkbox") field.classList.add("checkbox-field");
  const label = document.createElement("span");
  label.textContent = labelText;
  field.append(label, control);
  container.append(field);
}

function renderDraftInspector(pending, inspector, svg) {
  inspector.replaceChildren();
  const selection = pending.activeSelection || { type: "root" };
  const heading = document.createElement("div");
  heading.className = "draft-inspector-heading";
  const kicker = document.createElement("span");
  kicker.textContent = selection.type === "relationship" ? "CONNECTION" :
    selection.type === "root" ? "MAIN NOTE" : selection.type === "external" ? "SAVED NOTE" : "TOPIC";
  const title = document.createElement("strong");
  title.textContent = selection.type === "relationship" ? "Connection details" :
    selection.type === "root" ? "Edit the thought" : "Edit this node";
  heading.append(kicker, title);
  inspector.append(heading);

  const renderMap = () => renderDraftGraph(pending, svg);
  if (selection.type === "root") {
    const titleInput = document.createElement("input");
    titleInput.maxLength = 120;
    titleInput.value = pending.title;
    titleInput.setAttribute("aria-label", "Edit main note title");
    titleInput.addEventListener("input", () => {
      pending.title = titleInput.value;
      renderMap();
    });
    appendDraftField(inspector, "Title", titleInput);
    const content = document.createElement("textarea");
    content.rows = 7;
    content.maxLength = 20000;
    content.value = pending.content;
    content.setAttribute("aria-label", "Edit main note content");
    content.addEventListener("input", () => { pending.content = content.value; });
    appendDraftField(inspector, "Note", content);
    return;
  }
  if (selection.type === "external") {
    const existing = state.graph.nodes.find((node) => node.id === selection.id);
    const note = document.createElement("p");
    note.className = "draft-inspector-note";
    note.textContent = existing
      ? `${existing.title} is already in this space. Select a connection line to edit its relationship.`
      : "This saved note is not available in the current graph.";
    inspector.append(note);
    return;
  }
  if (selection.type === "relationship") {
    const relationship = selection.relationship;
    const include = document.createElement("input");
    include.type = "checkbox";
    include.checked = relationship.selected;
    include.addEventListener("change", () => {
      relationship.selected = include.checked;
      renderMap();
    });
    appendDraftField(inspector, "Include this connection", include);
    const options = [
      { id: "root", title: pending.title || "Main note" },
      ...pending.nodes.map((node) => ({ id: node.id, title: node.title || "Untitled node" })),
      ...state.graph.nodes.map((node) => ({ id: node.id, title: node.title })),
    ];
    for (const endpoint of ["source", "target"]) {
      const select = document.createElement("select");
      for (const option of options) {
        const element = document.createElement("option");
        element.value = option.id;
        element.textContent = option.title;
        select.append(element);
      }
      select.value = relationship[endpoint];
      select.addEventListener("change", () => {
        relationship[endpoint] = select.value;
        renderMap();
      });
      appendDraftField(inspector, endpoint === "source" ? "From" : "To", select);
    }
    const label = document.createElement("input");
    label.maxLength = 120;
    label.value = relationship.label;
    label.placeholder = "e.g. about";
    label.addEventListener("input", () => {
      relationship.label = label.value;
      renderMap();
    });
    appendDraftField(inspector, "Connection label", label);
    const evidence = document.createElement("p");
    evidence.className = "draft-inspector-note";
    evidence.textContent = `Evidence: ${relationship.evidence || "none"} · ${relationship.confidence} confidence`;
    inspector.append(evidence);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button secondary draft-inspector-remove";
    remove.textContent = "Remove connection";
    remove.addEventListener("click", () => {
      pending.relationships = pending.relationships.filter((item) => item !== relationship);
      pending.activeSelection = { type: "root" };
      renderDraftPreview();
    });
    inspector.append(remove);
    return;
  }

  const node = pending.nodes.find((candidate) => candidate.id === selection.id);
  if (!node) {
    pending.activeSelection = { type: "root" };
    renderDraftInspector(pending, inspector, svg);
    return;
  }
  const include = document.createElement("input");
  include.type = "checkbox";
  include.checked = node.selected;
  include.addEventListener("change", () => {
    node.selected = include.checked;
    renderMap();
  });
  appendDraftField(inspector, "Include this node", include);
  const titleInput = document.createElement("input");
  titleInput.maxLength = 120;
  titleInput.value = node.title;
  titleInput.addEventListener("input", () => {
    node.title = titleInput.value;
    renderMap();
  });
  appendDraftField(inspector, "Name", titleInput);
  const kind = draftNodeKindEditor(node.kind, (value) => {
    node.kind = value;
    renderMap();
  });
  appendDraftField(inspector, "Type", kind);
  const description = document.createElement("textarea");
  description.rows = 4;
  description.maxLength = 800;
  description.value = node.description;
  description.placeholder = "Describe this idea";
  description.addEventListener("input", () => { node.description = description.value; });
  appendDraftField(inspector, "Description", description);
  const evidence = document.createElement("p");
  evidence.className = "draft-inspector-note";
  evidence.textContent = `Evidence: ${node.evidence.join(" / ") || "add a short description"}`;
  inspector.append(evidence);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button secondary draft-inspector-remove";
  remove.textContent = "Remove node";
  remove.addEventListener("click", () => {
    pending.nodes = pending.nodes.filter((item) => item !== node);
    pending.relationships = pending.relationships.filter(
      (relationship) => relationship.source !== node.id && relationship.target !== node.id,
    );
    pending.activeSelection = { type: "root" };
    renderDraftPreview();
  });
  inspector.append(remove);
}

function addDraftNode(pending) {
  if (pending.nodes.length >= 20) {
    toast("A draft can contain up to 20 new nodes");
    return;
  }
  const ids = new Set(pending.nodes.map((node) => node.id));
  let number = 1;
  while (ids.has(`n${number}`)) number += 1;
  const node = {
    id: `n${number}`, title: "New topic", kind: "topic",
    description: "", evidence: [], selected: true,
  };
  pending.nodes.push(node);
  pending.activeSelection = { type: "node", id: node.id };
  renderDraftPreview();
}

function addDraftRelationship(pending) {
  if (pending.relationships.length >= 24) {
    toast("A draft can contain up to 24 connections");
    return;
  }
  const target = pending.nodes.find((node) => node.selected)?.id || state.graph.nodes[0]?.id;
  if (!target) {
    toast("Add a topic before creating a connection");
    return;
  }
  const relationship = {
    source: "root", target, label: "", evidence: "", confidence: "medium", selected: true,
  };
  pending.relationships.push(relationship);
  pending.activeSelection = { type: "relationship", relationship };
  renderDraftPreview();
}

function renderDraftPreview() {
  const pending = state.pendingCapture;
  const preview = $("#map-preview-content");
  preview.replaceChildren();
  pending.previewView ||= "map";
  pending.activeSelection ||= { type: "root" };
  const modelInfo = document.createElement("p");
  modelInfo.className = "draft-model-info";
  modelInfo.textContent = pending.model === "inclusionai/ling-3.2-flash:free"
    ? "Generated by Ling 3.2 Flash (free)."
    : "Ling was unavailable; generated by the free NVIDIA backup.";
  const tabs = document.createElement("div");
  tabs.className = "draft-view-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Draft review mode");
  const mapTab = document.createElement("button");
  mapTab.type = "button";
  mapTab.className = "draft-view-tab";
  mapTab.textContent = "Map";
  mapTab.setAttribute("role", "tab");
  mapTab.setAttribute("aria-selected", String(pending.previewView === "map"));
  const detailsTab = document.createElement("button");
  detailsTab.type = "button";
  detailsTab.className = "draft-view-tab";
  detailsTab.textContent = "Details";
  detailsTab.setAttribute("role", "tab");
  detailsTab.setAttribute("aria-selected", String(pending.previewView === "details"));
  mapTab.addEventListener("click", () => {
    pending.previewView = "map";
    renderDraftPreview();
  });
  detailsTab.addEventListener("click", () => {
    pending.previewView = "details";
    renderDraftPreview();
  });
  tabs.append(mapTab, detailsTab);
  const toolbar = document.createElement("div");
  toolbar.className = "draft-map-toolbar";
  const mapHelp = document.createElement("span");
  mapHelp.textContent = "Scroll to zoom · Drag canvas to pan · Drag nodes to arrange";
  const zoomControls = document.createElement("div");
  zoomControls.className = "draft-map-zoom-controls";
  const zoomOut = document.createElement("button");
  zoomOut.type = "button";
  zoomOut.className = "button secondary";
  zoomOut.textContent = "−";
  zoomOut.setAttribute("aria-label", "Zoom out on preview map");
  const zoomLevel = document.createElement("span");
  zoomLevel.id = "draft-map-zoom-level";
  zoomLevel.textContent = `${Math.round((pending.mapScale || 1) * 100)}%`;
  const zoomIn = document.createElement("button");
  zoomIn.type = "button";
  zoomIn.className = "button secondary";
  zoomIn.textContent = "+";
  zoomIn.setAttribute("aria-label", "Zoom in on preview map");
  const resetZoom = document.createElement("button");
  resetZoom.type = "button";
  resetZoom.className = "button secondary";
  resetZoom.textContent = "Reset";
  resetZoom.setAttribute("aria-label", "Reset preview map zoom and position");
  zoomOut.addEventListener("click", () => zoomDraftMap(pending, svg, 1 / 1.2));
  zoomIn.addEventListener("click", () => zoomDraftMap(pending, svg, 1.2));
  resetZoom.addEventListener("click", () => {
    pending.mapScale = 1;
    pending.mapOffsetX = 0;
    pending.mapOffsetY = 0;
    applyDraftMapTransform(pending, svg);
    zoomLevel.textContent = "100%";
  });
  zoomControls.append(zoomOut, zoomLevel, zoomIn, resetZoom);
  const addMapNode = document.createElement("button");
  addMapNode.type = "button";
  addMapNode.className = "button secondary";
  addMapNode.textContent = "＋ Node";
  addMapNode.addEventListener("click", () => addDraftNode(pending));
  const addMapLink = document.createElement("button");
  addMapLink.type = "button";
  addMapLink.className = "button secondary";
  addMapLink.textContent = "＋ Connection";
  addMapLink.disabled = !pending.nodes.length && !state.graph.nodes.length;
  addMapLink.addEventListener("click", () => addDraftRelationship(pending));
  toolbar.append(mapHelp, zoomControls, addMapNode, addMapLink);
  const mapView = document.createElement("section");
  mapView.className = "draft-map-view";
  mapView.hidden = pending.previewView !== "map";
  const workspace = document.createElement("div");
  workspace.className = "draft-map-workspace";
  const canvasWrap = document.createElement("div");
  canvasWrap.className = "draft-map-canvas-wrap";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("draft-map-canvas");
  svg.setAttribute("viewBox", "0 0 1100 620");
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", "Editable preview of your note graph");
  const inspector = document.createElement("aside");
  inspector.className = "draft-map-inspector";
  inspector.id = "draft-map-inspector";
  canvasWrap.append(toolbar, svg);
  workspace.append(canvasWrap, inspector);
  mapView.append(workspace);
  const details = document.createElement("div");
  details.className = "draft-details-view";
  details.hidden = pending.previewView !== "details";
  preview.append(modelInfo, tabs, mapView, details);
  renderDraftGraph(pending, svg);
  setupDraftCanvas(pending, svg);
  renderDraftInspector(pending, inspector, svg);

  const root = document.createElement("section");
  root.className = "map-node-preview";
  const rootLabel = document.createElement("label");
  rootLabel.textContent = "Main note";
  const rootTitle = document.createElement("input");
  rootTitle.maxLength = 120;
  rootTitle.value = pending.title;
  rootTitle.setAttribute("aria-label", "Edit main note title");
  rootTitle.addEventListener("input", () => { pending.title = rootTitle.value; });
  const rootContent = document.createElement("textarea");
  rootContent.rows = 7;
  rootContent.maxLength = 20000;
  rootContent.value = pending.content;
  rootContent.setAttribute("aria-label", "Edit main note content");
  rootContent.addEventListener("input", () => { pending.content = rootContent.value; });
  root.append(rootLabel, rootTitle, rootContent);
  details.append(root);

  if (pending.questions.length) {
    const questions = document.createElement("section");
    questions.className = "draft-questions";
    const heading = document.createElement("h3");
    heading.textContent = "Needs your clarification";
    const list = document.createElement("ul");
    for (const entry of pending.questions) {
      const question = document.createElement("li");
      question.textContent = entry.evidence
        ? `${entry.question} — “${entry.evidence}”`
        : entry.question;
      list.append(question);
    }
    questions.append(heading, list);
    details.append(questions);
  }

  const nodeHeading = document.createElement("div");
  nodeHeading.className = "draft-section-heading";
  const nodeTitle = document.createElement("strong");
  nodeTitle.textContent = "TOPICS AND ENTITIES";
  const addNode = document.createElement("button");
  addNode.type = "button";
  addNode.className = "button secondary";
  addNode.textContent = "＋ Add node";
  addNode.addEventListener("click", () => addDraftNode(pending));
  nodeHeading.append(nodeTitle, addNode);
  details.append(nodeHeading);

  for (const node of pending.nodes) {
    const card = document.createElement("section");
    card.className = "draft-node-card";
    const include = document.createElement("input");
    include.type = "checkbox";
    include.checked = node.selected;
    include.setAttribute("aria-label", `Include ${node.title}`);
    include.addEventListener("change", () => { node.selected = include.checked; });
    const fields = document.createElement("div");
    fields.className = "draft-node-fields";
    const title = document.createElement("input");
    title.maxLength = 120;
    title.value = node.title;
    title.setAttribute("aria-label", "Edit node title");
    title.addEventListener("input", () => { node.title = title.value; });
    const kind = draftNodeKindEditor(node.kind, (value) => {
      node.kind = value;
      evidence.textContent = `${node.kind.toLocaleUpperCase()} · Evidence: ${node.evidence.join(" / ") || "add a short description"}`;
    });
    const description = document.createElement("textarea");
    description.rows = 2;
    description.maxLength = 800;
    description.placeholder = "Describe this idea";
    description.value = node.description;
    description.setAttribute("aria-label", "Edit node description");
    description.addEventListener("input", () => { node.description = description.value; });
    const evidence = document.createElement("small");
    evidence.textContent = `${node.kind.toLocaleUpperCase()} · Evidence: ${node.evidence.join(" / ") || "add a short description"}`;
    fields.append(title, kind, description, evidence);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${node.title}`);
    remove.addEventListener("click", () => {
      pending.nodes = pending.nodes.filter((candidate) => candidate !== node);
      pending.relationships = pending.relationships.filter(
        (relationship) => relationship.source !== node.id && relationship.target !== node.id,
      );
      pending.activeSelection = { type: "root" };
      renderDraftPreview();
    });
    card.append(include, fields, remove);
    details.append(card);
  }

  const relationHeading = document.createElement("div");
  relationHeading.className = "draft-section-heading";
  const relationTitle = document.createElement("strong");
  relationTitle.textContent = "CONNECTIONS";
  const addRelation = document.createElement("button");
  addRelation.type = "button";
  addRelation.className = "button secondary";
  addRelation.textContent = "＋ Add connection";
  addRelation.disabled = pending.relationships.length >= 24
    || !pending.nodes.length && !state.graph.nodes.length;
  addRelation.addEventListener("click", () => addDraftRelationship(pending));
  relationHeading.append(relationTitle, addRelation);
  details.append(relationHeading);

  const endpointOptions = [
    { id: "root", title: pending.title || "Main note" },
    ...pending.nodes.map((node) => ({ id: node.id, title: node.title || "Untitled node" })),
    ...state.graph.nodes.map((node) => ({ id: node.id, title: node.title })),
  ];
  for (const relationship of pending.relationships) {
    const card = document.createElement("section");
    card.className = "draft-link-card";
    const include = document.createElement("input");
    include.type = "checkbox";
    include.checked = relationship.selected;
    include.setAttribute("aria-label", "Include this connection");
    include.addEventListener("change", () => { relationship.selected = include.checked; });
    const fields = document.createElement("div");
    fields.className = "draft-link-fields";
    for (const endpoint of ["source", "target"]) {
      const select = document.createElement("select");
      select.setAttribute("aria-label", `Connection ${endpoint}`);
      for (const option of endpointOptions) {
        const element = document.createElement("option");
        element.value = option.id;
        element.textContent = option.title;
        select.append(element);
      }
      select.value = relationship[endpoint];
      select.addEventListener("change", () => { relationship[endpoint] = select.value; });
      fields.append(select);
    }
    const label = document.createElement("input");
    label.maxLength = 120;
    label.placeholder = "Connection name (optional)";
    label.value = relationship.label;
    label.setAttribute("aria-label", "Edit connection name");
    label.addEventListener("input", () => { relationship.label = label.value; });
    const evidence = document.createElement("small");
    evidence.textContent = `Evidence · ${relationship.evidence || "add a reason for this connection"} · ${relationship.confidence} confidence`;
    fields.append(label, evidence);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remove connection");
    remove.addEventListener("click", () => {
      pending.relationships = pending.relationships.filter((candidate) => candidate !== relationship);
      pending.activeSelection = { type: "root" };
      renderDraftPreview();
    });
    card.append(include, fields, remove);
    details.append(card);
  }

  if (!pending.nodes.length && !pending.relationships.length) {
    const empty = document.createElement("p");
    empty.className = "map-link-preview unmatched";
    empty.textContent = "No separate topics or clear connections were found. You can still save the main note.";
    details.append(empty);
  }
}

async function runConcurrent(items, limit, operation) {
  let nextIndex = 0;
  const workerCount = Math.min(items.length, limit);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await operation(item);
    }
  }));
}

async function saveCapture() {
  const pending = state.pendingCapture;
  if (!pending) return;
  const button = $("#save-capture"); button.disabled = true;
  const buttonContent = button.innerHTML;
  button.textContent = "Saving map…";
  $("#map-message").textContent = "";
  let saved = null;
  let topicCount = 0;
  let connectionCount = 0;
  let skippedTopicCount = 0;
  let skippedConnectionCount = 0;
  const failedTopics = [];
  const failedConnections = [];
  const saveableNodes = [];
  for (const node of pending.nodes.filter((candidate) => candidate.selected)) {
    const title = node.title.trim();
    const description = node.description.trim();
    const kind = node.kind.trim();
    if (!title || !description || !kind || title.toLocaleLowerCase() === "new topic") {
      skippedTopicCount += 1;
      continue;
    }
    saveableNodes.push({ ...node, title, description, kind });
  }
  try {
    const noteType = pending.source ? "bookmark" : "note";
    const noteTitle = pending.title.trim();
    const noteExcerpt = pending.content.slice(0, 180);
    saved = state.graph.nodes.find(
      (node) => node.type === noteType
        && node.title.toLocaleLowerCase() === noteTitle.toLocaleLowerCase()
        && node.excerpt === noteExcerpt,
    ) || await request("/items", { method: "POST", body: JSON.stringify({
      type: noteType,
      title: noteTitle,
      content: pending.content,
      source_uri: pending.source || null,
    }) });
    const savedByDraftId = new Map([["root", saved]]);
    await runConcurrent(saveableNodes, 4, async (node) => {
      const { title, description } = node;
      if (title.toLocaleLowerCase() === saved.title.toLocaleLowerCase()) {
        savedByDraftId.set(node.id, saved);
        return;
      }
      const existing = state.graph.nodes.find(
        (candidate) => candidate.title.toLocaleLowerCase() === title.toLocaleLowerCase(),
      );
      try {
        const topic = existing || await request("/items", {
          method: "POST",
          body: JSON.stringify({
            type: "note",
            title,
            // Items deduplicate by content hash, so include the title to keep sibling nodes distinct.
            content: [
              `Topic: ${title}`,
              description,
              `Evidence: ${node.evidence.join(" / ")}`,
              `Captured from: ${saved.title}`,
            ].join("\n\n"),
            metadata: { draft_kind: node.kind, evidence: node.evidence },
          }),
        });
        savedByDraftId.set(node.id, topic);
        if (!existing) topicCount += 1;
      } catch (error) {
        failedTopics.push({ title, message: error.message });
      }
    });
    await runConcurrent(
      pending.relationships.filter((candidate) => candidate.selected),
      4,
      async (relationship) => {
        const source = savedByDraftId.get(relationship.source)
          || state.graph.nodes.find((node) => node.id === relationship.source);
        const target = savedByDraftId.get(relationship.target)
          || state.graph.nodes.find((node) => node.id === relationship.target);
        if (!source || !target || source.id === target.id) {
          skippedConnectionCount += 1;
          return;
        }
        const label = relationship.label.trim();
        const query = label ? `?label=${encodeURIComponent(label)}` : "";
        try {
          await request(`/items/${source.id}/links/${target.id}${query}`, { method: "POST" });
          connectionCount += 1;
        } catch (error) {
          failedConnections.push({
            source: source.title,
            target: target.title,
            message: error.message,
          });
        }
      },
    );
    const failures = [
      ...failedTopics.map((failure) => `${failure.title}: ${failure.message}`),
      ...failedConnections.map(
        (failure) => `${failure.source} → ${failure.target}: ${failure.message}`,
      ),
    ];
    if (failures.length) {
      await loadGraph();
      const visibleFailures = failures.slice(0, 3).join("; ");
      const remainingFailures = failures.length > 3
        ? `; and ${failures.length - 3} more`
        : "";
      $("#map-message").textContent =
        `Some map items could not be saved. ${visibleFailures}${remainingFailures}. ` +
        "Successfully saved items are kept; fix the listed items and retry.";
      toast(`Partial save: ${failures.length} item${failures.length === 1 ? "" : "s"} need attention`);
      return;
    }
    $("#map-preview-dialog").close();
    $("#capture-dialog").close();
    $("#capture-form").reset();
    state.graph.nodes = [
      {
        id: saved.id,
        title: saved.title,
        type: saved.type,
        captured_at: saved.captured_at,
        excerpt: noteExcerpt,
      },
      ...state.graph.nodes.filter((node) => node.id !== saved.id),
    ].slice(0, 200);
    renderGraph(state.graph);
    const summary = [
      `Saved${topicCount ? ` ${topicCount} topic${topicCount === 1 ? "" : "s"}` : ""}${connectionCount ? ` and ${connectionCount} connection${connectionCount === 1 ? "" : "s"}` : ""}`,
      skippedTopicCount ? `skipped ${skippedTopicCount} incomplete topic${skippedTopicCount === 1 ? "" : "s"}` : "",
      skippedConnectionCount
        ? `skipped ${skippedConnectionCount} connection${skippedConnectionCount === 1 ? "" : "s"} with unsaved endpoints`
        : "",
    ].filter(Boolean);
    toast(summary.join("; "));
    await loadGraph();
    state.pendingCapture = null;
  } catch (error) {
    $("#map-message").textContent = saved
      ? `The main note was saved, but the rest of the map could not be completed: ${error.message}`
      : error.message;
    if (saved) void loadGraph();
  }
  finally {
    button.disabled = false;
    button.innerHTML = buttonContent;
  }
}

$("#preview-capture").addEventListener("click", renderCapturePreview);
$("#capture-form").addEventListener("submit", (event) => event.preventDefault());
$("#save-capture").addEventListener("click", saveCapture);
$("#edit-capture").addEventListener("click", () => {
  if (state.pendingCapture) {
    $("#capture-content").value = state.pendingCapture.content;
    $("#capture-source").value = state.pendingCapture.source;
    updateCaptureWordCount();
  }
  $("#map-preview-dialog").close();
  $("#capture-dialog").showModal();
  $("#capture-content").focus();
});
$("#capture-content").addEventListener("input", updateCaptureWordCount);

$("#link-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#save-link");
  button.disabled = true;
  try {
    const label = $("#link-label").value.trim();
    const result = await request(
      `/items/${state.linkSourceId}/links/${state.linkTargetId}${label ? `?label=${encodeURIComponent(label)}` : ""}`,
      { method: "POST" },
    );
    $("#link-dialog").close();
    cancelLinkMode();
    if (result.created) {
      state.graph.edges.push({
        source: result.source,
        target: result.target,
        kind: "manual",
        score: 1,
        label: label || null,
      });
      renderGraph(state.graph);
    } else if (label) {
      const existing = state.graph.edges.find(
        (edge) => edge.kind === "manual"
          && edge.source === result.source && edge.target === result.target,
      );
      if (existing) existing.label = label;
      renderGraph(state.graph);
    }
    toast(result.created ? "Nodes connected" : "Connection label updated");
    void loadGraph();
  } catch (error) {
    $("#link-message").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#edge-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const edge = state.editingEdge;
  if (!edge) return;
  const button = $("#save-edge-edit");
  button.disabled = true;
  try {
    const label = $("#edge-edit-label").value.trim();
    const updated = await request(`/items/${edge.source}/links/${edge.target}?kind=${encodeURIComponent(edge.kind)}`, {
      method: "PATCH",
      body: JSON.stringify({ label: label || null }),
    });
    edge.kind = updated.kind;
    edge.source = updated.source;
    edge.target = updated.target;
    edge.label = label || null;
    $("#edge-edit-dialog").close();
    renderGraph(state.graph);
    toast("Connection updated");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

$("#delete-edge").addEventListener("click", async () => {
  const edge = state.editingEdge;
  if (!edge || !(await askConfirmation("This will remove the connection from the graph.", "Delete this connection?"))) return;
  try {
    await request(`/items/${edge.source}/links/${edge.target}?kind=${encodeURIComponent(edge.kind)}`, {
      method: "DELETE",
    });
    state.graph.edges = state.graph.edges.filter((candidate) => candidate !== edge);
    $("#edge-edit-dialog").close();
    renderGraph(state.graph);
    void loadGraph();
    toast("Connection deleted");
  } catch (error) {
    toast(error.message);
  }
});

$("#node-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const item = state.selected;
  if (!item) return;
  const button = $("#save-node-edit");
  button.disabled = true;
  try {
    const updated = await request(`/items/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: $("#node-edit-title").value.trim(),
        content: $("#node-edit-content").value.trim(),
      }),
    });
    $("#node-edit-dialog").close();
    state.selected = updated;
    const node = state.graph.nodes.find((entry) => entry.id === updated.id);
    if (node) {
      node.title = updated.title;
      node.excerpt = updated.content.slice(0, 180);
    }
    renderGraph(state.graph);
    const related = await request(`/items/${updated.id}/related?limit=4`).catch(() => []);
    renderDetail(updated, related);
    toast("Node updated");
    void loadGraph();
  } catch (error) {
    $("#node-edit-message").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#decision-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const decision = state.editingDecision;
  if (!decision) return;
  const button = $("#save-decision-edit");
  button.disabled = true;
  const revisit = $("#decision-edit-revisit").value;
  try {
    const updated = await request(`/decisions/${decision.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        question: $("#decision-edit-question").value.trim(),
        choice: $("#decision-edit-choice").value.trim(),
        rationale: $("#decision-edit-rationale").value.trim(),
        status: $("#decision-edit-status").value,
        outcome: $("#decision-edit-outcome").value.trim() || null,
        revisit_at: revisit ? new Date(revisit).toISOString() : null,
      }),
    });
    $("#decision-edit-dialog").close();
    state.decisions = state.decisions.map((entry) => entry.id === updated.id ? updated : entry);
    const item = await request(`/items/${updated.item_id}`);
    state.selected = item;
    renderGraph(state.graph);
    const related = await request(`/items/${item.id}/related?limit=4`).catch(() => []);
    renderDetail(item, related, updated);
    showView("decisions");
    toast("Decision updated");
  } catch (error) {
    $("#decision-edit-message").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

async function loadSpaces() {
  const spaces = await request("/spaces");
  state.spaces = spaces;
  if (!spaces.length) {
    state.spaceId = null;
    localStorage.removeItem("mnemosyne-space-id");
    $("#current-space-name").textContent = "Choose a space";
    renderSpacesHome();
    return;
  }
  if (!spaces.some((space) => space.id === state.spaceId)) {
    const personal = spaces.find((space) => space.id === DEFAULT_SPACE_ID) || spaces[0];
    state.spaceId = personal.id;
    localStorage.setItem("mnemosyne-space-id", state.spaceId);
  }
  const active = spaces.find((space) => space.id === state.spaceId);
  $("#current-space-name").textContent = active?.name || "Choose a space";
  renderSpacesHome();
}

function renderSpacesHome(query = "") {
  const cards = $("#space-cards");
  if (!cards) return;
  cards.replaceChildren();
  const search = query.trim().toLocaleLowerCase();
  const matches = state.spaces
    .filter((space) => space.name.toLocaleLowerCase().includes(search))
    .sort((left, right) =>
      Number(right.id === state.spaceId) - Number(left.id === state.spaceId)
      || left.name.localeCompare(right.name));

  for (const space of matches) {
    const isLastOpened = space.id === state.spaceId;
    const card = document.createElement("article");
    card.className = `space-card${isLastOpened ? " last-opened" : ""}`;
    card.setAttribute("aria-current", String(isLastOpened));
    const top = document.createElement("div");
    top.className = "space-card-top";
    const marker = document.createElement("span");
    marker.textContent = isLastOpened ? "LAST OPENED" : "SPACE";
    const icon = document.createElement("span");
    icon.className = "space-card-mark";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "M";
    top.append(marker, icon);
    const title = document.createElement("h2");
    title.textContent = space.name;
    const count = space.item_count || 0;
    const meta = document.createElement("p");
    meta.className = "space-card-meta";
    meta.textContent = `${count} ${count === 1 ? "memory" : "memories"}`;
    const activity = document.createElement("p");
    activity.className = "space-card-activity";
    activity.textContent = space.last_activity
      ? `Updated ${shortDate(space.last_activity)}`
      : "Ready for your first thought";
    const open = document.createElement("button");
    open.type = "button";
    open.className = `button ${isLastOpened ? "primary" : "secondary"} space-card-open`;
    open.textContent = isLastOpened ? "Continue" : "Open space";
    open.addEventListener("click", () => selectSpace(space.id));
    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "button secondary";
    manage.textContent = "Manage";
    manage.setAttribute("aria-label", `Manage ${space.name}`);
    manage.addEventListener("click", () => openSpaceDialog(space));
    const actions = document.createElement("div");
    actions.className = "space-card-actions";
    actions.append(open, manage);
    card.append(top, title, meta, activity, actions);
    cards.append(card);
  }

  $("#spaces-count").textContent = `${state.spaces.length} ${state.spaces.length === 1 ? "space" : "spaces"}`;
  const empty = $("#spaces-empty");
  if (!state.spaces.length) {
    empty.textContent = "No spaces yet. Create one to start organizing your notes.";
    empty.classList.remove("hidden");
  } else if (!matches.length) {
    empty.textContent = `No spaces match “${query.trim()}”. Try another name.`;
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
  }
}

function selectSpace(spaceId) {
  const changed = state.spaceId !== spaceId;
  state.spaceId = spaceId;
  localStorage.setItem("mnemosyne-space-id", spaceId);
  if (changed) {
    state.detailRequestId += 1;
    state.searchRequestId += 1;
    state.connectionsRequestId += 1;
    state.selected = null;
    state.graph = state.graphLoadedSpaces.has(spaceId)
      ? state.graphCache.get(spaceId) || { nodes: [], edges: [] }
      : { nodes: [], edges: [] };
    state.itemsById.clear();
    state.relatedById.clear();
    state.relatedErrors.clear();
    state.decisions = [];
    $("#search-query").value = "";
    $("#search-clear").classList.add("hidden");
    $("#search-results").replaceChildren();
    $("#search-results").setAttribute("aria-busy", "false");
    $("#search-meta").textContent = "Search is limited to your current space.";
    $("#search-welcome").classList.remove("hidden");
  }
  const active = state.spaces.find((space) => space.id === spaceId);
  if (active) $("#current-space-name").textContent = active.name;
  $("#close-detail").click();
  showView("graph");
}

async function openSpaceDialog(space = null) {
  if (space) {
    try {
      const spaces = await request("/spaces");
      state.spaces = spaces;
      space = spaces.find((entry) => entry.id === space.id);
      if (!space) {
        toast("This space is no longer available.");
        return;
      }
      if (state.view === "spaces") renderSpacesHome($("#spaces-home-search").value);
      const active = spaces.find((entry) => entry.id === state.spaceId);
      if (active) $("#current-space-name").textContent = active.name;
    } catch (error) {
      toast(error.message);
      return;
    }
  }
  state.editingSpaceId = space?.id || null;
  $("#space-name").value = space?.name || "";
  $("#space-dialog-title").textContent = space ? "Manage this space" : "Create a space";
  $("#space-dialog-description").textContent = space
    ? "Rename this space or review its deletion options."
    : "Each space keeps its notes, decisions, documents, and connections separate.";
  $("#save-space").textContent = space ? "Save changes" : "Create space";
  const deleteButton = $("#delete-space");
  const isDefault = space?.id === DEFAULT_SPACE_ID;
  const hasItems = (space?.item_count || 0) > 0;
  deleteButton.classList.toggle("hidden", !space);
  deleteButton.disabled = !space || isDefault || hasItems;
  const managementHint = $("#space-management-hint");
  managementHint.classList.toggle("hidden", !space);
  managementHint.textContent = !space
    ? ""
    : isDefault
      ? "The Personal space is your default space and cannot be deleted."
      : hasItems
        ? "A space can only be deleted when it is empty. Delete its memories first."
        : "Deleting an empty space cannot be undone.";
  $("#space-form-message").textContent = "";
  $("#space-dialog").showModal();
  $("#space-name").focus();
}

$("#space-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#save-space");
  button.disabled = true;
  const editingSpaceId = state.editingSpaceId;
  try {
    const name = $("#space-name").value.trim();
    const space = editingSpaceId
      ? await request(`/spaces/${editingSpaceId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      })
      : await request("/spaces", { method: "POST", body: JSON.stringify({ name }) });
    $("#space-dialog").close();
    await loadSpaces();
    state.spaceId = space.id;
    localStorage.setItem("mnemosyne-space-id", space.id);
    $("#current-space-name").textContent = space.name;
    $("#close-detail").click();
    showView(editingSpaceId ? state.view : "graph");
    toast(editingSpaceId ? "Space updated" : "Space created");
  } catch (error) {
    $("#space-form-message").textContent = error.message;
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

$("#delete-space").addEventListener("click", async () => {
  const spaceId = state.editingSpaceId;
  if (
    !spaceId
    || !(await askConfirmation("Only empty spaces can be deleted. This cannot be undone.", "Delete this space?"))
  ) return;
  const deletingActiveSpace = state.spaceId === spaceId;
  try {
    await request(`/spaces/${spaceId}`, { method: "DELETE" });
    $("#space-dialog").close();
    if (deletingActiveSpace) {
      state.spaceId = null;
      localStorage.removeItem("mnemosyne-space-id");
    }
    await loadSpaces();
    if (deletingActiveSpace) {
      $("#close-detail").click();
      showView("spaces");
    } else {
      renderSpacesHome();
    }
    toast("Space deleted");
  } catch (error) {
    toast(error.message);
  }
});

$("#brand-home").addEventListener("click", (event) => {
  event.preventDefault();
  showView("spaces");
});
$("#space-picker-button").addEventListener("click", () => showView("spaces"));
$("#spaces-home-search").addEventListener("input", (event) => {
  renderSpacesHome(event.currentTarget.value);
});
$("#new-space").addEventListener("click", () => openSpaceDialog());
$("#manage-space").addEventListener("click", () => {
  const active = state.spaces.find((space) => space.id === state.spaceId);
  if (active) openSpaceDialog(active);
});
$("#space-dialog").addEventListener("close", () => $("#space-form-message").textContent = "");
$("#cancel-link-mode").addEventListener("click", cancelLinkMode);
$("#link-dialog").addEventListener("close", cancelLinkMode);
$("#confirm-action").addEventListener("click", () => finishConfirmation(true));
$$("[data-confirm-cancel]").forEach((button) => {
  button.addEventListener("click", () => finishConfirmation(false));
});
$("#confirm-dialog").addEventListener("close", () => {
  if (state.confirmResolver) finishConfirmation(false);
});
$("#map-preview-dialog").addEventListener("cancel", () => {
  state.pendingCapture = null;
});

$("#upload-document").addEventListener("click", () => $("#document-file").click());
$("#document-file").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const file = input.files[0];
  if (!file) return;
  const button = $("#upload-document");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Uploading…";
  const body = new FormData();
  body.append("file", file);
  try {
    const job = await request("/ingest/file", { method: "POST", body });
    toast(`${file.name} saved in documents`);
    await openDocumentPreview({
      file,
      jobId: job.id,
      status: "Saved in this space · indexing queued",
    });
    void watchIngestJob(job.id, file);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
    input.value = "";
  }
});

async function watchIngestJob(jobId, file) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    try {
      const job = await request(`/jobs/${jobId}`);
      if (job.status === "done") {
        await loadGraph();
        const title = file.name.replace(/\.[^.]+$/, "").toLocaleLowerCase();
        const items = await request("/items?limit=100");
        const item = items.find(
          (entry) => entry.type === "document" && entry.title.toLocaleLowerCase() === title,
        );
        if (item && state.documentPreview?.jobId === jobId) {
          state.documentPreview.itemId = item.id;
          state.documentPreview.jobId = null;
          $("#document-viewer-status").textContent = "Saved and indexed in this space";
          $("#document-extracted").textContent =
            item.content.slice(0, 12000) || "No text could be extracted from this document.";
          try {
            const related = await request(`/items/${item.id}/related?limit=6`);
            $("#document-related").replaceChildren();
            if (related.length) {
              for (const hit of related) {
                const link = document.createElement("button");
                link.className = "related-link";
                link.textContent = hit.item.title;
                link.addEventListener("click", () => {
                  $("#document-viewer-dialog").close();
                  selectItem(hit.item.id);
                });
                $("#document-related").append(link);
              }
            } else {
              $("#document-related").textContent = "No related notes yet.";
            }
          } catch (error) {
            $("#document-related").textContent = `Could not load related notes: ${error.message}`;
          }
        }
        return;
      }
      if (job.status === "failed") {
        if (state.documentPreview?.jobId === jobId) {
          $("#document-viewer-status").textContent = "Saved, but indexing failed";
          state.documentPreview.jobId = null;
        }
        toast("Document saved, but indexing failed. Check the worker log.");
        return;
      }
    } catch (error) {
      toast(error.message);
      if (state.documentPreview?.jobId === jobId) {
        $("#document-viewer-status").textContent = `Indexing status unavailable: ${error.message}`;
      }
      return;
    }
  }
  if (state.documentPreview?.jobId === jobId) {
    $("#document-viewer-status").textContent = "Saved; indexing is taking longer than usual";
  }
}

$("#decision-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#save-decision"); button.disabled = true;
  const revisit = $("#decision-revisit").value;
  try {
    await request("/decisions", { method: "POST", body: JSON.stringify({
      question: $("#decision-question").value.trim(),
      choice: $("#decision-choice").value.trim(),
      rationale: $("#decision-rationale").value.trim(),
      revisit_at: revisit ? new Date(revisit).toISOString() : null,
    }) });
    $("#decision-dialog").close(); $("#decision-form").reset();
    toast("Decision saved"); showView("decisions");
  } catch (error) { $("#decision-message").textContent = error.message; }
  finally { button.disabled = false; }
});

$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = $("#search-query").value.trim();
  if (query) runSearch(query);
});
$("#search-query").addEventListener("input", () => {
  $("#search-clear").classList.toggle("hidden", !$("#search-query").value);
});
$("#search-clear").addEventListener("click", () => {
  state.searchRequestId += 1;
  $("#search-query").value = "";
  $("#search-clear").classList.add("hidden");
  $("#search-results").replaceChildren();
  $("#search-results").setAttribute("aria-busy", "false");
  $("#search-meta").textContent = "Search is limited to your current space.";
  $("#search-welcome").classList.remove("hidden");
  $("#search-query").focus();
});
$$("[data-search-mode]").forEach((button) => button.addEventListener("click", () => {
  state.searchMode = button.dataset.searchMode;
  $$("[data-search-mode]").forEach((modeButton) => {
    const active = modeButton === button;
    modeButton.classList.toggle("active", active);
    modeButton.setAttribute("aria-pressed", String(active));
  });
  $("#search-mode-hint").textContent = state.searchMode === "text"
    ? "Text matches words in your notes. It is the quickest option."
    : state.searchMode === "vector"
      ? "Vector compares embeddings to find related meaning, even when notes use different words. It needs indexed embeddings and can take longer."
      : "Hybrid combines text matches with vector similarity. It balances exact terms with related concepts.";
  const query = $("#search-query").value.trim();
  if (query) runSearch(query);
}));
$$("[data-search-example]").forEach((button) => button.addEventListener("click", () => {
  const query = button.dataset.searchExample;
  $("#search-query").value = query;
  $("#search-clear").classList.remove("hidden");
  runSearch(query);
}));
$("#open-capture").addEventListener("click", openCapture);
$("#empty-add").addEventListener("click", openCapture);
$("#empty-upload").addEventListener("click", () => $("#document-file").click());
$("#new-decision").addEventListener("click", () => $("#decision-dialog").showModal());
$("#close-document-viewer").addEventListener("click", () => $("#document-viewer-dialog").close());
$("#document-viewer-dialog").addEventListener("close", () => {
  if (state.documentPreview?.url) URL.revokeObjectURL(state.documentPreview.url);
  state.documentPreview = null;
});
$$("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => {
    const dialog = button.closest("dialog");
    if (dialog.id === "map-preview-dialog") state.pendingCapture = null;
    dialog.close();
  });
});
$("#refresh-button").addEventListener("click", () => {
  if (state.view === "graph") void loadGraph(true);
  else showView(state.view);
});
$("#close-detail").addEventListener("click", () => {
  state.detailRequestId += 1;
  state.selected = null;
  updateSelectedGraphNode(null);
  $("#detail-content").className = "detail-placeholder";
  $("#detail-content").innerHTML = `<div class="detail-orbit">✳</div><strong>Follow a thought</strong><p>Select a node or search result to see its details and related notes.</p>`;
});
$("#api-key-button").addEventListener("click", () => {
  $("#api-key-input").value = apiKey();
  $("#connection-settings-dialog").showModal();
  $("#api-key-input").focus();
});
$("#connection-settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const key = $("#api-key-input").value.trim();
  if (key) localStorage.setItem("mnemosyne-api-key", key);
  else localStorage.removeItem("mnemosyne-api-key");
  $("#connection-settings-dialog").close();
  toast(key ? "Connection settings saved" : "API key cleared");
  void loadGraph(true);
});
$("#clear-api-key").addEventListener("click", () => {
  localStorage.removeItem("mnemosyne-api-key");
  $("#api-key-input").value = "";
  $("#connection-settings-dialog").close();
  toast("API key cleared");
  void loadGraph(true);
});
$$(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$("#zoom-in").addEventListener("click", () => zoomMainGraph(1.2));
$("#zoom-out").addEventListener("click", () => zoomMainGraph(1 / 1.2));
$("#center-graph").addEventListener("click", () => {
  state.scale = 1; state.offsetX = 0; state.offsetY = 0; renderGraph(state.graph);
});
$("#graph-filter").addEventListener("click", () => {
  const current = FILTERS.indexOf(state.filter);
  state.filter = FILTERS[(current + 1) % FILTERS.length];
  renderGraph(state.graph);
});
const graphSvg = $("#graph-canvas");
let drag = null;
graphSvg.addEventListener("wheel", (event) => {
  event.preventDefault();
  const anchor = eventPointInSvg(event, graphSvg);
  if (anchor) zoomMainGraph(Math.exp(-event.deltaY * .001), anchor.x, anchor.y);
}, { passive: false });
graphSvg.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".graph-node, .graph-edge-hit")) return;
  drag = { x: event.clientX, y: event.clientY, ox: state.offsetX, oy: state.offsetY };
  graphSvg.setPointerCapture(event.pointerId);
  graphSvg.style.cursor = "grabbing";
});
graphSvg.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const bounds = graphSvg.getBoundingClientRect();
  state.offsetX = drag.ox + (event.clientX - drag.x) * (1100 / bounds.width) / state.scale;
  state.offsetY = drag.oy + (event.clientY - drag.y) * (680 / bounds.height) / state.scale;
  const drawing = graphSvg.querySelector(".graph-drawing");
  if (drawing) drawing.setAttribute(
    "transform",
    `translate(${550 + state.offsetX} ${340 + state.offsetY}) scale(${state.scale}) translate(-550 -340)`,
  );
});
graphSvg.addEventListener("pointerup", () => { drag = null; graphSvg.style.cursor = "grab"; });
graphSvg.addEventListener("pointercancel", () => { drag = null; graphSvg.style.cursor = "grab"; });
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openCapture(); }
});

async function initializeWorkspace() {
  try {
    await loadSpaces();
    const initialView = state.spaceId ? readActiveView() : "spaces";
    showView(initialView);
    if (state.spaceId && initialView === "spaces") void loadGraph(false);
  } catch (error) {
    setSync(false, "Not connected");
    toast(error.message);
  }
}

initializeWorkspace();
