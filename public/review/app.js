/**
 * Implements the app responsibilities of the AJRM Marine Voyages browser application.
 */

import * as MapCore from "./ajrm-map-core.mjs?v=0.7.9";

const apiBase = "/plugins/signalk-ajrm-marine-capture/review";
const elements = {
  map: document.querySelector("#map"),
  toggleVoyages: document.querySelector("#toggleVoyages"),
  toggleCharts: document.querySelector("#toggleCharts"),
  refreshVoyages: document.querySelector("#refreshVoyages"),
  toggleSummary: document.querySelector("#toggleSummary"),
  voyageDrawer: document.querySelector("#voyageDrawer"),
  chartDrawer: document.querySelector("#chartDrawer"),
  chartStatus: document.querySelector("#chartStatus"),
  chartCycleStatus: document.querySelector("#chartCycleStatus"),
  baseMapChoices: [...document.querySelectorAll('input[name="baseMap"]')],
  autoCharts: document.querySelector("#checkAutoCharts"),
  openSeaMap: document.querySelector("#checkOpenSeaMap"),
  voyageList: document.querySelector("#voyageList"),
  statusLine: document.querySelector("#statusLine"),
  selectedDetails: document.querySelector("#selectedDetails"),
  plotSelected: document.querySelector("#plotSelected"),
  reviewSelected: document.querySelector("#reviewSelected"),
  centrePlot: document.querySelector("#centrePlot"),
  toggleDrTrack: document.querySelector("#toggleDrTrack"),
  notesPanel: document.querySelector("#notesPanel"),
  notesList: document.querySelector("#notesList"),
  plotProgress: document.querySelector("#plotProgress"),
  progressText: document.querySelector("#progressText"),
  progressPercent: document.querySelector("#progressPercent"),
  progressBar: document.querySelector("#progressBar"),
  summaryPanel: document.querySelector("#summaryPanel"),
  summaryTitle: document.querySelector("#summaryTitle"),
  summarySubtitle: document.querySelector("#summarySubtitle"),
  summaryGrid: document.querySelector("#summaryGrid"),
  reviewPanel: document.querySelector("#reviewPanel"),
  downloadGpx: document.querySelector("#downloadGpx"),
  downloadSelected: document.querySelector("#downloadSelected"),
  comment: document.querySelector("#comment"),
  toast: document.querySelector("#toast"),
};

let map;
let trackLayer;
let drTrackLayer;
let routeLayer;
let markerLayer;
let baseLayers = {};
let currentBaseLayer;
let autoChartGroup;
let autoChartLayer;
let autoChartFallbackLayer;
let autoChartId;
let autoChartList = [];
let chartCycle = null;
let mapActionToolbar = null;
let chartResourcesLoaded = false;
let chartResourcesLoading = null;
let seamarkLayer;
const chartLayerZIndex = 450;
const seamarkLayerZIndex = 650;
let progressTimer = null;
let currentFiles = [];
let selectedFile = null;
let plottedBounds = null;
let currentAnalysis = null;
let drTrackVisible = false;
let analysisRequestId = 0;

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.style.background = isError ? "#7f1d1d" : "#0f172a";
  elements.toast.classList.add("visible");
  setTimeout(() => elements.toast.classList.remove("visible"), 3500);
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || response.statusText || "Request failed");
  }
  return data;
}

function initMap() {
  map = L.map(elements.map, { zoomControl: true }).setView([56.21, -5.56], 11);
  MapCore.labelLeafletZoomControls(map);
  const naturalEarth = makeNaturalEarthLayer();
  const empty = L.tileLayer("");
  const openStreetMap = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxNativeZoom: 19,
    maxZoom: 22,
    attribution: "© OpenStreetMap contributors",
  });
  const openTopoMap = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxNativeZoom: 17,
    maxZoom: 22,
    attribution: "Map data © OpenStreetMap contributors | Style © OpenTopoMap",
  });
  const satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxNativeZoom: 17, maxZoom: 22, attribution: "© Esri © OpenStreetMap Contributors" },
  );
  seamarkLayer = L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", {
    maxNativeZoom: 19,
    maxZoom: 22,
    zIndex: seamarkLayerZIndex,
    attribution: "© OpenSeaMap contributors",
  });
  baseLayers = {
    Empty: empty,
    "NaturalEarth (offline)": naturalEarth,
    OpenStreetMap: openStreetMap,
    OpenTopoMap: openTopoMap,
    Satellite: satellite,
  };
  autoChartGroup = L.layerGroup();
  setBaseMap(localStorage.getItem("ajrmMarineCaptureReviewBaseMap") || "NaturalEarth (offline)");
  setOverlay(
    autoChartGroup,
    localStorage.getItem("ajrmMarineCaptureReviewAutoCharts") === "true",
    "ajrmMarineCaptureReviewAutoCharts",
  );
  setOverlay(
    seamarkLayer,
    localStorage.getItem("ajrmMarineCaptureReviewOpenSeaMap") !== "false",
    "ajrmMarineCaptureReviewOpenSeaMap",
  );
  installCommonChartSelector();
  trackLayer = L.layerGroup().addTo(map);
  drTrackLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  map.on("moveend zoomend", updateAutoChart);
  loadChartResources();
}

function installCommonChartSelector() {
  MapCore.createChartSelectorControl({
    L,
    map,
    baseMaps: baseLayers,
    getBaseMap: () => localStorage.getItem("ajrmMarineCaptureReviewBaseMap") || "NaturalEarth (offline)",
    setBaseMap,
    overlays: [
      { name: MapCore.OPEN_SEA_MAP_NAME, isEnabled: () => map.hasLayer(seamarkLayer), setEnabled: (enabled) => setOverlay(seamarkLayer, enabled, "ajrmMarineCaptureReviewOpenSeaMap") },
      { name: MapCore.AUTO_CHARTS_NAME, isEnabled: () => map.hasLayer(autoChartGroup), setEnabled: setAutoChartsEnabled },
    ],
    onFoldersChanged: async () => {
      await loadChartResources({ force: true });
      updateAutoChart();
    },
  }).addTo();
  chartCycle = MapCore.createChartCycleControl({
    L,
    map,
    getCharts: () => autoChartList,
		isEnabled: () => map.hasLayer(autoChartGroup),
    onChange: updateAutoChart,
    statusElement: elements.chartCycleStatus,
  }).addTo();
  mapActionToolbar = MapCore.createActionToolbarControl({
    L,
    map,
    actions: [
      { title: "Voyages", icon: MapCore.MAP_ACTION_ICONS.list, activate: () => elements.toggleVoyages.click(), isPressed: () => elements.voyageDrawer.classList.contains("open") },
      { title: "Refresh voyages", icon: MapCore.MAP_ACTION_ICONS.refresh, activate: () => elements.refreshVoyages.click() },
      { title: "Voyage summary", icon: MapCore.MAP_ACTION_ICONS.summary, activate: () => elements.toggleSummary.click(), isPressed: () => elements.summaryPanel.classList.contains("open") },
    ],
  }).addTo();
}

