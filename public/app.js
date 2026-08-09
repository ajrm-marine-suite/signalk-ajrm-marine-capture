/**
 * Browser entry point for AJRM Marine Voyages; binds operator controls and renders server state.
 */

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
  deleteSelectedBundle: document.getElementById("deleteSelectedBundle"),
  selectedBundleInfo: document.getElementById("selectedBundleInfo"),
  startButton: document.getElementById("startButton"),
  stopButton: document.getElementById("stopButton"),
  startReplayCaptureButton: document.getElementById("startReplayCaptureButton"),
  playAsRecordedButton: document.getElementById("playAsRecordedButton"),
  stopAsRecordedButton: document.getElementById("stopAsRecordedButton"),
  stopReplayCaptureButton: document.getElementById("stopReplayCaptureButton"),
  interruptReplayCaptureButton: document.getElementById("interruptReplayCaptureButton"),
  replayCaptureInfo: document.getElementById("replayCaptureInfo"),
  replayPlaybackState: document.getElementById("replayPlaybackState"),
  replayProgressValue: document.getElementById("replayProgressValue"),
  replayProgressBar: document.getElementById("replayProgressBar"),
  replaySegmentsValue: document.getElementById("replaySegmentsValue"),
  replayFinaliseValue: document.getElementById("replayFinaliseValue"),
  replayFinaliseProgressBar: document.getElementById("replayFinaliseProgressBar"),
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
    file: selectedBundle && selectedBundle.fileName,
    comment: elements.commentInput.value,
  }),
);
elements.playAsRecordedButton.addEventListener("click", () =>
  replayRecorderCommand("play", "/voyage/playback/start", {
    file: selectedBundle && selectedBundle.fileName,
  }),
);
elements.stopAsRecordedButton.addEventListener("click", () =>
  replayRecorderCommand("stop-playback", "/voyage/playback/stop", {}),
);
elements.stopReplayCaptureButton.addEventListener("click", () =>
  replayRecorderCommand("stop", "/voyage/replay/stop", {}),
);
elements.interruptReplayCaptureButton.addEventListener("click", () => {
  const parentVoyage = latestStatus?.currentVoyage?.recomputedReplay?.parentVoyage ||
    "the loaded parent voyage";
  if (!window.confirm(
    `Interrupt the recomputed replay of ${parentVoyage}? Partial output will be preserved in an incomplete, unverified ZIP.`,
  )) {
    return;
  }
  replayRecorderCommand("abort", "/voyage/replay/abort", {
    reason: "user interrupted recomputed replay",
  });
});
elements.saveCommentButton.addEventListener("click", () =>
  command("/voyage/comment", { comment: elements.commentInput.value }),
);
elements.deleteSelectedBundle.addEventListener("click", () => {
  if (selectedBundle) deleteVoyage(selectedBundle.fileName);
});
elements.downloadSelectedBundle.addEventListener("click", (event) => {
  if (elements.downloadSelectedBundle.classList.contains("disabled")) {
    event.preventDefault();
    return;
  }
  if (!selectedBundle?.downloadUrl) {
    event.preventDefault();
    return;
  }
  elements.banner.classList.remove("error");
  elements.banner.textContent =
    `Preparing ${selectedBundle.fileName}. The browser will stream the ZIP directly when it is ready.`;
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
  elements.modeValue.textContent = titleCase(status.captureMode || "voyage");
  elements.captureValue.textContent = status.currentVoyage?.recomputedReplay
    ? "recording recomputed output"
    : status.currentVoyage
      ? "recording canonical physical sensor input"
      : "idle";
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
  const playbackActive = status.playback?.active === true;
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
  const playback = status.playback || {};
  const currentVoyage = status.currentVoyage || null;
  const recomputedActive = Boolean(currentVoyage && currentVoyage.recomputedReplay);
  const standaloneActive = playback.mode === "recorded-output";
  const playbackActive = playback.active === true;
  const selectedReady =
    selectedBundle?.canonicalInput?.contract === status.canonicalInputContract;
  const selectedRecordedResult =
    selectedBundle?.recomputedOutput?.contract === status.recomputedOutputContract &&
    selectedBundle.recomputedOutput.complete === true;
  const replayFinished =
    playback.state === "complete" &&
    playback.complete === true &&
    playback.valid === true;
  const finalisationRunning = status.finalisation?.state === "running";
  const busy = pendingReplayAction === "start" ||
    pendingReplayAction === "stop" ||
    pendingReplayAction === "abort" ||
    pendingReplayAction === "play" ||
    pendingReplayAction === "stop-playback";
  elements.startReplayCaptureButton.disabled =
    busy || finalisationRunning || Boolean(currentVoyage) || playbackActive || !selectedReady;
  elements.playAsRecordedButton.disabled =
    busy || finalisationRunning || Boolean(currentVoyage) || playbackActive || !selectedRecordedResult;
  elements.stopAsRecordedButton.disabled =
    busy || !standaloneActive || !playbackActive;
  elements.stopReplayCaptureButton.disabled =
    busy || finalisationRunning || !recomputedActive || !replayFinished;
  elements.interruptReplayCaptureButton.disabled =
    busy || finalisationRunning || !recomputedActive;
  elements.startReplayCaptureButton.textContent =
    pendingReplayAction === "start" ? "Starting..." : "Start replay result";
  elements.playAsRecordedButton.textContent =
    pendingReplayAction === "play" ? "Starting playback..." : "Play as recorded";
  elements.stopAsRecordedButton.textContent =
    pendingReplayAction === "stop-playback" ? "Stopping..." : "Stop playback";
  elements.stopReplayCaptureButton.textContent =
    pendingReplayAction === "stop"
      ? finalisationRunning
        ? "Finalising..."
        : "Starting finalisation..."
      : "Finalise now";
  elements.interruptReplayCaptureButton.textContent =
    pendingReplayAction === "abort" ? "Interrupting..." : "Interrupt replay";
  renderReplayProgress(status, playback, recomputedActive, replayFinished);
  if (finalisationRunning) {
    elements.replayCaptureInfo.textContent =
      `Replay complete; finalising ${currentVoyage?.recomputedReplay?.parentVoyage || "the recomputed voyage"}.`;
  } else if (standaloneActive && playbackActive) {
    elements.replayCaptureInfo.textContent =
      `Playing the stored result from ${playback.fileName || "the selected voyage"} at fixed 1x. Capture is not recording.`;
  } else if (standaloneActive && playback.state === "complete") {
    elements.replayCaptureInfo.textContent =
      `Finished playing ${playback.fileName || "the recorded voyage result"}; no new voyage was created.`;
  } else if (recomputedActive) {
    elements.replayCaptureInfo.textContent =
      `Capture is replaying ${currentVoyage.recomputedReplay.parentVoyage || "the parent voyage"} at fixed 1x and recording recomputed output.`;
  } else if (selectedRecordedResult && selectedReady) {
    elements.replayCaptureInfo.textContent =
      `${selectedBundle.fileName} can be played as recorded or used as canonical input for a new replay result.`;
  } else if (selectedRecordedResult) {
    elements.replayCaptureInfo.textContent =
      `Ready to play the stored result from ${selectedBundle.fileName} without recording.`;
  } else if (selectedReady) {
    elements.replayCaptureInfo.textContent =
      `Ready to replay ${selectedBundle.fileName}.`;
  } else if (selectedBundle) {
    elements.replayCaptureInfo.textContent =
      `${selectedBundle.fileName} is not a current canonical voyage and cannot be replayed.`;
  } else {
    elements.replayCaptureInfo.textContent =
      "Select a canonical voyage bundle below, then start its fixed 1x replay.";
  }
}

function renderReplayProgress(status, playback, recomputedActive, replayFinished) {
  const finalisation = status.finalisation || null;
  const standalonePlayback = playback.mode === "recorded-output";
  if (finalisation?.state === "running") {
    const zip = finalisation.zip || null;
    if (replayFinished || finalisation.streamsClosed === true) {
      elements.replayPlaybackState.textContent = finalisation.streamsClosed === true
        ? "Complete · Capture streams closed"
        : "Complete · finalising recomputed result";
    }
    elements.replayFinaliseValue.textContent = zip
      ? `Building ZIP · ${Number(zip.percent || 0).toFixed(1)}% · ${zip.entriesProcessed || 0}/${zip.entriesTotal || 0} files · ${formatBytes(zip.outputBytes || 0)} written`
      : `${titleCase(finalisation.phase || "finalising")} · ${finalisation.message || "Preparing ZIP"}`;
    renderTaskProgress(elements.replayFinaliseProgressBar, {
      active: true,
      percent: zip && Number.isFinite(Number(zip.percent))
        ? Number(zip.percent)
        : null,
      state: "running",
    });
  } else if (finalisation?.state === "complete") {
    elements.replayFinaliseValue.textContent =
      `Complete${finalisation.bundle?.fileName ? ` · ${finalisation.bundle.fileName}` : ""}`;
    renderTaskProgress(elements.replayFinaliseProgressBar, {
      active: true,
      percent: 100,
      state: "complete",
    });
  } else if (finalisation?.state === "failed") {
    elements.replayFinaliseValue.textContent =
      `FAILED · ${finalisation.error || "Voyage ZIP finalisation failed"}`;
    renderTaskProgress(elements.replayFinaliseProgressBar, {
      active: true,
      percent: null,
      state: "failed",
    });
  } else {
    renderTaskProgress(elements.replayFinaliseProgressBar, {
      active: false,
      percent: 0,
      state: "idle",
    });
  }
  const replayedRecords = finiteNumber(playback.recordsReplayed, 0);
  const totalRecords = finiteNumber(playback.recordsTotal, 0);
  const percent = totalRecords > 0
    ? Math.min(100, Math.max(0, replayedRecords / totalRecords * 100))
    : null;

  if (!(finalisation?.state === "running" && (replayFinished || finalisation.streamsClosed === true))) {
    elements.replayPlaybackState.textContent =
      playback.state === "failed"
        ? `FAILED · ${playback.error || "timing failure"}`
        : playback.state === "aborted"
          ? "Interrupted"
          : playback.active
            ? `Playing at fixed 1x · effective ${Number(playback.effectiveRatio || 0).toFixed(3)}x`
            : replayFinished
              ? standalonePlayback
                ? "Complete · recorded result EOF"
                : "Complete · canonical input EOF"
              : titleCase(playback.state || "idle");
  }
  elements.replayProgressValue.textContent = totalRecords > 0
    ? `${replayedRecords} of ${totalRecords} ${standalonePlayback ? "recorded result" : "input"} records · ${percent.toFixed(1)}%`
    : "-";
  renderTaskProgress(elements.replayProgressBar, {
    active: playback.state !== "idle" || replayedRecords > 0,
    percent,
    state: playback.state === "failed"
      ? "failed"
      : replayFinished
        ? "complete"
        : playback.active
          ? "running"
          : "idle",
  });
  elements.replaySegmentsValue.textContent = playback.sourceDurationMs > 0
    ? `Single monotonic ${standalonePlayback ? "recorded-result" : "input"} stream · ${formatDuration(playback.sourceDurationMs)} source · maximum lag ${Math.round(playback.maximumObservedLagMs || 0)} ms`
    : "Single monotonic stream";
  if (!finalisation || !["running", "complete", "failed"].includes(finalisation.state)) {
    elements.replayFinaliseValue.textContent =
      standalonePlayback
        ? "Not applicable · playback is not being recorded."
        : !recomputedActive
          ? "Start a canonical voyage replay first."
          : playback.state === "failed"
            ? `FAILED: ${playback.error || "Replay timing invalid"}. Interrupt to preserve partial evidence.`
            : playback.active
              ? "Available after canonical input EOF."
              : replayFinished
                ? "Ready: EOF and valid effective timing confirmed."
                : "Waiting for replay.";
  }
}

function renderTaskProgress(element, { active, percent, state }) {
  element.hidden = !active;
  element.dataset.state = state || "idle";
  if (!active) {
    element.value = 0;
    return;
  }
  if (Number.isFinite(percent)) {
    element.value = Math.min(100, Math.max(0, percent));
  } else {
    element.removeAttribute("value");
  }
}

function finiteNumber(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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
          ${voyage.recomputedReplay ? `<p class="bundle-comment"><span>Recomputed replay:</span> parent ${escapeHtml(voyage.recomputedReplay.parentVoyage || "unknown")}${voyage.recomputedReplay.incomplete === true ? " · INCOMPLETE / UNVERIFIED" : ""}</p>` : ""}
        </div>
      </button>
    `)
    .join("");
  elements.voyageBundles.querySelectorAll("[data-bundle]").forEach((button) => {
    button.addEventListener("click", () => {
      const voyage = voyages.find((item) => item.fileName === button.dataset.bundle);
      selectedBundle = voyage || null;
      renderVoyageBundles(voyages);
      if (latestStatus) renderReplayRecorder(latestStatus);
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

function formatBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  if (number > 1024 * 1024 * 1024) return `${(number / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (number > 1024 * 1024) return `${(number / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(number / 1024)} KB`;
}

function formatDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "-";
  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
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
