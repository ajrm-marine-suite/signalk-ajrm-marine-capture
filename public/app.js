const API = "/plugins/signalk-ajrm-marine-capture";

const elements = {
  banner: document.getElementById("banner"),
  refreshButton: document.getElementById("refreshButton"),
  enabledToggle: document.getElementById("enabledToggle"),
  stateValue: document.getElementById("stateValue"),
  voyageValue: document.getElementById("voyageValue"),
  speedValue: document.getElementById("speedValue"),
  thresholdValue: document.getElementById("thresholdValue"),
  modeValue: document.getElementById("modeValue"),
  captureValue: document.getElementById("captureValue"),
  snapshotValue: document.getElementById("snapshotValue"),
  diskValue: document.getElementById("diskValue"),
  bundleValue: document.getElementById("bundleValue"),
  indexValue: document.getElementById("indexValue"),
  eventValue: document.getElementById("eventValue"),
  events: document.getElementById("events"),
  voyageBundles: document.getElementById("voyageBundles"),
  downloadSelectedBundle: document.getElementById("downloadSelectedBundle"),
  downloadPopup: document.getElementById("downloadPopup"),
  downloadPopupMessage: document.getElementById("downloadPopupMessage"),
  deleteSelectedBundle: document.getElementById("deleteSelectedBundle"),
  selectedBundleInfo: document.getElementById("selectedBundleInfo"),
  startButton: document.getElementById("startButton"),
  stopButton: document.getElementById("stopButton"),
  startReplayCaptureButton: document.getElementById("startReplayCaptureButton"),
  stopReplayCaptureButton: document.getElementById("stopReplayCaptureButton"),
  replayCaptureInfo: document.getElementById("replayCaptureInfo"),
  commentInput: document.getElementById("commentInput"),
  saveCommentButton: document.getElementById("saveCommentButton"),
};

let selectedBundle = null;
let pendingRecorderAction = null;
let recorderActionLatch = null;
let pendingReplayAction = null;
let latestStatus = null;

elements.refreshButton.addEventListener("click", refresh);
elements.enabledToggle.addEventListener("change", () =>
  command("/settings", { enabled: elements.enabledToggle.checked }),
);
elements.startButton.addEventListener("click", () => recorderCommand("start", "/voyage/start", {
  manual: true,
  comment: elements.commentInput.value,
}));
elements.stopButton.addEventListener("click", () => recorderCommand("stop", "/voyage/stop", { manual: true }));
elements.startReplayCaptureButton.addEventListener("click", () =>
  replayRecorderCommand("start", "/voyage/replay/start", {
    comment: elements.commentInput.value,
  }),
);
elements.stopReplayCaptureButton.addEventListener("click", () =>
  replayRecorderCommand("stop", "/voyage/replay/stop", {}),
);
elements.saveCommentButton.addEventListener("click", () =>
  command("/voyage/comment", { comment: elements.commentInput.value }),
);
elements.deleteSelectedBundle.addEventListener("click", () => {
  if (selectedBundle) deleteVoyage(selectedBundle.fileName);
});
elements.downloadSelectedBundle.addEventListener("click", (event) => {
  event.preventDefault();
  if (elements.downloadSelectedBundle.classList.contains("disabled")) {
    return;
  }
  downloadSelectedVoyage(selectedBundle);
});

refresh();
setInterval(refresh, 5000);

async function refresh() {
  try {
    const response = await fetch(`${API}/status`, { cache: "no-store" });
    const status = await response.json();
    if (!response.ok || !status.ok) throw new Error(status.error || "Status failed");
    latestStatus = status;
    render(status);
  } catch (error) {
    elements.banner.textContent = error.message || String(error);
    elements.banner.classList.add("error");
  }
}

async function command(path, body) {
  elements.banner.textContent = "Working...";
  elements.banner.classList.remove("error");
  try {
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.error || `Command failed: HTTP ${response.status}`);
    }
    await refresh();
    return true;
  } catch (error) {
    elements.banner.textContent = error.message || "Command failed";
    elements.banner.classList.add("error");
    return false;
  }
}