function makeNaturalEarthLayer() {
  if (window.protomapsL && window.protomapsL.leafletLayer) {
    const options = {
      url: "./ne_10m_land.pmtiles",
      flavor: "light",
      theme: "light",
      lang: "en",
      maxDataZoom: 5,
    };
    if (
      window.protomapsL.light &&
      window.protomapsL.paintRules &&
      window.protomapsL.labelRules
    ) {
      const theme = {
        ...window.protomapsL.light,
        water: "rgba(0,0,0,0)",
      };
      options.paintRules = window.protomapsL.paintRules(theme);
      options.labelRules = window.protomapsL.labelRules(theme);
    }
    return window.protomapsL.leafletLayer(options);
  }
  return L.tileLayer("", { attribution: "NaturalEarth unavailable" });
}

function setBaseMap(name) {
  if (!map || !baseLayers[name]) return;
  if (currentBaseLayer) map.removeLayer(currentBaseLayer);
  currentBaseLayer = baseLayers[name];
  currentBaseLayer.addTo(map);
  localStorage.setItem("ajrmMarineCaptureReviewBaseMap", name);
  for (const choice of elements.baseMapChoices) {
    choice.checked = choice.value === name;
  }
  keepChartLayersOnTop();
}

function setOverlay(layer, enabled, storageKey) {
  if (!map || !layer) return;
  if (enabled) layer.addTo(map);
  else map.removeLayer(layer);
  localStorage.setItem(storageKey, String(enabled));
  if (layer === autoChartGroup) {
    elements.autoCharts.checked = enabled;
    chartCycle?.update();
  }
  if (layer === seamarkLayer) elements.openSeaMap.checked = enabled;
  updateAutoChart();
  keepChartLayersOnTop();
}

async function setAutoChartsEnabled(enabled) {
  setOverlay(autoChartGroup, enabled, "ajrmMarineCaptureReviewAutoCharts");
  if (enabled && !chartResourcesLoaded) {
    elements.chartStatus.textContent = "Loading Signal K chart resources…";
    await loadChartResources({ force: true });
    updateAutoChart();
  }
}

function chartUrl(chart) {
  return chart?.tilemapUrl || chart?.url || chart?.tileUrl || chart?.href || "";
}

function chartZoom(chart) {
  const min = Number(chart?.minzoom ?? chart?.minZoom ?? 0);
  const max = Number(chart?.maxzoom ?? chart?.maxZoom ?? 24);
  return {
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 24,
  };
}

function chartBoundsCandidates(chart) {
  const source =
    chart?.bounds ||
    chart?.boundingBox ||
    chart?.extent ||
    chart?.bbox ||
    chart?.properties?.bounds ||
    chart?.properties?.bbox ||
    chart?.metadata?.bounds;
  const candidates = [];
  if (Array.isArray(source) && source.some(Array.isArray)) {
    const points = source
      .filter(Array.isArray)
      .map((point) => point.slice(0, 2).map(Number))
      .filter((point) => point.length === 2 && point.every(Number.isFinite));
    if (points.length >= 2) {
      const xs = points.map((point) => point[0]);
      const ys = points.map((point) => point[1]);
      candidates.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      candidates.push([Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)]);
    }
  } else {
    let bounds = null;
    if (Array.isArray(source)) {
      bounds = source.slice(0, 4).map(Number);
    } else if (typeof source === "string") {
      bounds = source.split(/[\\s,]+/).map(Number).filter(Number.isFinite).slice(0, 4);
    } else if (source && typeof source === "object") {
      if (source.sw && source.ne) {
        bounds = [
          source.sw.lng ?? source.sw.lon ?? source.sw[1],
          source.sw.lat ?? source.sw[0],
          source.ne.lng ?? source.ne.lon ?? source.ne[1],
          source.ne.lat ?? source.ne[0],
        ].map(Number);
      } else {
        bounds = [
          source.minLon ?? source.west ?? source.left ?? source.minx ?? source.xmin,
          source.minLat ?? source.south ?? source.bottom ?? source.miny ?? source.ymin,
          source.maxLon ?? source.east ?? source.right ?? source.maxx ?? source.xmax,
          source.maxLat ?? source.north ?? source.top ?? source.maxy ?? source.ymax,
        ].map(Number);
      }
    }
    if (bounds?.length >= 4) {
      const [a, b, c, d] = bounds;
      candidates.push([Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)]);
      candidates.push([Math.min(b, d), Math.min(a, c), Math.max(b, d), Math.max(a, c)]);
    }
  }
  return candidates.filter(
    (bounds) =>
      bounds.every(Number.isFinite) &&
      bounds[0] >= -180 &&
      bounds[2] <= 180 &&
      bounds[1] >= -90 &&
      bounds[3] <= 90 &&
      bounds[0] < bounds[2] &&
      bounds[1] < bounds[3],
  );
}

function chartBounds(chart, lat, lon) {
  const candidates = chartBoundsCandidates(chart);
  return (
    candidates.find(
      (bounds) => lon >= bounds[0] && lon <= bounds[2] && lat >= bounds[1] && lat <= bounds[3],
    ) ||
    candidates[0] ||
    null
  );
}

function chartContains(chart, lat, lon) {
  const bounds = chartBounds(chart, lat, lon);
  return Boolean(bounds && lon >= bounds[0] && lon <= bounds[2] && lat >= bounds[1] && lat <= bounds[3]);
}

function chartArea(chart, lat, lon) {
  const bounds = chartBounds(chart, lat, lon);
  return bounds ? Math.abs((bounds[2] - bounds[0]) * (bounds[3] - bounds[1])) : Number.MAX_VALUE;
}

function makeAutoChartLayer(chart) {
  const url = chartUrl(chart);
  if (!url) return null;
  const zoom = chartZoom(chart);
  return L.tileLayer(url, {
    minNativeZoom: zoom.min,
    maxNativeZoom: zoom.max,
    minZoom: zoom.min,
    maxZoom: 22,
    zIndex: chartLayerZIndex,
    attribution: "",
    errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
  });
}

function makeAutoChartFallbackLayer() {
  return L.tileLayer("", { attribution: "" });
}

function chooseAutoChart() {
  return map ? (chartCycle?.choose(autoChartList, map) ?? MapCore.chooseChart(autoChartList, map)) : null;
}

