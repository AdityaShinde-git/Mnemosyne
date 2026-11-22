const API = "/api";
const DEFAULT_SPACE_ID = "00000000-0000-0000-0000-000000000001";
const NODE_POSITIONS_KEY = "mnemosyne-node-positions";
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
  view: "graph", graph: { nodes: [], edges: [] }, scale: 1,
  offsetX: 0, offsetY: 0, selected: null, filter: "all",
  linkSourceId: null, linkTargetId: null, nodeDrag: null, suppressNodeClick: null,
  nodePositions: readNodePositions(), spaceId: localStorage.getItem("mnemosyne-space-id"),
  spaces: [], editingEdge: null, decisions: [], editingDecision: null, confirmResolver: null,
  documentPreview: null, spaceTransitionTimer: null,
};
const COLORS = { note: "#67d694", document: "#e2d571", bookmark: "#90a8d7", decision: "#9c87d8" };
const FILTERS = ["all", "note", "document", "bookmark", "decision"];
const DRAFT_NODE_KINDS = ["topic", "project", "person", "organization", "place", "event", "tool", "other"];

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

function showView(name) {
  state.view = name;
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $$(".view-panel").forEach((panel) => panel.classList.toggle("hidden", panel.id !== `${name}-view`));
  $("#view-label").textContent = name.charAt(0).toUpperCase() + name.slice(1);
  if (name === "graph") loadGraph();
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

function renderGraph(data) {
  state.graph = data;
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
  nodes.forEach((node, index) => {
    const point = positions.get(node.id);
    const color = COLORS[node.type] || COLORS.note;
    const group = document.createElementNS(svg.namespaceURI, "g");
    group.setAttribute("class", `graph-node${state.selected?.id === node.id ? " selected" : ""}`);
    group.setAttribute("transform", `translate(${point.x} ${point.y})`);
    group.dataset.id = node.id;
    group.setAttribute("role", "button");
    group.setAttribute("tabindex", "0");
    group.setAttribute("aria-label", `Open node: ${node.title}`);
    const hitArea = document.createElementNS(svg.namespaceURI, "rect");
    hitArea.setAttribute("x", "-16"); hitArea.setAttribute("y", "-16");
    hitArea.setAttribute("width", String(Math.max(36, labelWidth(node.title))));
    hitArea.setAttribute("height", "32"); hitArea.setAttribute("fill", "transparent");
    hitArea.setAttribute("pointer-events", "all");
    const halo = document.createElementNS(svg.namespaceURI, "circle");
    halo.setAttribute("r", String(index % 7 === 0 ? 17 : 12)); halo.setAttribute("fill", color); halo.setAttribute("class", "node-halo");
    const core = document.createElementNS(svg.namespaceURI, "circle");
    core.setAttribute("r", String(index % 7 === 0 ? 5 : 3.2)); core.setAttribute("fill", color); core.setAttribute("class", "node-core");
    const label = document.createElementNS(svg.namespaceURI, "text");
    label.setAttribute("x", "9"); label.setAttribute("y", "3"); label.setAttribute("class", "node-label");
    label.textContent = node.title.length > 22 ? `${node.title.slice(0, 21)}…` : node.title;
    group.append(hitArea, halo, core, label);
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

function labelWidth(title) {
  const label = title.length > 22 ? 22 : title.length;
  return label * 6 + 30;
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

async function loadGraph() {
  try {
    const data = await request("/graph");
    renderGraph(data);
    setSync(true);
  } catch (error) {
    setSync(false, "Not connected");
    $("#graph-empty").classList.remove("hidden");
    toast(error.message);
  }
}

async function selectItem(id) {
  try {
    const item = await request(`/items/${id}`);
    state.selected = item;
    renderGraph(state.graph);
    const related = await request(`/items/${id}/related?limit=4`).catch(() => []);
    const decision = item.type === "decision"
      ? (await request("/decisions")).find((entry) => entry.item_id === item.id)
      : null;
    renderDetail(item, related, decision);
  } catch (error) { toast(error.message); }
}

function renderDetail(item, related = [], decision = null) {
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
  if (related.length) {
    const divider = document.createElement("div"); divider.className = "detail-divider";
    const subhead = document.createElement("div"); subhead.className = "detail-subhead"; subhead.textContent = "Related notes";
    container.append(divider, subhead);
    for (const hit of related) {
      const link = document.createElement("button"); link.className = "related-link";
      link.textContent = hit.item.title; link.addEventListener("click", () => selectItem(hit.item.id));
      container.append(link);
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
  const list = $("#connection-list");
  list.replaceChildren();
  try {
    const pairs = await request("/connections/forgotten?limit=30");
    if (!pairs.length) return empty(list, "No distant connections surfaced yet. Index more notes and check back.");
    for (const pair of pairs) {
      const card = document.createElement("article"); card.className = "connection-card";
      card.innerHTML = `<span class="similarity"></span><div class="connection-pair"><div class="connection-note"><strong></strong><small></small></div><div class="connection-arrow">↔</div><div class="connection-note"><strong></strong><small></small></div></div><p class="explanation"></p>`;
      card.querySelector(".similarity").textContent = `${Math.round(pair.similarity * 100)}%`;
      const notes = card.querySelectorAll(".connection-note");
      notes[0].querySelector("strong").textContent = pair.left.title;
      notes[0].querySelector("small").textContent = "Earlier thought";
      notes[1].querySelector("strong").textContent = pair.right.title;
      notes[1].querySelector("small").textContent = "Later thought";
      card.querySelector(".explanation").textContent = pair.explanation;
      card.addEventListener("click", () => selectItem(pair.left.id));
      list.append(card);
    }
  } catch (error) { empty(list, error.message); }
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
    const card = document.createElement("article"); card.className = "result-card";
    card.innerHTML = `<div class="card-kicker"></div><h3></h3><p></p><div class="card-meta"><span></span><span></span></div>`;
    card.querySelector(".card-kicker").textContent = item.type;
    card.querySelector("h3").textContent = item.title;
    card.querySelector("p").textContent = item.content.slice(0, 280);
    card.querySelector(".card-meta span:first-child").textContent = niceDate(item.captured_at);
    card.querySelector(".card-meta span:last-child").textContent = `RRF ${hit.score.toFixed(4)} · ${hit.matched_by.join(" + ")}`;
    card.addEventListener("click", () => selectItem(item.id));
    list.append(card);
  }
}

async function runSearch(query, mode = "hybrid") {
  $("#search-meta").textContent = "Searching your notes…";
  try {
    const hits = await request(
      `/search?q=${encodeURIComponent(query)}&limit=30&mode=${encodeURIComponent(mode)}`,
    );
    $("#search-meta").textContent = `${hits.length} ${hits.length === 1 ? "result" : "results"} · Reciprocal Rank Fusion`;
    renderResults(hits);
  } catch (error) {
    $("#search-meta").textContent = error.message;
    $("#search-results").replaceChildren();
  }
}

function openCapture() {
  $("#capture-message").textContent = "";
  $("#capture-dialog").showModal();
  $("#capture-content").focus();
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
    button.innerHTML = "Preview map <span>↗</span>";
  }
}

function renderDraftPreview() {
  const pending = state.pendingCapture;
  const preview = $("#map-preview-content");
  preview.replaceChildren();
  const modelInfo = document.createElement("p");
  modelInfo.className = "capture-hint";
  modelInfo.textContent = pending.model === "inclusionai/ling-3.2-flash:free"
    ? "Generated by Ling 3.2 Flash (free)."
    : "Ling was unavailable; generated by the free NVIDIA backup.";
  preview.append(modelInfo);
  const root = document.createElement("section");
  root.className = "map-node-preview";
  const rootLabel = document.createElement("label");
  rootLabel.textContent = "Main note";
  const rootTitle = document.createElement("input");
  rootTitle.maxLength = 120;
  rootTitle.value = pending.title;
  rootTitle.setAttribute("aria-label", "Edit main note title");
  rootTitle.addEventListener("input", () => { pending.title = rootTitle.value; });
  const rootContent = document.createElement("p");
  rootContent.textContent = pending.content;
  root.append(rootLabel, rootTitle, rootContent);
  preview.append(root);

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
    preview.append(questions);
  }

  const nodeHeading = document.createElement("div");
  nodeHeading.className = "draft-section-heading";
  const nodeTitle = document.createElement("strong");
  nodeTitle.textContent = "TOPICS AND ENTITIES";
  const addNode = document.createElement("button");
  addNode.type = "button";
  addNode.className = "button secondary";
  addNode.textContent = "＋ Add node";
  addNode.addEventListener("click", () => {
    if (pending.nodes.length >= 8) {
      toast("A draft can contain up to 8 new nodes");
      return;
    }
    const ids = new Set(pending.nodes.map((node) => node.id));
    let number = 1;
    while (ids.has(`n${number}`)) number += 1;
    pending.nodes.push({
      id: `n${number}`, title: "New topic", kind: "topic",
      description: "", evidence: [], selected: true,
    });
    renderDraftPreview();
  });
  nodeHeading.append(nodeTitle, addNode);
  preview.append(nodeHeading);

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
    const kind = document.createElement("select");
    kind.setAttribute("aria-label", "Edit node category");
    for (const value of DRAFT_NODE_KINDS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value[0].toLocaleUpperCase() + value.slice(1);
      kind.append(option);
    }
    kind.value = node.kind;
    kind.addEventListener("change", () => {
      node.kind = kind.value;
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
      renderDraftPreview();
    });
    card.append(include, fields, remove);
    preview.append(card);
  }

  const relationHeading = document.createElement("div");
  relationHeading.className = "draft-section-heading";
  const relationTitle = document.createElement("strong");
  relationTitle.textContent = "CONNECTIONS";
  const addRelation = document.createElement("button");
  addRelation.type = "button";
  addRelation.className = "button secondary";
  addRelation.textContent = "＋ Add connection";
  addRelation.disabled = !pending.nodes.length && !state.graph.nodes.length;
  addRelation.addEventListener("click", () => {
    const target = pending.nodes.find((node) => node.selected)?.id || state.graph.nodes[0]?.id;
    if (!target) return;
    pending.relationships.push({
      source: "root", target, label: "", evidence: "", confidence: "medium", selected: true,
    });
    renderDraftPreview();
  });
  relationHeading.append(relationTitle, addRelation);
  preview.append(relationHeading);

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
      renderDraftPreview();
    });
    card.append(include, fields, remove);
    preview.append(card);
  }

  if (!pending.nodes.length && !pending.relationships.length) {
    const empty = document.createElement("p");
    empty.className = "map-link-preview unmatched";
    empty.textContent = "No separate topics or clear connections were found. You can still save the main note.";
    preview.append(empty);
  }
}