async function recorderCommand(action, path, body) {
  pendingRecorderAction = action;
  renderRecorderButtons({ currentVoyage: action === "stop" ? true : null });
  try {
    const ok = await command(path, body);
    recorderActionLatch = ok ? action : null;
  } finally {
    pendingRecorderAction = null;
    renderRecorderButtons(latestStatus || {});
  }
}

function render(status) {
  elements.banner.textContent = status.enabled
    ? "Automatic voyage recording is enabled."
    : "Automatic voyage recording is disabled.";
  elements.enabledToggle.checked = status.enabled === true;
  elements.stateValue.textContent = status.state || "-";
  elements.voyageValue.textContent = status.currentVoyage
    ? `${status.currentVoyage.id} since ${formatTime(status.currentVoyage.startedAt)}`
    : "-";
  if (document.activeElement !== elements.commentInput) {
    elements.commentInput.value = status.voyageComment || "";
  }
  elements.speedValue.textContent = Number.isFinite(status.speedKnots)
    ? `${status.speedKnots.toFixed(1)} kn`
    : "-";
  elements.thresholdValue.textContent = status.thresholds
    ? `${Number(status.thresholds.movementSpeedKnots || 0).toFixed(2)} kn / ${Number(status.thresholds.movementSpeedMetersPerSecond || 0).toFixed(2)} m/s`
    : "-";
  elements.modeValue.textContent = `${titleCase(status.captureMode || "voyage")} / ${titleCase(status.captureFileMode || "portable")}`;
  elements.captureValue.textContent = status.ajrmMarineLogger && status.ajrmMarineLogger.ok
    ? captureText(status.ajrmMarineLogger)
    : "not available";
  elements.snapshotValue.textContent = status.currentVoyage
    ? `${status.currentVoyage.snapshotCount || 0}`
    : "-";
  elements.diskValue.textContent = status.disk
    ? `${formatBytes(status.disk.availableBytes)} free (${status.disk.usedPercent || 0}% used)`
    : "-";
  elements.bundleValue.textContent = status.lastBundle && status.lastBundle.fileName || "-";
  elements.indexValue.textContent = status.lastBundle && status.lastBundle.indexFile || "-";
  const recent = status.recentEvents || [];
  elements.eventValue.textContent = recent[0] ? `${formatTime(recent[0].at)} ${recent[0].message}` : "-";
  elements.events.innerHTML = recent
    .map((event) => `<li><strong>${escapeHtml(formatTime(event.at))}</strong> ${escapeHtml(event.type)} — ${escapeHtml(event.message)}</li>`)
    .join("");
  renderVoyageBundles(status.voyages || []);
  renderRecorderButtons(status);
  renderReplayRecorder(status);
}

function renderRecorderButtons(status) {
  const activeVoyage = status.currentVoyage === null ? null : Boolean(status.currentVoyage);
  const recomputedActive = Boolean(
    status.currentVoyage && status.currentVoyage.recomputedReplay,
  );
  if (recorderActionLatch === "start" && activeVoyage === true) recorderActionLatch = null;
  if (recorderActionLatch === "stop" && activeVoyage === false) recorderActionLatch = null;
  const busy = pendingRecorderAction === "start" || pendingRecorderAction === "stop";
  const playbackActive = Boolean(status.ajrmMarineLogger && status.ajrmMarineLogger.playback &&
    status.ajrmMarineLogger.playback.active);
  elements.startButton.disabled = busy || recorderActionLatch === "start" || activeVoyage === true || playbackActive;
  elements.stopButton.disabled =
    busy ||
    recorderActionLatch === "stop" ||
    activeVoyage === false ||
    recomputedActive;
  elements.startButton.textContent = pendingRecorderAction === "start" ? "Starting..." : "Start now";
  elements.stopButton.textContent = pendingRecorderAction === "stop" ? "Stopping..." : "Stop now";
}