function updateAutoChart() {
  if (!map || !autoChartGroup || !map.hasLayer(autoChartGroup)) return;
  if (!chartResourcesLoaded) {
    elements.chartStatus.textContent = chartResourcesLoading
      ? "Loading Signal K chart resources…"
      : "Chart resources have not loaded yet.";
    return;
  }
  const chart = chooseAutoChart();
  if (!chart) {
    elements.chartStatus.textContent = autoChartList.length
      ? "No chart covers the current map centre."
      : "No Signal K chart resources found.";
    if (autoChartId === "__fallback") return;
    autoChartGroup.clearLayers();
    autoChartLayer = null;
    autoChartId = "__fallback";
    autoChartFallbackLayer = makeAutoChartFallbackLayer();
    autoChartGroup.addLayer(autoChartFallbackLayer);
    keepChartLayersOnTop();
    return;
  }
  elements.chartStatus.textContent = chart.name || chart.description || chart.__autoChartId || "Auto chart selected";
  if (autoChartId === chart.__autoChartId && autoChartLayer && autoChartGroup.hasLayer(autoChartLayer)) {
    keepChartLayersOnTop();
    return;
  }
  autoChartGroup.clearLayers();
  autoChartLayer = makeAutoChartLayer(chart);
  autoChartId = chart.__autoChartId;
  if (autoChartLayer) autoChartGroup.addLayer(autoChartLayer);
  keepChartLayersOnTop();
}

async function loadChartResources({ force = false } = {}) {
  if (chartResourcesLoading) return chartResourcesLoading;
  if (chartResourcesLoaded && !force) return autoChartList;
  chartResourcesLoading = (async () => {
    try {
      let charts = null;
      try {
        charts = await requestJson("/signalk/v1/api/resources/charts");
      } catch (_error) {
        const data = await requestJson(`${apiBase}/charts`);
        charts = data.charts || {};
      }
      autoChartList = MapCore.normalizeChartResources(charts);
      chartResourcesLoaded = true;
      elements.chartStatus.textContent = `${autoChartList.length} chart resource${autoChartList.length === 1 ? "" : "s"} found`;
      updateAutoChart();
    } catch (error) {
      autoChartList = [];
      chartResourcesLoaded = false;
      elements.chartStatus.textContent = `Chart resources not available: ${error.message}`;
    } finally {
      chartResourcesLoading = null;
    }
    return autoChartList;
  })();
  return chartResourcesLoading;
}

function keepChartLayersOnTop() {
  autoChartGroup?.eachLayer((layer) => layer.setZIndex?.(chartLayerZIndex));
  if (seamarkLayer && map?.hasLayer(seamarkLayer)) {
    seamarkLayer.setZIndex?.(seamarkLayerZIndex);
    seamarkLayer.bringToFront?.();
  }
  trackLayer?.eachLayer((layer) => layer.bringToFront?.());
  drTrackLayer?.eachLayer((layer) => layer.bringToFront?.());
  markerLayer?.eachLayer((layer) => layer.bringToFront?.());
}

async function loadFiles() {
  selectedFile = null;
  currentFiles = [];
  updateSelection();
  showSelectedPlaceholder();
  elements.statusLine.textContent = "Loading voyages…";
  elements.voyageList.innerHTML = "";
  try {
    const data = await requestJson(`${apiBase}/voyages`);
    currentFiles = data.voyages || [];
    renderFiles(currentFiles);
  } catch (error) {
    elements.statusLine.textContent = error.message;
    showToast(error.message, true);
  }
}

