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
    comment: elements.commentInput.value,
  }),
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
  const coverage = playback.coverage || {};
  const currentVoyage = status.currentVoyage || null;
  const recomputedActive = Boolean(currentVoyage && currentVoyage.recomputedReplay);
  const playbackError =
    playback.lastError && typeof playback.lastError === "object"
      ? playback.lastError
      : null;
  const resultCaptureActive = Boolean(
    playback.resultCapture && playback.resultCapture.active === true,
  );
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
    !playbackError &&
    !playback.active &&
    !playback.paused &&
    Number(playback.cursor || 0) === Number(playback.startCursor || 0);
  const replayFinished =
    coverage.complete === true &&
    coverage.preparedComplete === true &&
    (playback.lastReason || coverage.lastReason) === "end of capture" &&
    !playback.active &&
    !playback.paused &&
    !playbackError;
  const playbackComplete = replayFinished && resultCaptureActive;
  const finalisationRunning = status.finalisation?.state === "running";
  const busy = pendingReplayAction === "start" ||
    pendingReplayAction === "stop" ||
    pendingReplayAction === "abort";
  elements.startReplayCaptureButton.disabled =
    busy || finalisationRunning || Boolean(currentVoyage) || !ready;
  elements.stopReplayCaptureButton.disabled =
    busy || finalisationRunning || !recomputedActive || !playbackComplete;
  elements.interruptReplayCaptureButton.disabled =
    busy || finalisationRunning || !recomputedActive;
  elements.startReplayCaptureButton.textContent =
    pendingReplayAction === "start" ? "Starting..." : "Start replay result";
  elements.stopReplayCaptureButton.textContent =
    pendingReplayAction === "stop"
      ? finalisationRunning
        ? "Finalising..."
        : "Starting finalisation..."
      : "Stop and build ZIP";
  elements.interruptReplayCaptureButton.textContent =
    pendingReplayAction === "abort" ? "Interrupting..." : "Interrupt replay";
  renderReplayProgress(
    status,
    playback,
    recomputedActive,
    resultCaptureActive,
    playbackComplete,
    replayFinished,
    playbackError,
  );
  if (finalisationRunning) {
    elements.replayCaptureInfo.textContent =
      `Replay complete; finalising ${currentVoyage?.recomputedReplay?.parentVoyage || "the recomputed voyage"}.`;
  } else if (recomputedActive) {
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

function renderReplayProgress(
  status,
  playback,
  recomputedActive,
  resultCaptureActive,
  playbackComplete,
  replayFinished,
  playbackError,
) {
  const finalisation = status.finalisation || null;
  if (finalisation?.state === "running") {
    const zip = finalisation.zip || null;
    if (replayFinished || finalisation.loggerClosed === true) {
      elements.replayPlaybackState.textContent = finalisation.loggerClosed === true
        ? "Complete · Logger recorder closed"
        : "Complete · finalising Logger result";
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
  const coverage = playback.coverage || {};
  const lastReason = playback.lastReason || coverage.lastReason || null;
  const replayedLines = finiteNumber(
    coverage.replayedLines,
    Math.max(0, Number(coverage.cursor ?? playback.cursor ?? 0) -
      Number(coverage.startCursor ?? playback.startCursor ?? 0)),
  );
  const replayableLines = finiteNumber(
    coverage.replayableLines,
    Math.max(0, Number(coverage.totalLines ?? playback.totalLines ?? 0) -
      Number(coverage.startCursor ?? playback.startCursor ?? 0)),
  );
  const percent = replayableLines > 0
    ? Math.min(100, Math.max(0, replayedLines / replayableLines * 100))
    : null;
  const segmentsCompleted = finiteNumber(coverage.segmentsCompleted, null);
  const segmentsTotal = finiteNumber(coverage.segmentsTotal, null);
  const cursor = finiteNumber(coverage.cursor ?? playback.cursor, null);
  const totalLines = finiteNumber(
    coverage.totalLines ?? playback.totalLines,
    null,
  );

  if (!(finalisation?.state === "running" && (replayFinished || finalisation.loggerClosed === true))) {
    elements.replayPlaybackState.textContent = !playback.loaded
    ? "Not loaded"
    : playbackError
      ? `FAILED${lastReason ? ` · ${lastReason}` : ""}`
      : playback.active
      ? `Playing at ${playback.rate || 1}x${lastReason ? ` · ${lastReason}` : ""}`
      : playback.paused
        ? `Paused${lastReason ? ` · ${lastReason}` : ""}`
        : playbackComplete
          ? "Complete · end of capture"
          : resultCaptureActive && lastReason === "loaded"
            ? "Armed · playback has not started"
            : `Stalled / incomplete${lastReason ? ` · ${lastReason}` : ""}`;
  }
  elements.replayProgressValue.textContent = replayableLines > 0
    ? `${replayedLines} of ${replayableLines} replay deltas${percent === null ? "" : ` · ${percent.toFixed(1)}%`}${cursor !== null && totalLines !== null ? ` · cursor ${cursor}/${totalLines}` : ""}`
    : playback.loaded
      ? cursor !== null && totalLines !== null
        ? `No replayable deltas reported · cursor ${cursor}/${totalLines}`
        : "No replayable deltas reported"
      : "-";
  renderTaskProgress(elements.replayProgressBar, {
    active: playback.loaded || replayedLines > 0,
    percent,
    state: playbackError
      ? "failed"
      : replayFinished
        ? "complete"
        : playback.active
          ? "running"
          : "idle",
  });
  elements.replaySegmentsValue.textContent =
    segmentsCompleted !== null && segmentsTotal !== null
      ? `${segmentsCompleted} of ${segmentsTotal} complete`
      : playback.loaded
        ? "Not reported"
        : "-";
  if (!finalisation || !["running", "complete", "failed"].includes(finalisation.state)) {
    elements.replayFinaliseValue.textContent = replayFinaliseReason({
      loggerStatus: status.ajrmMarineLogger || {},
      playback,
      coverage,
      recomputedActive,
      resultCaptureActive,
      playbackComplete,
      lastReason,
      playbackError,
    });
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

function replayFinaliseReason({
  loggerStatus,
  playback,
  coverage,
  recomputedActive,
  resultCaptureActive,
  playbackComplete,
  lastReason,
  playbackError,
}) {
  if (!recomputedActive) {
    return "Start a replay result capture before playing the parent voyage.";
  }
  if (loggerStatus.ok === false) {
    return `Disabled: Logger status is unavailable${loggerStatus.error ? ` — ${loggerStatus.error}` : ""}. Interrupt the replay to preserve partial evidence.`;
  }
  if (playbackError) {
    const location = Number.isFinite(Number(playbackError.cursor))
      ? ` at cursor ${Number(playbackError.cursor)}`
      : "";
    return `FAILED${location}: ${playbackError.message || "Logger reported a playback error"}. Interrupt now to preserve the incomplete evidence ZIP.`;
  }
  if (!resultCaptureActive) {
    return "Disabled: Logger's replay-result recorder is no longer active. Interrupt the replay to preserve partial evidence.";
  }
  if (playback.active) {
    return "Disabled while Logger is playing. It will enable after every prepared segment reaches the end.";
  }
  if (playback.paused) {
    return "Disabled while Logger reports playback paused. Interrupt this incomplete run and retry.";
  }
  if (coverage.preparedComplete !== true) {
    return "Disabled: Logger has not confirmed that every source segment was prepared.";
  }
  if (coverage.complete !== true) {
    if (lastReason === "loaded") {
      return "Disabled: press Play in Logger to begin the 1x sensor replay.";
    }
    return `Disabled: Logger has not completed replay coverage${lastReason ? ` (last reason: ${lastReason})` : ""}. Interrupt this incomplete run if it cannot continue.`;
  }
  if (lastReason !== "end of capture") {
    return `Disabled: full coverage is reported, but Logger's last reason is ${lastReason || "not available"}, not end of capture.`;
  }
  if (!playbackComplete) {
    return "Disabled until Logger confirms the result recorder and final replay state.";
  }
  return "Ready: complete prepared coverage and end of capture confirmed.";
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