async function replayRecorderCommand(action, path, body) {
  pendingReplayAction = action;
  renderReplayRecorder(latestStatus || {});
  try {
    await command(path, body);
  } finally {
    pendingReplayAction = null;
    renderReplayRecorder(latestStatus || {});
  }
}

function renderReplayRecorder(status) {
  const playback = status.ajrmMarineLogger && status.ajrmMarineLogger.playback || {};
  const currentVoyage = status.currentVoyage || null;
  const recomputedActive = Boolean(currentVoyage && currentVoyage.recomputedReplay);
  const sourceIds = playback.sourcePolicy &&
    (
      playback.sourcePolicy.resolvedSensorSourceIds ||
      playback.sourcePolicy.sensorSourceIds
    ) || [];
  const ready = playback.loaded &&
    playback.mode === "sensor-sources" &&
    playback.sourcePolicy &&
    playback.sourcePolicy.id === "strict-recorded-sensor-source-allowlist-v1" &&
    sourceIds.length > 0 &&
    playback.rate === 1 &&
    !playback.active &&
    !playback.paused &&
    Number(playback.cursor || 0) === Number(playback.startCursor || 0);
  const playbackComplete =
    playback.coverage &&
    playback.coverage.complete === true &&
    playback.coverage.preparedComplete === true &&
    (playback.lastReason || playback.coverage.lastReason) === "end of capture" &&
    !playback.active &&
    !playback.paused;
  const busy = pendingReplayAction === "start" || pendingReplayAction === "stop";
  elements.startReplayCaptureButton.disabled = busy || Boolean(currentVoyage) || !ready;
  elements.stopReplayCaptureButton.disabled =
    busy || !recomputedActive || !playbackComplete;
  elements.startReplayCaptureButton.textContent =
    pendingReplayAction === "start" ? "Starting..." : "Start replay result";
  elements.stopReplayCaptureButton.textContent =
    pendingReplayAction === "stop" ? "Building ZIP..." : "Stop and build ZIP";
  if (recomputedActive) {
    elements.replayCaptureInfo.textContent =
      `Capturing recomputed replay of ${currentVoyage.recomputedReplay.parentVoyage || "parent voyage"}.`;
  } else if (ready) {
    elements.replayCaptureInfo.textContent =
      `Ready: ${playback.displayFileName || playback.fileName || "loaded voyage"}; exact sensors ${sourceIds.join(", ")}.`;
  } else if (
    playback.loaded &&
    playback.mode === "sensor-sources" &&
    playback.rate !== 1
  ) {
    elements.replayCaptureInfo.textContent =
      "Select 1x in AJRM Marine Logger before starting the result capture.";
  } else if (
    playback.loaded &&
    playback.mode === "sensor-sources" &&
    sourceIds.length === 0
  ) {
    elements.replayCaptureInfo.textContent =
      "No exact recorded sensor source IDs were resolved. Check the source policy in Logger.";
  } else if (playback.loaded) {
    elements.replayCaptureInfo.textContent =
      "Loaded playback is not in Sensor sources only mode. Change the mode in AJRM Marine Logger.";
  } else {
    elements.replayCaptureInfo.textContent =
      "Load a voyage in Logger using Sensor sources only mode.";
  }
}