function renderFiles(files) {
  elements.statusLine.textContent = `${files.length} ${files.length === 1 ? "voyage" : "voyages"} found`;
  if (files.length === 0) {
    elements.voyageList.innerHTML = '<p class="empty">No voyages found in the configured directory.</p>';
    return;
  }
  elements.voyageList.replaceChildren(
    ...files.map((file) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "file-row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.innerHTML = `
        <strong>${escapeHtml(file.fileName)}</strong>
        ${file.comment ? `<span class="file-comment">${escapeHtml(file.comment)}</span>` : ""}
        ${file.recomputedReplay ? `<span class="file-comment">${escapeHtml(`Recomputed from ${file.recomputedReplay.parentVoyage || "unknown parent"} · ${replayLineageSummary(file.recomputedReplay)}`)}</span>` : ""}
        <span>${escapeHtml(fileMeta(file))}</span>
      `;
      row.addEventListener("click", () => selectFile(file));
      return row;
    }),
  );
}

function selectFile(file) {
  selectedFile = file;
  analysisRequestId += 1;
  for (const row of elements.voyageList.querySelectorAll(".file-row")) {
    const selected = row.querySelector("strong")?.textContent === file.fileName;
    row.classList.toggle("selected", selected);
    row.setAttribute("aria-selected", String(selected));
  }
  updateSelection();
  showSelectedPlaceholder();
}

function updateSelection() {
  const hasSelection = Boolean(selectedFile);
  elements.plotSelected.disabled = !hasSelection;
  elements.reviewSelected.disabled = !hasSelection;
  elements.centrePlot.disabled = !plottedBounds;
  setLinkEnabled(elements.downloadGpx, hasSelection);
  setLinkEnabled(elements.downloadSelected, hasSelection);
  if (!hasSelection) {
    elements.selectedDetails.textContent = "Select one of the voyages below.";
    elements.downloadGpx.href = "#";
    elements.downloadSelected.href = "#";
    return;
  }
  elements.selectedDetails.textContent = selectedFile.comment
    ? `${selectedFile.fileName} · ${selectedFile.comment} · ${fileMeta(selectedFile)}`
    : `${selectedFile.fileName} · ${fileMeta(selectedFile)}`;
  elements.downloadSelected.href = downloadUrl(selectedFile.fileName);
  elements.downloadSelected.download = selectedFile.fileName;
  elements.downloadGpx.href = gpxUrl(selectedFile.fileName);
  elements.downloadGpx.download = gpxFileName(selectedFile.fileName);
}

function showSelectedPlaceholder() {
  clearPlottedLayers();
  plottedBounds = null;
  currentAnalysis = null;
  drTrackVisible = false;
  elements.centrePlot.disabled = true;
  elements.toggleDrTrack.disabled = true;
  elements.toggleDrTrack.setAttribute("aria-pressed", "false");
  elements.summaryTitle.textContent = selectedFile?.fileName || "Voyage summary";
  elements.summarySubtitle.textContent = selectedFile
    ? "Press Plot to draw the track, or Review for the voyage summary."
    : "";
  elements.summaryGrid.replaceChildren();
  renderVoyageNotes([]);
  renderReview(null);
  elements.comment.textContent = "";
}

function clearPlottedLayers() {
  trackLayer?.clearLayers();
  drTrackLayer?.clearLayers();
  routeLayer?.clearLayers();
  markerLayer?.clearLayers();
}

async function analyseSelectedFile() {
  if (!selectedFile) return;
  await analyseFile(selectedFile.fileName, { plot: true });
}

async function reviewSelectedFile() {
  if (!selectedFile) return;
  await analyseFile(selectedFile.fileName, { plot: false });
}

async function analyseFile(fileName, { plot = true } = {}) {
  const requestId = ++analysisRequestId;
  if (plot) {
    clearPlottedLayers();
    plottedBounds = null;
    elements.centrePlot.disabled = true;
  }
  startPlotProgress(fileName);
  showToast(plot ? `Analysing ${fileName}…` : `Reviewing ${fileName}…`);
  elements.statusLine.textContent = plot ? `Analysing ${fileName}…` : `Reviewing ${fileName}…`;
  try {
    const data = await requestJson(
      `${apiBase}/voyages/${encodeURIComponent(fileName)}/analyse`,
      { method: "POST" },
    );
    if (requestId !== analysisRequestId || selectedFile?.fileName !== fileName) {
      return;
    }
    setPlotProgress(90, plot ? "Rendering track and summary…" : "Rendering review…");
    if (plot) {
      renderAnalysis(data.analysis, { showSummary: false });
      finishPlotProgress("Voyage plotted.");
      showToast("Voyage plotted.");
    } else {
      currentAnalysis = data.analysis;
      renderSummary(data.analysis);
      finishPlotProgress("Voyage reviewed.");
      showToast("Voyage reviewed.");
    }
  } catch (error) {
    failPlotProgress(error.message);
    showToast(error.message, true);
    elements.statusLine.textContent = error.message;
  }
}

function startPlotProgress(fileName) {
  clearInterval(progressTimer);
  elements.plotProgress.classList.remove("hidden", "failed");
  setPlotProgress(0, `Opening ${fileName}…`);
  progressTimer = setInterval(async () => {
    try {
      const response = await fetch(
        analysisProgressUrl(fileName),
        {
          cache: "no-store",
          headers: { Accept: "application/json" },
        },
      );
      if (!response.ok) return;
      const data = await response.json();
      const progress = data.progress || {};
      if (progress.state === "running" || progress.state === "complete") {
        setPlotProgress(
          Number(progress.percent || 0),
          progress.message || "Analysing voyage…",
        );
      }
    } catch {
      // The analysis request remains authoritative; a missed progress poll is harmless.
    }
  }, 500);
}

function setPlotProgress(percent, message) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  elements.progressBar.style.width = `${value}%`;
  elements.progressPercent.textContent = `${value}%`;
  elements.progressText.textContent = message;
}

function finishPlotProgress(message) {
  clearInterval(progressTimer);
  progressTimer = null;
  setPlotProgress(100, message);
  setTimeout(() => {
    elements.plotProgress.classList.add("hidden");
  }, 1200);
}

function failPlotProgress(message) {
  clearInterval(progressTimer);
  progressTimer = null;
  setPlotProgress(100, message || "Plot failed.");
  elements.plotProgress.classList.add("failed");
  setTimeout(() => {
    elements.plotProgress.classList.add("hidden");
    elements.plotProgress.classList.remove("failed");
  }, 4500);
}

function startExportProgress(fileName) {
  clearInterval(progressTimer);
  elements.plotProgress.classList.remove("hidden", "failed");
  setPlotProgress(8, `Preparing GPX export for ${fileName}…`);
  const stages = [
    [24, "Opening voyage…"],
    [42, "Reading track points…"],
    [62, "Building GPX file…"],
    [78, "Preparing download…"],
    [90, "Handing GPX to browser…"],
  ];
  let index = 0;
  progressTimer = setInterval(() => {
    if (index < stages.length) {
      setPlotProgress(stages[index][0], stages[index][1]);
      index += 1;
    }
  }, 650);
}

async function exportSelectedGpx(event) {
  event.preventDefault();
  if (!selectedFile || elements.downloadGpx.classList.contains("disabled")) return;
  const fileName = selectedFile.fileName;
  startExportProgress(fileName);
  showDownloadFeedback(elements.downloadGpx, "Preparing…");
  try {
    const response = await fetch(gpxUrl(fileName), { headers: { Accept: "application/gpx+xml" } });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || response.statusText || "GPX export failed");
    }
    setPlotProgress(94, "Saving GPX download…");
    const blob = await response.blob();
    downloadBlob(blob, elements.downloadGpx.download || gpxFileName(fileName));
    finishPlotProgress("GPX download ready.");
    showToast("GPX download ready.");
  } catch (error) {
    failPlotProgress(error.message);
    showToast(error.message, true);
  }
}

function downloadSelectedFile(event) {
  if (!selectedFile || elements.downloadSelected.classList.contains("disabled")) {
    event.preventDefault();
    return;
  }
  const fileName = selectedFile.fileName;
  elements.downloadSelected.href = downloadUrl(fileName);
  showDownloadFeedback(elements.downloadSelected, "Downloading…");
  showToast(
    `Downloading ${fileName}. The browser will stream it directly to disk.`,
  );
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "voyage.gpx";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function renderAnalysis(analysis, { showSummary = true } = {}) {
  currentAnalysis = analysis;
  const track = analysis.track || [];
  trackLayer.clearLayers();
  drTrackLayer.clearLayers();
  routeLayer.clearLayers();
  markerLayer.clearLayers();
  plottedBounds = null;
  if (track.length > 1) {
    const line = L.polyline(
      track.map((point) => [point.lat, point.lon]),
      { color: "#f97316", weight: 8, opacity: 0.92 },
    ).addTo(trackLayer);
    plottedBounds = line.getBounds();
    centrePlot();
    addEndMarker(track[0], "Start", "#22c55e");
    addEndMarker(track[track.length - 1], "Finish", "#ef4444");
  }
  drTrackVisible = Boolean(hasDrTracks(analysis.drTracks));
  elements.toggleDrTrack.disabled = !drTrackVisible;
  elements.toggleDrTrack.setAttribute("aria-pressed", String(drTrackVisible));
  renderDrTracks();
  renderVoyageRoutes(analysis.routes || []);
  renderVoyageNoteMarkers(analysis.observations || []);
  elements.centrePlot.disabled = !plottedBounds;
  for (const marker of analysis.hourlyMarkers || []) {
    L.marker([marker.lat, marker.lon], {
      icon: L.divIcon({
        className: "hour-marker",
        html: `<span>${escapeHtml(marker.label)}</span>`,
        iconSize: [54, 28],
        iconAnchor: [27, 14],
      }),
    }).addTo(markerLayer);
  }
  keepChartLayersOnTop();
  if (showSummary) {
    renderSummary(analysis);
  } else {
    elements.summaryTitle.textContent = analysis.fileName || analysis.id || "Voyage";
    elements.summarySubtitle.textContent = "Track plotted. Press Review for voyage summary and findings.";
    elements.summaryGrid.replaceChildren();
    renderReview(null);
  }
}

function hasDrTracks(drTracks) {
  return Boolean(
    drTracks &&
      ((drTracks.operational || []).length > 1 ||
        (drTracks.integrity || []).length > 1 ||
        (drTracks.recoveryJumps || []).length > 0),
  );
}

function renderDrTracks() {
  drTrackLayer.clearLayers();
  const drTracks = currentAnalysis?.drTracks;
  if (!drTrackVisible || !hasDrTracks(drTracks)) return;
  addTrackLine(drTracks.gps, { color: "#16a34a", weight: 3, opacity: 0.52 });
  addTrackLine(drTracks.operational, {
    color: "#0f172a",
    weight: 4,
    opacity: 0.72,
    dashArray: "2 8",
  });
  addTrackLine(drTracks.integrity, {
    color: "#f97316",
    weight: 3,
    opacity: 0.72,
    dashArray: "8 6",
  });
  for (const jump of drTracks.recoveryJumps || []) {
    if (!jump.from || !jump.to) continue;
    L.polyline(
      [[jump.from.lat, jump.from.lon], [jump.to.lat, jump.to.lon]],
      { color: "#dc2626", weight: 5, opacity: 0.85, dashArray: "10 5" },
    )
      .bindTooltip(`DR recovery jump ${Math.round(jump.meters || 0)} m`, { permanent: false })
      .addTo(drTrackLayer);
  }
  keepChartLayersOnTop();
}

function renderVoyageRoutes(routes) {
  routeLayer.clearLayers();
  for (const [index, route] of routes.entries()) {
    const points = (route.points || []).filter(
      (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon),
    );
    if (points.length < 2) continue;
    const line = L.polyline(points.map((point) => [point.lat, point.lon]), {
      color: "#2563eb",
      weight: index === routes.length - 1 ? 5 : 3,
      opacity: index === routes.length - 1 ? 0.8 : 0.35,
      dashArray: "12 8",
    }).bindTooltip(`${route.name}${route.reversed ? " (reversed)" : ""}`);
    line.addTo(routeLayer);
    const bounds = line.getBounds();
    plottedBounds = plottedBounds?.isValid?.() ? plottedBounds.extend(bounds) : bounds;
  }
}

function renderVoyageNoteMarkers(observations) {
  for (const [index, note] of observations.entries()) {
    if (!Number.isFinite(note.position?.lat) || !Number.isFinite(note.position?.lon)) continue;
    L.marker([note.position.lat, note.position.lon], {
      icon: L.divIcon({
        className: "voyage-note-marker",
        html: `<span>${index + 1}</span>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
    })
      .bindPopup(`<strong>Voyage note ${index + 1}</strong><br>${escapeHtml(note.text)}<br><small>${escapeHtml(formatDateTime(note.recordedAt))}</small>`)
      .addTo(markerLayer);
  }
}