async function saveCapture() {
  const pending = state.pendingCapture;
  if (!pending) return;
  const button = $("#save-capture"); button.disabled = true;
  let saved = null;
  let topicCount = 0;
  let connectionCount = 0;
  try {
    saved = await request("/items", { method: "POST", body: JSON.stringify({
      type: pending.source ? "bookmark" : "note",
      title: pending.title.trim(),
      content: pending.content,
      source_uri: pending.source || null,
    }) });
    const savedByDraftId = new Map([["root", saved]]);
    for (const node of pending.nodes.filter((candidate) => candidate.selected)) {
      const title = node.title.trim();
      const description = node.description.trim();
      if (!title || !description) throw new Error("Every selected topic needs a title and description.");
      if (title.toLocaleLowerCase() === saved.title.toLocaleLowerCase()) {
        savedByDraftId.set(node.id, saved);
        continue;
      }
      const existing = state.graph.nodes.find(
        (candidate) => candidate.title.toLocaleLowerCase() === title.toLocaleLowerCase(),
      );
      const topic = existing || await request("/items", {
        method: "POST",
        body: JSON.stringify({
          type: "note",
          title,
          content: `${description}\n\nEvidence: ${node.evidence.join(" / ")}\n\nCaptured from: ${saved.title}`,
          metadata: { draft_kind: node.kind, evidence: node.evidence },
        }),
      });
      savedByDraftId.set(node.id, topic);
      if (!existing) topicCount += 1;
    }
    for (const relationship of pending.relationships.filter((candidate) => candidate.selected)) {
      const source = savedByDraftId.get(relationship.source)
        || state.graph.nodes.find((node) => node.id === relationship.source);
      const target = savedByDraftId.get(relationship.target)
        || state.graph.nodes.find((node) => node.id === relationship.target);
      if (!source || !target || source.id === target.id) continue;
      const label = relationship.label.trim();
      const query = label ? `?label=${encodeURIComponent(label)}` : "";
      await request(`/items/${source.id}/links/${target.id}${query}`, { method: "POST" });
      connectionCount += 1;
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
        excerpt: saved.content.slice(0, 180),
      },
      ...state.graph.nodes.filter((node) => node.id !== saved.id),
    ].slice(0, 200);
    renderGraph(state.graph);
    toast(`Saved${topicCount ? ` ${topicCount} topic${topicCount === 1 ? "" : "s"}` : ""}${connectionCount ? ` and ${connectionCount} connection${connectionCount === 1 ? "" : "s"}` : ""}`);
    await loadGraph();
    state.pendingCapture = null;
  } catch (error) {
    $("#map-message").textContent = saved
      ? `The main note was saved, but the rest of the map could not be completed: ${error.message}`
      : error.message;
    if (saved) void loadGraph();
  }
  finally { button.disabled = false; }
}