function titleCase(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function renderVoyageBundles(voyages) {
  if (selectedBundle && !voyages.some((voyage) => voyage.fileName === selectedBundle.fileName)) {
    selectedBundle = null;
  }
  updateSelectedBundleActions();
  if (!voyages.length) {
    elements.voyageBundles.innerHTML = '<p class="empty">No voyage bundles yet.</p>';
    return;
  }
  elements.voyageBundles.innerHTML = voyages
    .map((voyage) => `
      <button class="bundle-row ${selectedBundle && selectedBundle.fileName === voyage.fileName ? "active" : ""}" type="button" data-bundle="${escapeHtml(voyage.fileName)}">
        <div class="bundle-details">
          <strong>${escapeHtml(voyage.fileName)}</strong>
          <span>${escapeHtml(formatTime(voyage.modifiedAt))} · ${escapeHtml(formatBytes(voyage.bytes))}</span>
          ${voyage.comment ? `<p class="bundle-comment"><span>Comment:</span> ${escapeHtml(voyage.comment)}</p>` : ""}
          ${voyage.recomputedReplay ? `<p class="bundle-comment"><span>Recomputed replay:</span> parent ${escapeHtml(voyage.recomputedReplay.parentVoyage || "unknown")}</p>` : ""}
        </div>
      </button>
    `)
    .join("");
  elements.voyageBundles.querySelectorAll("[data-bundle]").forEach((button) => {
    button.addEventListener("click", () => {
      const voyage = voyages.find((item) => item.fileName === button.dataset.bundle);
      selectedBundle = voyage || null;
      renderVoyageBundles(voyages);
    });
  });
}

function updateSelectedBundleActions() {
  const hasSelection = Boolean(selectedBundle);
  elements.deleteSelectedBundle.disabled = !hasSelection;
  elements.downloadSelectedBundle.classList.toggle("disabled", !hasSelection);
  elements.downloadSelectedBundle.setAttribute("aria-disabled", String(!hasSelection));
  if (hasSelection) {
    elements.selectedBundleInfo.textContent = selectedBundle.comment
      ? `${selectedBundle.fileName} · ${formatBytes(selectedBundle.bytes)} · Comment: ${selectedBundle.comment}`
      : `${selectedBundle.fileName} · ${formatBytes(selectedBundle.bytes)}`;
    elements.downloadSelectedBundle.href = selectedBundle.downloadUrl;
    elements.downloadSelectedBundle.download = selectedBundle.fileName;
  } else {
    elements.selectedBundleInfo.textContent = "Select a voyage bundle below.";
    elements.downloadSelectedBundle.href = "#";
    elements.downloadSelectedBundle.removeAttribute("download");
  }
}

async function deleteVoyage(fileName) {
  if (!window.confirm(`Delete voyage bundle ${fileName}? Make sure you have downloaded it first.`)) return;
  await command(`/voyages/${encodeURIComponent(fileName)}/delete`, {});
}

async function downloadSelectedVoyage(bundle) {
  if (!bundle || !bundle.downloadUrl) return;
  showDownloadPopup(bundle);
  elements.banner.classList.remove("error");
  elements.downloadSelectedBundle.classList.add("disabled");
  elements.downloadSelectedBundle.setAttribute("aria-disabled", "true");
  try {
    const response = await fetch(bundle.downloadUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = bundle.fileName || downloadFileName(response) || "ajrm-marine-voyage.zip";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 30000);
    elements.banner.textContent = `Download ready: ${link.download}`;
  } catch (error) {
    elements.banner.textContent = error.message || "Download failed";
    elements.banner.classList.add("error");
  } finally {
    hideDownloadPopup();
    updateSelectedBundleActions();
  }
}

function showDownloadPopup(bundle) {
  const name = bundle?.fileName || "the selected voyage";
  elements.banner.textContent =
    "Preparing download: collating logs and compressing the voyage bundle.";
  elements.downloadPopupMessage.textContent =
    `AJRM Marine Capture is collating logs and compressing ${name}. This may take some time.`;
  elements.downloadPopup.hidden = false;
}

function hideDownloadPopup() {
  elements.downloadPopup.hidden = true;
}

function downloadFileName(response) {
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return match ? match[1] : "";
}

function captureText(ajrmMarineLogger) {
  if (ajrmMarineLogger.recording) return `recording ${ajrmMarineLogger.recording.fileName || ""}`;
  if (ajrmMarineLogger.playback && ajrmMarineLogger.playback.active) return "playback active";
  return "idle";
}

function formatBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  if (number > 1024 * 1024 * 1024) return `${(number / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (number > 1024 * 1024) return `${(number / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(number / 1024)} KB`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