function addTrackLine(points, options) {
  const valid = (points || []).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  if (valid.length < 2) return null;
  return L.polyline(valid.map((point) => [point.lat, point.lon]), options).addTo(drTrackLayer);
}

function centrePlot() {
  if (!map || !plottedBounds?.isValid?.()) return;
  const leftPadding = elements.voyageDrawer.classList.contains("open") ? 380 : 28;
  const bottomPadding = elements.summaryPanel.classList.contains("open")
    ? Math.min(260, Math.round(elements.summaryPanel.getBoundingClientRect().height) + 24)
    : 28;
  map.fitBounds(plottedBounds, {
    paddingTopLeft: [leftPadding, 96],
    paddingBottomRight: [28, bottomPadding],
    maxZoom: 17,
  });
  setTimeout(updateAutoChart, 0);
  keepChartLayersOnTop();
}

function addEndMarker(point, label, color) {
  L.circleMarker([point.lat, point.lon], {
    radius: 7,
    color: "#fff",
    weight: 2,
    fillColor: color,
    fillOpacity: 1,
  }).bindTooltip(label, { permanent: false }).addTo(markerLayer);
}

function renderSummary(analysis) {
  const summary = analysis.summary || {};
  const gpsIntegrity = analysis.gpsIntegrity || summary.gpsIntegrity;
  elements.summaryTitle.textContent = analysis.fileName || analysis.id || "Voyage";
  elements.summarySubtitle.textContent = `${formatDateTime(summary.startedAt)} → ${formatDateTime(summary.stoppedAt)}`;
  elements.downloadGpx.href = analysis.gpxUrl || gpxUrl(analysis.fileName);
  elements.downloadGpx.download = gpxFileNameFromAnalysis(analysis);
  setLinkEnabled(elements.downloadGpx, true);
  elements.comment.textContent = "";
  const rows = [
    ["Duration", formatDuration(summary.durationSeconds)],
    ["Distance", formatNumber(summary.distanceNm, 1, " NM")],
    ["Avg", formatNumber(summary.averageSpeedKnots, 1, " kn")],
    ["Avg SOG", formatNumber(summary.averageRecordedSogKnots, 1, " kn")],
    ["Max SOG", formatNumber(summary.maxSogKnots, 1, " kn")],
    ["Max AWS", formatNumber(summary.maxApparentWindKnots, 1, " kn")],
    ["Max TWS", formatNumber(summary.maxTrueWindKnots, 1, " kn")],
    ["Min depth", formatNumber(summary.minDepthMeters, 1, " m")],
    ["Pilot helm bias", formatRudderSummary(summary.rudder)],
    ["Water temperature", formatWaterTemperatureSummary(summary.waterTemperature)],
    ["Points", `${summary.trackPoints || 0} (${analysis.track?.length || 0} plotted)`],
    ["DR track", drTrackSummary(analysis.drTracks)],
    ["DR evidence", drEvidenceSummary(analysis.drTracks, gpsIntegrity)],
    ["Integrity comparison", integrityAssuranceSummary(analysis.drTracks, gpsIntegrity)],
    ["Navigation reference", navigationReferenceSummary(analysis.drTracks, gpsIntegrity)],
    ["Route", voyageRouteSummary(analysis.routes)],
    ["Notes", String((analysis.observations || []).length)],
    ["GPS integrity", gpsIntegritySummary(gpsIntegrity)],
    ["GPS outages", gpsOutageSummary(gpsIntegrity)],
    ["GPS rejected", gpsRejectedSummary(gpsIntegrity)],
    ["GPS/DR mismatch", gpsDrMismatchSummary(gpsIntegrity)],
    ["Traffic", trafficSummary(analysis.traffic || summary.traffic)],
    ["Snapshots", String(summary.snapshotCount || 0)],
    ["Start", summary.startReason || "—"],
    ["Stop", summary.stopReason || "—"],
  ];
  if (analysis.comment) {
    rows.push(["Comment", `“${analysis.comment}”`]);
  }
  if (analysis.recomputedReplay) {
    rows.push([
      "Replay lineage",
      `${analysis.recomputedReplay.parentVoyage || "Unknown parent"} · ${replayLineageSummary(analysis.recomputedReplay)}`,
    ]);
  }
  elements.summaryGrid.replaceChildren(
    ...rows.map(([label, value]) => {
      const item = document.createElement("div");
      item.className = "summary-item";
      item.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
      return item;
    }),
  );
  renderVoyageNotes(analysis.observations || []);
  renderReview(analysis.review);
}