$("#preview-capture").addEventListener("click", renderCapturePreview);
$("#capture-form").addEventListener("submit", (event) => event.preventDefault());
$("#save-capture").addEventListener("click", saveCapture);
$("#edit-capture").addEventListener("click", () => {
  $("#map-preview-dialog").close();
  $("#capture-dialog").showModal();
  $("#capture-content").focus();
});

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
  if (!spaces.length) throw new Error("No spaces are available.");
  state.spaces = spaces;
  if (!spaces.some((space) => space.id === state.spaceId)) {
    const personal = spaces.find((space) => space.id === DEFAULT_SPACE_ID) || spaces[0];
    state.spaceId = personal.id;
    localStorage.setItem("mnemosyne-space-id", state.spaceId);
  }
  const active = spaces.find((space) => space.id === state.spaceId);
  $("#current-space-name").textContent = active.name;
  renderSpaceGalaxy($("#space-search").value);
}

function renderSpaceInsight(space) {
  const insight = $("#space-galaxy-insight");
  if (!space) {
    insight.replaceChildren();
    return;
  }
  const title = document.createElement("strong");
  title.textContent = space.name;
  const count = document.createElement("span");
  const itemCount = space.item_count || 0;
  count.textContent = `${itemCount} ${itemCount === 1 ? "memory" : "memories"}`;
  const activity = document.createElement("small");
  activity.textContent = space.last_activity
    ? `LAST SIGNAL · ${shortDate(space.last_activity)}`
    : `FORMED · ${niceDate(space.created_at)}`;
  insight.replaceChildren(title, count, activity);
}