function renderReview(review) {
  const panel = elements.reviewPanel;
  if (!panel) return;
  if (!review) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  panel.hidden = false;
  const statusRow = document.createElement("div");
  statusRow.className = "review-status-row";
  if (review.softwareStatus) statusRow.append(reviewLight("Software", review.softwareStatus));
  statusRow.append(reviewLight("Voyage data", review.voyageStatus || review.status || "amber"));

  const headline = document.createElement("p");
  headline.className = "review-headline";
  headline.textContent = review.headline || "Voyage review complete.";

  const conclusion = document.createElement("p");
  conclusion.className = "review-conclusion";
  conclusion.textContent = review.conclusion || "";

  const highlights = document.createElement("div");
  highlights.className = "review-highlights";
  for (const highlight of review.highlights || []) {
    const item = document.createElement("div");
    item.className = `review-highlight ${reviewLevelClass(highlight.level)}`;
    item.innerHTML = `
      <span>${escapeHtml(highlight.label || "")}</span>
      <strong>${escapeHtml(highlight.value || "")}</strong>
    `;
    highlights.append(item);
  }

  const paragraphs = document.createElement("div");
  paragraphs.className = "review-copy";
  for (const text of review.paragraphs || []) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    paragraphs.append(paragraph);
  }

  const list = document.createElement("div");
  list.className = "review-findings";
  for (const finding of review.findings || []) {
    const item = document.createElement("article");
    item.className = `review-finding ${reviewLevelClass(finding.level)}`;
    item.innerHTML = `
      <strong>${escapeHtml(finding.title || "Finding")}</strong>
      <span>${escapeHtml(finding.category === "software" ? "Software" : "Voyage data")}</span>
      <p>${escapeHtml(finding.detail || "")}</p>
    `;
    list.append(item);
  }

  const children = [statusRow, headline];
  if (conclusion.textContent) children.push(conclusion);
  if (highlights.childElementCount) children.push(highlights);
  children.push(paragraphs, list);
  panel.replaceChildren(...children);
}

function reviewLight(label, level) {
  const item = document.createElement("div");
  item.className = `review-light ${reviewLevelClass(level)}`;
  item.innerHTML = `<span aria-hidden="true"></span><strong>${escapeHtml(label)}</strong><em>${escapeHtml(String(level || "unknown").toUpperCase())}</em>`;
  return item;
}

function reviewLevelClass(level) {
  if (level === "green" || level === "red" || level === "amber") return level;
  return "amber";
}

function replayLineageSummary(replay) {
  if (!replay) return "—";
  const complete =
    replay.coverage &&
    replay.coverage.complete === true &&
    replay.coverage.preparedComplete === true &&
    replay.coverage.lastReason === "end of canonical input";
  if (!complete) return "incomplete coverage";
  if (replay.liveInputIsolation && replay.liveInputIsolation.valid === false) {
    return "live-input contamination detected";
  }
  if (replay.liveInputIsolation && replay.liveInputIsolation.valid === true) {
    return "complete and isolated";
  }
  return "complete · isolation unverified";
}

function gpsIntegritySummary(gpsIntegrity) {
  const summary = gpsIntegrity?.summary || gpsIntegrity || {};
  if (!summary.available) return "—";
  const trust = summary.finalTrust ? titleCase(summary.finalTrust) : "Unknown";
  const evaluations = Number.isFinite(summary.evaluations) ? `${summary.evaluations} evals` : `${summary.samples || 0} samples`;
  const comparison = summary.finalComparisonAvailable === false
    ? ` · ${titleCase(summary.finalIntegrityAssurance || "DR")} comparison unavailable`
    : "";
  const lastReason = summary.finalTrust && summary.finalTrust !== "normal" && summary.lastReason
    ? ` · ${summary.lastReason}`
    : "";
  return `${trust} · ${evaluations}${comparison}${lastReason}`;
}

function trafficSummary(traffic) {
  const summary = traffic || {};
  if (!summary.available) return "—";
  const sizes = [];
  if (summary.bySize?.small) sizes.push(`${summary.bySize.small} S`);
  if (summary.bySize?.medium) sizes.push(`${summary.bySize.medium} M`);
  if (summary.bySize?.large) sizes.push(`${summary.bySize.large} L`);
  if (summary.bySize?.unknown) sizes.push(`${summary.bySize.unknown} ?`);
  return `${summary.vesselsEncountered || 0} vessels${sizes.length ? ` (${sizes.join(", ")})` : ""} · ${summary.advisories || 0} adv · ${summary.collisionAlerts || 0} coll`;
}

function gpsOutageSummary(gpsIntegrity) {
  const summary = gpsIntegrity?.summary || gpsIntegrity || {};
  if (!summary.available) return "—";
  const count = Number.isFinite(summary.lostFixes) ? summary.lostFixes : summary.lostPeriods || 0;
  if (!count) return "None";
  return `${count} · ${formatDuration(summary.totalLostSeconds || 0)} total · ${formatDuration(summary.longestLostSeconds || 0)} longest`;
}

function gpsRejectedSummary(gpsIntegrity) {
  const summary = gpsIntegrity?.summary || gpsIntegrity || {};
  if (!summary.available) return "—";
  const rejected = summary.rejectedFixes || 0;
  const jumps = summary.positionJumps || 0;
  if (!rejected && !jumps) return "None";
  return `${rejected} rejected · ${jumps} jump${jumps === 1 ? "" : "s"}`;
}

function gpsDrMismatchSummary(gpsIntegrity) {
  const summary = gpsIntegrity?.summary || gpsIntegrity || {};
  if (!summary.available) return "—";
  const mismatches = summary.drDiscrepancies || 0;
  const uncertainty = Number.isFinite(summary.maxOperationalUncertaintyMeters)
    ? ` · max DR ${Math.round(summary.maxOperationalUncertaintyMeters)} m`
    : "";
  if (summary.finalComparisonAvailable === false) {
    const assurance = summary.finalIntegrityAssurance
      ? ` · ${titleCase(summary.finalIntegrityAssurance)}`
      : "";
    return mismatches
      ? `${mismatches} recorded · now unavailable${assurance}${uncertainty}`
      : `Unavailable${assurance}${uncertainty}`;
  }
  return mismatches ? `${mismatches}${uncertainty}` : `None${uncertainty}`;
}

function titleCase(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function drTrackSummary(drTracks) {
  if (!hasDrTracks(drTracks)) return "—";
  const source = drTracks.source === "bundle" ? "bundle" : "capture";
  const operational = drTracks.original?.operational || (drTracks.operational || []).length;
  const jumps = (drTracks.recoveryJumps || []).length;
  return jumps ? `${operational} points · ${jumps} jump${jumps === 1 ? "" : "s"} · ${source}` : `${operational} points · ${source}`;
}

function drEvidenceSummary(drTracks, gpsIntegrity) {
  const evidence =
    drTracks?.provenance?.operational ||
    gpsIntegrity?.provenance?.operational ||
    null;
  if (!evidence) return "—";
  const parts = [];
  if (evidence.source) parts.push(evidence.source);
  const dependency = formatGpsDependence(evidence.gpsDependent, "not recorded");
  if (dependency !== "not recorded") parts.push(dependency);
  if (evidence.leewayStatus) parts.push(`leeway ${evidence.leewayStatus}`);
  if (evidence.currentOrigin) parts.push(`current ${evidence.currentOrigin}`);
  return parts.join(" · ") || "—";
}

function integrityAssuranceSummary(drTracks, gpsIntegrity) {
  const trackAssurance = drTracks?.provenance?.integrityAssurance;
  const trackIntegrity = drTracks?.provenance?.integrity;
  const gpsSummary = gpsIntegrity?.summary || gpsIntegrity || {};
  const assurance =
    trackIntegrity?.assurance ||
    trackAssurance?.status ||
    gpsSummary.finalIntegrityAssurance ||
    null;
  const comparisonAvailable =
    trackIntegrity?.comparisonAvailable ??
    trackAssurance?.comparisonAvailable ??
    gpsSummary.finalComparisonAvailable ??
    null;
  const parts = [];
  if (assurance) parts.push(titleCase(assurance));
  if (comparisonAvailable === true) parts.push("comparison active");
  if (comparisonAvailable === false) parts.push("comparison unavailable");
  const dependency =
    trackIntegrity?.gpsDependent ??
    gpsIntegrity?.provenance?.integrity?.gpsDependent ??
    gpsSummary.finalIntegrityGpsDependent ??
    null;
  const dependencyText = formatGpsDependence(dependency, "not recorded");
  if (dependencyText !== "not recorded") parts.push(dependencyText);
  const suppressed = Number(drTracks?.suppressedIntegrityComparisons) || 0;
  if (suppressed > 0) {
    parts.push(`${suppressed} unavailable sample${suppressed === 1 ? "" : "s"} not plotted`);
  }
  return parts.join(" · ") || "—";
}

function navigationReferenceSummary(drTracks, gpsIntegrity) {
  const reference =
    drTracks?.provenance?.navigationReference ||
    gpsIntegrity?.provenance?.navigationReference ||
    gpsIntegrity?.summary?.navigationReference ||
    gpsIntegrity?.navigationReference ||
    null;
  const clock = reference?.clockReference;
  if (!clock) return "—";
  const parts = [];
  if (clock.kind) parts.push(titleCase(clock.kind));
  if (clock.source) parts.push(clock.source);
  if (clock.method) parts.push(clock.method);
  const dependency = formatGpsDependence(clock.gpsDependent, "not recorded");
  if (dependency !== "not recorded") parts.push(dependency);
  const uncertainty = finiteNumberOrNull(clock.uncertaintyRad);
  if (uncertainty !== null) {
    parts.push(`±${Math.abs(uncertainty * 180 / Math.PI).toFixed(1)} deg`);
  }
  return parts.join(" · ") || "—";
}

function formatGpsDependence(value, fallback = "n/a") {
  if (value === true) return "GPS-dependent";
  if (value === false) return "GPS-independent";
  return fallback;
}

function voyageRouteSummary(routes = []) {
  if (!routes.length) return "none recorded";
  const latest = routes[routes.length - 1];
  if (latest.closed) return "closed before voyage end";
  return `${latest.name}${latest.reversed ? " (reversed)" : ""}${routes.length > 1 ? ` · ${routes.length} states` : ""}`;
}

function renderVoyageNotes(observations) {
  const notes = Array.isArray(observations) ? observations : [];
  elements.notesPanel.hidden = notes.length === 0;
  elements.notesList.replaceChildren();
  for (const [index, note] of notes.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "voyage-note";
    button.disabled = !Number.isFinite(note.position?.lat) || !Number.isFinite(note.position?.lon);
    button.innerHTML = `
      <span>${escapeHtml(formatDateTime(note.recordedAt))}</span>
      <strong>${escapeHtml(note.text || "Untitled note")}</strong>
      ${note.evidenceError ? `<small>Evidence: ${escapeHtml(note.evidenceError)}</small>` : ""}
    `;
    button.title = button.disabled
      ? "This note has no recorded chart position"
      : `Centre chart on note ${index + 1}`;
    button.addEventListener("click", () => {
      if (button.disabled) return;
      map.setView([note.position.lat, note.position.lon], Math.max(map.getZoom(), 15));
      for (const layer of markerLayer.getLayers()) {
        const position = layer.getLatLng?.();
        if (position && position.lat === note.position.lat && position.lng === note.position.lon) {
          layer.openPopup?.();
          break;
        }
      }
    });
    elements.notesList.append(button);
  }
}

function gpxUrl(fileName) {
  return `${apiBase}/voyages/${encodeURIComponent(fileName)}/track.gpx`;
}

function downloadUrl(fileName) {
  return `${apiBase}/voyages/${encodeURIComponent(fileName)}/download`;
}

function analysisProgressUrl(fileName) {
  return `${apiBase}/voyages/${encodeURIComponent(fileName)}/analysis-progress`;
}

function gpxFileName(fileName) {
  return `${String(fileName || "voyage").replace(/\\.(zip|jsonl|jsonl\\.gz)$/i, "")}.gpx`;
}

function gpxFileNameFromAnalysis(analysis) {
  const commentName = safeFileStem(analysis.comment || "");
  return `${commentName || String(analysis.id || analysis.fileName || "voyage").replace(/\\.(zip|jsonl|jsonl\\.gz)$/i, "")}.gpx`;
}

function safeFileStem(value) {
  return String(value || "")
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString([], {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatPosition(point) {
  const lat = finiteNumberOrNull(point?.lat);
  const lon = finiteNumberOrNull(point?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "n/a";
  return `${Math.abs(lat).toFixed(5)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(5)}°${lon >= 0 ? "E" : "W"}`;
}

function formatMeters(value) {
  const number = finiteNumberOrNull(value);
  return number !== null ? `${Math.round(number)} m` : "n/a";
}

function formatDistance(value) {
  const meters = finiteNumberOrNull(value);
  if (meters === null) return "n/a";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1852).toFixed(meters < 3704 ? 1 : 0)} miles`;
}

function formatAge(value) {
  const seconds = finiteNumberOrNull(value);
  if (seconds === null) return "n/a";
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

function formatKnotsFromMps(value) {
  const number = finiteNumberOrNull(value);
  return number !== null ? `${(number * 1.9438444924406046).toFixed(1)} kn` : "n/a";
}

function formatDegrees(value) {
  const number = finiteNumberOrNull(value);
  return number !== null ? `${Math.round(number)} deg` : "n/a";
}

function popupRow(label, value) {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds)) || seconds <= 0) return "—";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${total % 60}s`;
}

function formatNumber(value, digits, suffix) {
  const number = finiteNumberOrNull(value);
  if (number === null) return "—";
  return `${number.toFixed(digits)}${suffix}`;
}

function formatRudderSummary(summary) {
  const excluded = Number(summary?.excludedSampleCount) || 0;
  const excludedText = excluded > 0 ? ` · ${excluded} standby/unavailable excluded` : "";
  if (summary?.available !== true) {
    return excluded > 0 ? `No engaged-pilot samples · ${excluded} standby/unavailable excluded` : "—";
  }
  const median = finiteNumberOrNull(summary.medianAngleDegrees);
  const typical = finiteNumberOrNull(summary.medianAbsoluteAngleDegrees);
  const medianText = median === null
    ? "median unavailable"
    : Math.abs(median) < 0.05
      ? "median amidships"
      : `median ${Math.abs(median).toFixed(1)}° ${median < 0 ? "port" : "starboard"}`;
  const typicalText = typical === null ? "" : ` · typical deflection ${typical.toFixed(1)}°`;
  return `${medianText}${typicalText} · ${summary.sampleCount || 0} engaged samples${excludedText}`;
}

function formatWaterTemperatureSummary(summary) {
  if (summary?.available !== true) return "—";
  const average = formatNumber(summary.averageCelsius, 1, "°C average");
  const minimum = formatNumber(summary.minimumCelsius, 1, "°C min");
  const maximum = formatNumber(summary.maximumCelsius, 1, "°C max");
  return `${average} · ${minimum} · ${maximum}`;
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatBytes(bytes) {
  const number = Number(bytes);
  if (!Number.isFinite(number)) return "—";
  if (number > 1024 * 1024 * 1024) return `${(number / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (number > 1024 * 1024) return `${(number / 1024 / 1024).toFixed(1)} MB`;
  return `${(number / 1024).toFixed(1)} KB`;
}

function fileMeta(file) {
  const date = file.startedAt || file.modifiedAt;
  const parts = [formatDateTime(date), formatBytes(file.bytes)];
  if (file.stoppedAt) parts.push(`to ${formatDateTime(file.stoppedAt)}`);
  if (file.compressed) parts.push("compressed");
  return parts.filter((part) => part && part !== "—").join(" · ") || "—";
}

function setLinkEnabled(link, enabled) {
  link.classList.toggle("disabled", !enabled);
  link.setAttribute("aria-disabled", String(!enabled));
  if (!enabled) link.href = "#";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function refreshMapLayout() {
  map.invalidateSize({ pan: false });
  updateAutoChart();
}

function showDownloadFeedback(link, temporaryText = "Downloading…") {
  if (!link) return;
  if (link.classList.contains("disabled") || link.getAttribute("aria-disabled") === "true") return;
  const originalText = link.dataset.originalText || link.textContent;
  link.dataset.originalText = originalText;
  link.classList.add("downloading");
  link.textContent = temporaryText;
  showToast("Preparing download…");
  setTimeout(() => {
    link.classList.remove("downloading");
    link.textContent = originalText;
  }, 1400);
}

function syncPanelButtons() {
  elements.toggleVoyages.setAttribute("aria-pressed", String(elements.voyageDrawer.classList.contains("open")));
  elements.toggleCharts.setAttribute("aria-pressed", String(elements.chartDrawer.classList.contains("open")));
  elements.toggleSummary.setAttribute("aria-pressed", String(elements.summaryPanel.classList.contains("open")));
  mapActionToolbar?.update();
}

function togglePanel(panel) {
  const open = !panel.classList.contains("open");
  panel.classList.toggle("open", open);
  syncPanelButtons();
  setTimeout(refreshMapLayout, 180);
}

elements.toggleVoyages.addEventListener("click", () => togglePanel(elements.voyageDrawer));
elements.toggleCharts.addEventListener("click", () => togglePanel(elements.chartDrawer));
elements.refreshVoyages.addEventListener("click", loadFiles);
elements.plotSelected.addEventListener("click", analyseSelectedFile);
elements.reviewSelected.addEventListener("click", reviewSelectedFile);
elements.centrePlot.addEventListener("click", centrePlot);
elements.toggleDrTrack.addEventListener("click", () => {
  if (!hasDrTracks(currentAnalysis?.drTracks)) return;
  drTrackVisible = !drTrackVisible;
  elements.toggleDrTrack.setAttribute("aria-pressed", String(drTrackVisible));
  renderDrTracks();
});
elements.toggleSummary.addEventListener("click", () => {
  const open = !elements.summaryPanel.classList.contains("open");
  elements.summaryPanel.classList.toggle("open", open);
  syncPanelButtons();
  setTimeout(refreshMapLayout, 180);
});
for (const choice of elements.baseMapChoices) {
  choice.addEventListener("change", () => {
    if (choice.checked) setBaseMap(choice.value);
  });
}
elements.autoCharts.addEventListener("change", () =>
  setAutoChartsEnabled(elements.autoCharts.checked).catch((error) => showToast(error.message, true)),
);
elements.openSeaMap.addEventListener("change", () =>
  setOverlay(seamarkLayer, elements.openSeaMap.checked, "ajrmMarineCaptureReviewOpenSeaMap"),
);
elements.downloadGpx.addEventListener("click", (event) => {
  exportSelectedGpx(event);
});
elements.downloadSelected.addEventListener("click", (event) => {
  downloadSelectedFile(event);
});

initMap();
syncPanelButtons();
showSelectedPlaceholder();
loadFiles();