function renderSpaceGalaxy(query = "") {
  const field = $("#space-galaxy-nuclei");
  if (!field) return;
  field.replaceChildren();
  const search = query.trim().toLocaleLowerCase();
  const matches = state.spaces.filter((space) => space.name.toLocaleLowerCase().includes(search));
  const focusSpace = matches.find((space) => space.id === state.spaceId) || matches[0];
  const satellites = matches.filter((space) => space.id !== focusSpace?.id);
  const radiusX = satellites.length === 1 ? 30 : Math.min(42, 17 + satellites.length * 2.8);
  const radiusY = Math.min(35, 15 + satellites.length * 2.2);
  const palette = ["#8ee4ac", "#c3a6ff", "#83d9e8", "#f0d47a", "#f39b87"];
  matches.forEach((space, index) => {
    const nucleus = document.createElement("button");
    nucleus.type = "button";
    const isFocus = space.id === focusSpace?.id;
    nucleus.className = `space-nucleus${isFocus ? " focused" : ""}`;
    nucleus.setAttribute("aria-current", space.id === state.spaceId ? "true" : "false");
    nucleus.setAttribute("aria-label", `${space.name}, ${space.item_count || 0} memories${space.id === state.spaceId ? ", current space" : ""}`);
    const satelliteIndex = satellites.findIndex((entry) => entry.id === space.id);
    const angle = satellites.length === 1
      ? Math.PI
      : (satelliteIndex / Math.max(satellites.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const x = isFocus ? 50 : 50 + Math.cos(angle) * radiusX;
    const y = isFocus ? 50 : 50 + Math.sin(angle) * radiusY;
    nucleus.style.setProperty("--space-x", `${x}%`);
    nucleus.style.setProperty("--space-y", `${y}%`);
    nucleus.style.setProperty("--space-color", palette[index % palette.length]);

    const core = document.createElement("span");
    core.className = "space-nucleus-core";
    core.setAttribute("aria-hidden", "true");
    core.append(document.createElement("i"), document.createElement("b"));
    const label = document.createElement("span");
    label.className = "space-nucleus-label";
    label.textContent = space.name;
    const marker = document.createElement("small");
    marker.textContent = space.id === state.spaceId ? "CURRENT" : `${space.item_count || 0} MEMORIES`;
    nucleus.append(core, label, marker);
    nucleus.addEventListener("mouseenter", () => renderSpaceInsight(space));
    nucleus.addEventListener("focus", () => renderSpaceInsight(space));
    nucleus.addEventListener("click", () => zoomToSpace(space.id, nucleus));
    field.append(nucleus);
  });
  $("#space-search-empty").classList.toggle("hidden", matches.length > 0);
  $("#space-galaxy-stage").classList.toggle("searching", Boolean(search));
  renderSpaceInsight(focusSpace);
}

function openSpacePicker() {
  if (state.spaceTransitionTimer) window.clearTimeout(state.spaceTransitionTimer);
  state.spaceTransitionTimer = null;
  $("#space-galaxy-stage").classList.remove("zooming");
  $("#space-search").value = "";
  renderSpaceGalaxy();
  $("#space-picker-dialog").showModal();
  document.body.classList.add("space-dialog-open");
  $("#space-search").focus();
}

function zoomToSpace(spaceId, nucleus) {
  const stage = $("#space-galaxy-stage");
  if (stage.classList.contains("zooming")) return;
  stage.classList.add("zooming");
  nucleus.classList.add("zoom-target");
  const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 680;
  state.spaceTransitionTimer = window.setTimeout(() => {
    state.spaceTransitionTimer = null;
    stage.classList.remove("zooming");
    selectSpace(spaceId);
  }, duration);
}

function selectSpace(spaceId) {
  state.spaceId = spaceId;
  localStorage.setItem("mnemosyne-space-id", spaceId);
  const active = state.spaces.find((space) => space.id === spaceId);
  if (active) $("#current-space-name").textContent = active.name;
  if ($("#space-picker-dialog").open) $("#space-picker-dialog").close();
  $("#close-detail").click();
  showView(state.view);
}

function openSpaceDialog(space = null) {
  state.editingSpaceId = space?.id || null;
  $("#space-name").value = space?.name || "";
  $("#space-dialog").querySelector("h2").textContent =
    space ? "Manage this space" : "Create a space";
  $("#save-space").textContent = space ? "Save space" : "Create space";
  $("#delete-space").classList.toggle("hidden", !space || space.id === DEFAULT_SPACE_ID);
  $("#delete-space").disabled = false;
  $("#space-form-message").textContent = "";
  $("#space-dialog").showModal();
  $("#space-name").focus();
}

$("#space-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#save-space");
  button.disabled = true;
  try {
    const name = $("#space-name").value.trim();
    const space = state.editingSpaceId
      ? await request(`/spaces/${state.editingSpaceId}`, {
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
    showView(state.view);
    toast(state.editingSpaceId ? "Space updated" : "Space created");
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
  try {
    await request(`/spaces/${spaceId}`, { method: "DELETE" });
    $("#space-dialog").close();
    state.spaceId = null;
    await loadSpaces();
    localStorage.setItem("mnemosyne-space-id", state.spaceId);
    $("#close-detail").click();
    showView(state.view);
    toast("Space deleted");
  } catch (error) {
    toast(error.message);
  }
});

$("#space-picker-button").addEventListener("click", openSpacePicker);
$("#space-search").addEventListener("input", (event) => renderSpaceGalaxy(event.currentTarget.value));
$("#space-picker-dialog").addEventListener("close", () => {
  if (state.spaceTransitionTimer) window.clearTimeout(state.spaceTransitionTimer);
  state.spaceTransitionTimer = null;
  document.body.classList.remove("space-dialog-open");
  $("#space-galaxy-stage").classList.remove("zooming");
});
$("#space-picker-create").addEventListener("click", () => {
  $("#space-picker-dialog").close();
  openSpaceDialog();
});
$("#new-space").addEventListener("click", () => openSpaceDialog());
$("#manage-space").addEventListener("click", () => {
  openSpaceDialog(state.spaces.find((space) => space.id === state.spaceId));
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
$("#map-preview-dialog").addEventListener("close", () => {
  if (state.pendingCapture) state.pendingCapture = null;
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
  if (query) runSearch(query, $("#search-mode").value);
});
$("#open-capture").addEventListener("click", openCapture);
$("#graph-add").addEventListener("click", openCapture);
$("#empty-add").addEventListener("click", openCapture);
$("#new-decision").addEventListener("click", () => $("#decision-dialog").showModal());
$("#close-document-viewer").addEventListener("click", () => $("#document-viewer-dialog").close());
$("#document-viewer-dialog").addEventListener("close", () => {
  if (state.documentPreview?.url) URL.revokeObjectURL(state.documentPreview.url);
  state.documentPreview = null;
});
$$("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
$("#refresh-button").addEventListener("click", () => showView(state.view));
$("#close-detail").addEventListener("click", () => {
  state.selected = null;
  $("#detail-content").className = "detail-placeholder";
  $("#detail-content").innerHTML = `<div class="detail-orbit">✳</div><strong>Follow a thought</strong><p>Select a node or search result to see its details and related notes.</p>`;
  if (state.view === "graph") renderGraph(state.graph);
});
$("#api-key-button").addEventListener("click", () => {
  const key = window.prompt("API key (leave empty if API_KEY is not configured):", apiKey());
  if (key !== null) {
    if (key) localStorage.setItem("mnemosyne-api-key", key);
    else localStorage.removeItem("mnemosyne-api-key");
    toast("API key saved in this browser");
    loadGraph();
  }
});
$$(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$("#zoom-in").addEventListener("click", () => { state.scale = Math.min(1.7, state.scale + .15); renderGraph(state.graph); });
$("#zoom-out").addEventListener("click", () => { state.scale = Math.max(.55, state.scale - .15); renderGraph(state.graph); });
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
graphSvg.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".graph-node, .graph-edge-hit")) return;
  drag = { x: event.clientX, y: event.clientY, ox: state.offsetX, oy: state.offsetY };
  graphSvg.setPointerCapture(event.pointerId);
  graphSvg.style.cursor = "grabbing";
});
graphSvg.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const bounds = graphSvg.getBoundingClientRect();
  state.offsetX = drag.ox + (event.clientX - drag.x) * (1100 / bounds.width);
  state.offsetY = drag.oy + (event.clientY - drag.y) * (680 / bounds.height);
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
    showView("graph");
  } catch (error) {
    setSync(false, "Not connected");
    toast(error.message);
  }
}

initializeWorkspace();
