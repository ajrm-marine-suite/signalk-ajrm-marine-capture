/**
 * Shared map-shell module used by AJRM Marine map applications. It provides
 * common chart selection, chart cycling, coordinate formatting, toolbar icons,
 * floating-panel sizing, folder toggles, and map-control accessibility helpers.
 */

export const MAP_CORE_CONTRACT = "ajrm-marine-map-shell-v1";
export const MAP_CORE_VERSION = "0.7.9";
export const AUTO_CHARTS_NAME = "Auto Charts";
export const OPEN_SEA_MAP_NAME = "OpenSeaMap";
export const CHART_FOLDER_API_BASE = "/plugins/signalk-charts-provider-simple";
export const CHART_CYCLE_SHORTCUT_STORAGE_KEY = "chartCycleShortcut";
export const DEFAULT_CHART_CYCLE_SHORTCUT = "C";
export const MAP_FOLLOW_LOOK_AHEAD_STORAGE_KEY =
	"ajrmMarineMapFollowLookAheadPercent";
export const MAP_FOLLOW_LOOK_AHEAD_DEFAULT_PERCENT = 66;
export const MAP_FOLLOW_LOOK_AHEAD_MIN_PERCENT = 50;
export const MAP_FOLLOW_LOOK_AHEAD_MAX_PERCENT = 80;

export function normalizeMapFollowLookAheadPercent(value) {
	if (value == null || value === "") {
		return MAP_FOLLOW_LOOK_AHEAD_DEFAULT_PERCENT;
	}
	const number = Number(value);
	if (!Number.isFinite(number)) return MAP_FOLLOW_LOOK_AHEAD_DEFAULT_PERCENT;
	return Math.min(
		MAP_FOLLOW_LOOK_AHEAD_MAX_PERCENT,
		Math.max(MAP_FOLLOW_LOOK_AHEAD_MIN_PERCENT, Math.round(number)),
	);
}

export function loadMapFollowLookAheadPercent(
	storage = globalThis.localStorage,
) {
	return normalizeMapFollowLookAheadPercent(
		storage?.getItem?.(MAP_FOLLOW_LOOK_AHEAD_STORAGE_KEY),
	);
}

export function saveMapFollowLookAheadPercent(
	value,
	storage = globalThis.localStorage,
) {
	const normalized = normalizeMapFollowLookAheadPercent(value);
	storage?.setItem?.(
		MAP_FOLLOW_LOOK_AHEAD_STORAGE_KEY,
		String(normalized),
	);
	return normalized;
}

/**
 * Return a north-up Leaflet map centre that leaves the requested share of the
 * visible chart ahead of a position along COG. `cogRadians` follows Signal K's
 * standard courseOverGroundTrue unit: radians clockwise from true north.
 */
export function mapFollowLookAheadCenter({
	map,
	position,
	cogRadians,
	lookAheadPercent = loadMapFollowLookAheadPercent(),
}) {
	const vesselPosition = [position?.latitude, position?.longitude];
	const course = Number(cogRadians);
	const normalizedPercent = normalizeMapFollowLookAheadPercent(lookAheadPercent);
	if (
		!Number.isFinite(course) ||
		normalizedPercent <= 50 ||
		typeof map?.project !== "function" ||
		typeof map?.unproject !== "function" ||
		typeof map?.getSize !== "function"
	) {
		return vesselPosition;
	}

	const size = map.getSize();
	const width = Number(size?.x);
	const height = Number(size?.y);
	if (!(width > 0) || !(height > 0)) return vesselPosition;

	const forwardX = Math.sin(course);
	const forwardY = -Math.cos(course);
	const distanceToHorizontalEdge =
		Math.abs(forwardX) > Number.EPSILON
			? width / 2 / Math.abs(forwardX)
			: Number.POSITIVE_INFINITY;
	const distanceToVerticalEdge =
		Math.abs(forwardY) > Number.EPSILON
			? height / 2 / Math.abs(forwardY)
			: Number.POSITIVE_INFINITY;
	const distanceToForwardEdge = Math.min(
		distanceToHorizontalEdge,
		distanceToVerticalEdge,
	);
	if (!Number.isFinite(distanceToForwardEdge)) return vesselPosition;

	const centreShift =
		((normalizedPercent - 50) / 50) * distanceToForwardEdge;
	const zoom = map.getZoom?.();
	const vesselPoint = map.project(vesselPosition, zoom);
	if (!Number.isFinite(vesselPoint?.x) || !Number.isFinite(vesselPoint?.y)) {
		return vesselPosition;
	}

	return map.unproject(
		{
			x: vesselPoint.x + forwardX * centreShift,
			y: vesselPoint.y + forwardY * centreShift,
		},
		zoom,
	);
}

export function setMapControlHoverHelp(element, label) {
	if (!element) return element;
	const help = String(label || "").trim();
	if (!help) {
		element.removeAttribute?.("data-ajrm-map-help");
		return element;
	}
	element.title = help;
	element.setAttribute?.("title", help);
	element.setAttribute?.("data-ajrm-map-help", help);
	if (!element.getAttribute?.("aria-label")) {
		element.setAttribute?.("aria-label", help);
	}
	return element;
}

export function labelLeafletZoomControls(map) {
	const container = map?.getContainer?.();
	const zoomIn = container?.querySelector?.(".leaflet-control-zoom-in") || null;
	const zoomOut = container?.querySelector?.(".leaflet-control-zoom-out") || null;
	setMapControlHoverHelp(zoomIn, "Zoom in");
	setMapControlHoverHelp(zoomOut, "Zoom out");
	return { zoomIn, zoomOut };
}

function controlIcon(paths, label) {
	return `<svg class="ajrm-marine-control-icon" viewBox="0 0 16 16" width="1em" height="1em" aria-label="${label}" role="img" fill="currentColor" focusable="false">${paths}</svg>`;
}

export const MAP_CONTROL_ICONS = Object.freeze({
	targets: controlIcon(
		'<path fill-rule="evenodd" d="M2.5 12a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5m0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5m0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5"/><path d="M1 4a.75.75 0 1 0 0-1.5A.75.75 0 0 0 1 4m0 4a.75.75 0 1 0 0-1.5A.75.75 0 0 0 1 8m0 4a.75.75 0 1 0 0-1.5A.75.75 0 0 0 1 12"/>',
		"List",
	),
	settings: controlIcon(
		'<path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.46 1.46 0 0 1-2.105.872l-.31-.18c-1.266-.73-2.668.672-1.937 1.937l.178.31c.446.775.072 1.767-.871 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.46 1.46 0 0 1 .872 2.105l-.18.31c-.73 1.266.672 2.668 1.937 1.937l.31-.178a1.46 1.46 0 0 1 2.105.871l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.46 1.46 0 0 1 2.105-.872l.31.18c1.266.73 2.668-.672 1.937-1.937l-.178-.31a1.46 1.46 0 0 1 .871-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.46 1.46 0 0 1-.872-2.105l.18-.31c.73-1.266-.672-2.668-1.937-1.937l-.31.178a1.46 1.46 0 0 1-2.105-.871zM8 10.93a2.93 2.93 0 1 1 0-5.86 2.93 2.93 0 0 1 0 5.86"/>',
		"Settings",
	),
	follow: controlIcon(
		'<path d="M14.082 2.182a.5.5 0 0 1 .103.557l-5.5 12a.5.5 0 0 1-.95-.084L6.57 9.43 1.345 8.265a.5.5 0 0 1-.084-.95l12-5.5a.5.5 0 0 1 .821.367"/>',
		"Follow own vessel",
	),
	layers: controlIcon(
		'<path d="M8.235 1.559a.5.5 0 0 0-.47 0l-7.5 4a.5.5 0 0 0 0 .882l7.5 4a.5.5 0 0 0 .47 0l7.5-4a.5.5 0 0 0 0-.882z"/><path d="m2.125 8.567-1.86.992a.5.5 0 0 0 0 .882l7.5 4a.5.5 0 0 0 .47 0l7.5-4a.5.5 0 0 0 0-.882l-1.86-.992-5.17 2.756a1.5 1.5 0 0 1-1.41 0z"/>',
		"Charts",
	),
	cycleCharts: controlIcon(
		'<path d="M8 3a5 5 0 0 0-4.546 2.914.5.5 0 0 1-.908-.418A6 6 0 0 1 13.47 4H15.5a.5.5 0 0 1 0 1H12a.5.5 0 0 1-.5-.5V1a.5.5 0 0 1 1 0v2.19A5.97 5.97 0 0 1 8 3m4.546 7.086a.5.5 0 0 1 .908.418A6 6 0 0 1 2.53 12H.5a.5.5 0 0 1 0-1H4a.5.5 0 0 1 .5.5V15a.5.5 0 0 1-1 0v-2.19A5.97 5.97 0 0 1 8 13a5 5 0 0 0 4.546-2.914"/><path d="M4.5 7.25 8 5.5l3.5 1.75L8 9zM4.5 9 8 10.75 11.5 9v1L8 11.75 4.5 10z"/>',
		"Cycle chart",
	),
});

export const MAP_ACTION_ICONS = Object.freeze({
	status: MAP_CONTROL_ICONS.targets,
	follow: MAP_CONTROL_ICONS.follow,
	plot: controlIcon('<path d="M8 0a5.53 5.53 0 0 0-5.5 5.5c0 3.8 5.5 10.5 5.5 10.5s5.5-6.7 5.5-10.5A5.53 5.53 0 0 0 8 0m0 8a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5"/>', "Plot position"),
	list: MAP_CONTROL_ICONS.targets,
	refresh: controlIcon('<path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 11.47 4H9.5a.5.5 0 0 1 0-1H13a.5.5 0 0 1 .5.5V7a.5.5 0 0 1-1 0V4.81A5.97 5.97 0 0 0 8 3"/>', "Refresh"),
	summary: controlIcon('<path d="M4 0h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2m1 4.5a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1zm0 3a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1zm0 3a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1z"/>', "Summary"),
	edit: controlIcon('<path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207zM12.793 5.5 10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293z"/>', "Edit"),
	settings: MAP_CONTROL_ICONS.settings,
});

const ZOOM_TOLERANCE = 0.1;

function finiteNumber(value, fallback) {
	const number = Number(value ?? fallback);
	return Number.isFinite(number) ? number : fallback;
}

function boundsSource(chart) {
	return chart?.bounds ?? chart?.boundingBox ?? chart?.extent ?? chart?.bbox ?? null;
}

function rawBounds(source) {
	if (Array.isArray(source)) return source.flat(2).slice(0, 4).map(Number);
	if (typeof source === "string") return source.split(/[\s,]+/).slice(0, 4).map(Number);
	if (source && typeof source === "object") {
		return [
			source.west ?? source.minLon ?? source.minLongitude,
			source.south ?? source.minLat ?? source.minLatitude,
			source.east ?? source.maxLon ?? source.maxLongitude,
			source.north ?? source.maxLat ?? source.maxLatitude,
		].map(Number);
	}
	return [];
}

function validBounds(bounds) {
	return bounds.length === 4 && bounds.every(Number.isFinite) &&
		bounds[0] >= -180 && bounds[2] <= 180 && bounds[1] >= -90 && bounds[3] <= 90 &&
		bounds[0] < bounds[2] && bounds[1] < bounds[3];
}

export function chartBoundsCandidates(chart) {
	const [a, b, c, d] = rawBounds(boundsSource(chart));
	const candidates = [
		[Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)],
		[Math.min(b, d), Math.min(a, c), Math.max(b, d), Math.max(a, c)],
	].filter(validBounds);
	return candidates.filter((candidate, index) =>
		candidates.findIndex((other) => other.join(",") === candidate.join(",")) === index);
}

export function chartZoom(chart) {
	return chart?.__ajrmMapZoom ?? chart?.__autoChartZoom ?? {
		min: finiteNumber(chart?.minzoom ?? chart?.minZoom, 0),
		max: finiteNumber(chart?.maxzoom ?? chart?.maxZoom, 24),
	};
}

export function normalizeChartResources(resources) {
	return Object.entries(resources || {}).map(([id, chart]) => {
		const normalized = { ...chart, __ajrmMapChartId: id, __autoChartId: id };
		Object.defineProperties(normalized, {
			__ajrmMapBounds: { value: chartBoundsCandidates(chart) },
			__ajrmMapZoom: { value: chartZoom(chart) },
		});
		return normalized;
	});
}

export function chartBounds(chart, lat, lon) {
	const candidates = chart?.__ajrmMapBounds ?? chart?.__autoChartBoundsCandidates ??
		chartBoundsCandidates(chart);
	return candidates.find((bounds) =>
		lon >= bounds[0] && lon <= bounds[2] && lat >= bounds[1] && lat <= bounds[3]) ??
		candidates[0] ?? null;
}

export function chartContains(chart, lat, lon) {
	const bounds = chartBounds(chart, lat, lon);
	return !!bounds && lon >= bounds[0] && lon <= bounds[2] &&
		lat >= bounds[1] && lat <= bounds[3];
}

function chartArea(chart, lat, lon) {
	const bounds = chartBounds(chart, lat, lon);
	return bounds ? Math.abs((bounds[2] - bounds[0]) * (bounds[3] - bounds[1])) : Infinity;
}

export function chartCandidates(charts, { lat, lng, zoom, maxZoom = 22 }) {
	return charts
		.filter((chart) => chartContains(chart, lat, lng))
		.filter((chart) => {
			const range = chartZoom(chart);
			return zoom >= range.min - ZOOM_TOLERANCE && zoom <= maxZoom + ZOOM_TOLERANCE;
		})
		.sort((left, right) => {
			const leftZoom = chartZoom(left);
			const rightZoom = chartZoom(right);
			const leftNative = leftZoom.max >= zoom;
			const rightNative = rightZoom.max >= zoom;
			if (leftNative !== rightNative) return leftNative ? -1 : 1;
			const zoomOrder = leftNative
				? leftZoom.max - rightZoom.max
				: rightZoom.max - leftZoom.max;
			return zoomOrder || chartArea(left, lat, lng) - chartArea(right, lat, lng) ||
				rightZoom.min - leftZoom.min;
		});
}

export function chooseChart(charts, map, position = map.getCenter()) {
	return chartCandidates(charts, {
		lat: position.lat,
		lng: position.lng,
		zoom: map.getZoom(),
		maxZoom: map.getMaxZoom(),
	})[0] ?? null;
}

export function chartId(chart) {
	return chart?.__ajrmMapChartId ?? chart?.__autoChartId ?? chart?.identifier ?? chart?.id ?? null;
}

export function chartDisplayName(chart) {
	return chart?.name || chart?.title || chart?.description || chartId(chart) || "Unnamed chart";
}

export function chartCycleResultMessage(result) {
	if (result?.mode === "disabled") return "Auto Charts is switched off";
	if (result?.mode === "empty") return "No enabled chart covers the map centre";
	if (result?.mode === "none") return "No Auto chart — basemap shown";
	if (result?.mode === "auto") return `Automatic chart: ${chartDisplayName(result.chart)}`;
	if (result?.mode === "manual") {
		return `Chart ${result.index} of ${result.total}: ${chartDisplayName(result.chart)}`;
	}
	return "Chart selection unavailable";
}

export function chartCycleStatusMessage({ selected, candidates = [], manualChartId = null, basemapOnly = false }) {
	if (basemapOnly) return chartCycleResultMessage({ mode: "none" });
	if (!selected) return chartCycleResultMessage({ mode: "empty" });
	if (!manualChartId) return chartCycleResultMessage({ mode: "auto", chart: selected });
	const index = candidates.findIndex((chart) => chartId(chart) === manualChartId);
	return chartCycleResultMessage({
		mode: "manual",
		chart: selected,
		index: Math.max(0, index) + 1,
		total: candidates.length,
	});
}

export function createChartCycleState() {
	let manualChartId = null;

	const candidatesFor = (charts, map, position = map.getCenter()) => chartCandidates(charts, {
		lat: position.lat,
		lng: position.lng,
		zoom: map.getZoom(),
		maxZoom: map.getMaxZoom(),
	});

	return {
		choose(charts, map, position) {
			const candidates = candidatesFor(charts, map, position);
			if (manualChartId) {
				const manual = candidates.find((chart) => chartId(chart) === manualChartId);
				if (manual) return manual;
				manualChartId = null;
			}
			return candidates[0] ?? null;
		},
		cycle(charts, map, position) {
			const candidates = candidatesFor(charts, map, position);
			if (candidates.length < 2) {
				manualChartId = null;
				return candidates[0] ?? null;
			}
			if (!manualChartId) {
				manualChartId = chartId(candidates[1]);
				return candidates[1];
			}
			const currentIndex = candidates.findIndex((chart) => chartId(chart) === manualChartId);
			if (currentIndex < 0 || currentIndex === candidates.length - 1) {
				manualChartId = null;
				return candidates[0];
			}
			manualChartId = chartId(candidates[currentIndex + 1]);
			return candidates[currentIndex + 1];
		},
		reset() {
			manualChartId = null;
		},
		get manualChartId() {
			return manualChartId;
		},
		getCandidates: candidatesFor,
	};
}

export function normalizeChartCycleShortcut(value) {
	const shortcut = String(value ?? "").trim().slice(0, 1).toUpperCase();
	return shortcut || DEFAULT_CHART_CYCLE_SHORTCUT;
}

export function isEditableShortcutTarget(target) {
	const tagName = String(target?.tagName || "").toLowerCase();
	return target?.isContentEditable === true || ["input", "textarea", "select"].includes(tagName);
}

export function chartCycleShortcut(storage = globalThis.localStorage) {
	try {
		return normalizeChartCycleShortcut(storage?.getItem?.(CHART_CYCLE_SHORTCUT_STORAGE_KEY));
	} catch {
		return DEFAULT_CHART_CYCLE_SHORTCUT;
	}
}

export function isChartCycleShortcutEvent(event, storage = globalThis.localStorage) {
	return !event?.defaultPrevented &&
		!event?.repeat &&
		!event?.altKey &&
		!event?.ctrlKey &&
		!event?.metaKey &&
		!isEditableShortcutTarget(event?.target) &&
		String(event?.key || "").length === 1 &&
		normalizeChartCycleShortcut(event.key) === chartCycleShortcut(storage);
}

export function createChartCycleControl({
	L,
	map,
	getCharts,
	isEnabled = () => true,
	onChange = () => {},
	position = "topleft",
	document = globalThis.document,
	storage = globalThis.localStorage,
	statusElement = null,
	schedule = globalThis.setTimeout,
	cancelSchedule = globalThis.clearTimeout,
	statusDurationMs = 3500,
}) {
	const state = createChartCycleState();
	let basemapOnly = false;
	let previouslyEnabled = isEnabled() !== false;
	let button;
	let statusTimer = null;
	const showStatus = (selected, candidates) => {
		if (!statusElement) return;
		statusElement.textContent = chartCycleStatusMessage({
			selected,
			candidates,
			manualChartId: state.manualChartId,
			basemapOnly,
		});
		statusElement.hidden = false;
		if (statusTimer != null) cancelSchedule?.(statusTimer);
		statusTimer = schedule?.(() => {
			statusElement.hidden = true;
		}, statusDurationMs);
	};
	const syncButton = () => {
		if (!button) return;
		const enabled = isEnabled() !== false;
		if (enabled && !previouslyEnabled) {
			state.reset();
			basemapOnly = false;
		}
		previouslyEnabled = enabled;
		const candidates = state.getCandidates(getCharts(), map);
		button.disabled = !enabled || candidates.length < 1;
		const shortcut = chartCycleShortcut(storage);
		const help = !enabled
			? "Turn on Auto Charts to cycle charts"
			: candidates.length < 1
			? "No chart covers the map centre"
			: basemapOnly
				? `Cycle charts [${shortcut}] (Basemap only)`
			: state.manualChartId
				? `Cycle charts [${shortcut}] (${candidates.findIndex((chart) => chartId(chart) === state.manualChartId) + 1} of ${candidates.length}, plus basemap)`
				: `Cycle charts [${shortcut}] (Auto, ${candidates.length} available, plus basemap)`;
		setMapControlHoverHelp(button, help);
		button.setAttribute("aria-label", help);
	};
	const cycleSelection = (charts, targetMap, positionValue) => {
		if (isEnabled() === false) return null;
		const candidates = state.getCandidates(charts, targetMap, positionValue);
		if (candidates.length < 1) return null;
		let selected;
		if (basemapOnly) {
			basemapOnly = false;
			state.reset();
			selected = state.choose(charts, targetMap, positionValue);
		} else {
			const currentManualIndex = state.manualChartId
				? candidates.findIndex((chart) => chartId(chart) === state.manualChartId)
				: -1;
			if (candidates.length === 1 || currentManualIndex === candidates.length - 1) {
				state.reset();
				basemapOnly = true;
				selected = null;
			} else {
				selected = state.cycle(charts, targetMap, positionValue);
			}
		}
		syncButton();
		onChange();
		showStatus(selected, candidates);
		return { selected, basemapOnly };
	};
	const cycle = () => {
		return cycleSelection(getCharts(), map);
	};
	const keydownHandler = (event) => {
		if (!isChartCycleShortcutEvent(event, storage)) return;
		if (!cycle()) return;
		event.preventDefault?.();
	};
	const definition = L.Control.extend({
		options: { position },
		onAdd() {
			const container = L.DomUtil.create("div", "leaflet-bar ajrm-map-cycle");
			button = L.DomUtil.create("button", "ajrm-map-button", container);
			button.type = "button";
			button.innerHTML = MAP_CONTROL_ICONS.cycleCharts;
			L.DomEvent.disableClickPropagation(container);
			L.DomEvent.on(button, "click", (event) => {
				L.DomEvent.stop(event);
				if (button.disabled) return;
				cycle();
			});
			map.on("moveend zoomend", syncButton);
			document?.addEventListener?.("keydown", keydownHandler);
			syncButton();
			return container;
		},
		onRemove() {
			map.off?.("moveend zoomend", syncButton);
			document?.removeEventListener?.("keydown", keydownHandler);
			if (statusTimer != null) cancelSchedule?.(statusTimer);
		},
	});
	const control = new definition();
	return {
		control,
		addTo(target = map) {
			control.addTo(target);
			return this;
		},
		choose(charts = getCharts(), targetMap = map, positionValue) {
			const selected = basemapOnly ? null : state.choose(charts, targetMap, positionValue);
			syncButton();
			return selected;
		},
		cycle(charts = getCharts(), targetMap = map, positionValue) {
			return cycleSelection(charts, targetMap, positionValue)?.selected ?? null;
		},
		reset() {
			state.reset();
			basemapOnly = false;
			syncButton();
		},
		update: syncButton,
		get manualChartId() {
			return state.manualChartId;
		},
		get isBasemapOnly() {
			return basemapOnly;
		},
	};
}

export function mapActionState(action) {
	return {
		visible: action.isVisible?.() !== false,
		disabled: action.isDisabled?.() === true,
		pressed: action.isPressed?.() === true,
	};
}

export function createActionToolbarControl({
	L,
	map,
	actions,
	position = "topleft",
}) {
	const buttons = [];
	const update = () => {
		actions.forEach((action, index) => {
			const button = buttons[index];
			if (!button) return;
			const state = mapActionState(action);
			button.hidden = !state.visible;
			button.disabled = state.disabled;
			button.setAttribute("aria-pressed", String(state.pressed));
		});
	};
	const definition = L.Control.extend({
		options: { position },
		onAdd() {
			const container = L.DomUtil.create("div", "leaflet-bar ajrm-map-actions");
			actions.forEach((action) => {
				const button = L.DomUtil.create("button", "ajrm-map-button", container);
				button.type = "button";
				setMapControlHoverHelp(button, action.title);
				button.setAttribute("aria-label", action.title);
				button.innerHTML = action.icon;
				buttons.push(button);
				L.DomEvent.on(button, "click", (event) => {
					L.DomEvent.stop(event);
					if (button.disabled) return;
					action.activate();
					queueMicrotask(update);
				});
			});
			L.DomEvent.disableClickPropagation(container);
			update();
			return container;
		},
	});
	const control = new definition();
	return {
		control,
		addTo(target = map) {
			control.addTo(target);
			return this;
		},
		update,
	};
}

export function chartUrl(chart) {
	return chart?.tilemapUrl || chart?.url || chart?.tileUrl || chart?.href || "";
}

export function makeRasterChartLayer({ L, chart, maxZoom = 22, pane = "tilePane" }) {
	const url = chartUrl(chart);
	if (!url) return null;
	const range = chartZoom(chart);
	return L.tileLayer(url, {
		minZoom: range.min,
		maxNativeZoom: range.max,
		maxZoom,
		pane,
		attribution: chart.attribution || chart.description || chart.name || "",
	});
}

export function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function normalizeFolderResponse(payload) {
	const states = payload?.folderStates ?? {};
	return (Array.isArray(payload?.folders) ? payload.folders : [])
		.filter((path) => path && path !== "/")
		.map((path) => ({
			path,
			name: path.split("/").filter(Boolean).at(-1) || path,
			depth: Math.max(0, path.split("/").filter(Boolean).length - 1),
			enabled: states[path]?.enabled !== false,
			effectiveEnabled: states[path]?.effectiveEnabled !== false,
		}))
		.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

export function createFolderClient(fetchFn = (...args) => globalThis.fetch(...args)) {
	return {
		async list() {
			const response = await fetchFn(`${CHART_FOLDER_API_BASE}/local-charts`, {
				credentials: "same-origin",
			});
			if (response.status === 404) return { supported: false, folders: [] };
			if (!response.ok) throw new Error(`Could not load chart folders (HTTP ${response.status})`);
			return { supported: true, folders: normalizeFolderResponse(await response.json()) };
		},
		async setEnabled(path, enabled) {
			const response = await fetchFn(`${CHART_FOLDER_API_BASE}/folders/toggle`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({ folderPath: path, enabled }),
			});
			if (!response.ok) {
				if (response.status === 401 || response.status === 403) {
					throw new Error("Sign in as a Signal K administrator to change chart folders.");
				}
				throw new Error(`Could not change chart folder (HTTP ${response.status})`);
			}
			return response.json().catch(() => ({}));
		},
	};
}

function renderOption({ name, type, checked }) {
	return `<label class="ajrm-map-option"><input type="${type}" value="${escapeHtml(name)}"${checked ? " checked" : ""}><span>${escapeHtml(name)}</span></label>`;
}

function renderFolders(folders) {
	return folders.map((folder) => `<label class="ajrm-map-folder${folder.enabled && !folder.effectiveEnabled ? " inherited-disabled" : ""}" style="--folder-depth:${folder.depth}" title="${escapeHtml(folder.path)}"><input type="checkbox" data-chart-folder value="${escapeHtml(folder.path)}"${folder.enabled ? " checked" : ""}><span>${escapeHtml(folder.name)}</span></label>`).join("");
}

export function floatingPanelHeight({
	top = 0,
	viewportHeight = 0,
	bottomGap = 12,
	maximum = 560,
	minimum = 48,
} = {}) {
	const available = Number(viewportHeight) - Number(top) - Number(bottomGap);
	return Math.max(minimum, Math.min(maximum, Number.isFinite(available) ? available : maximum));
}

export function fitFloatingPanel(panel, windowObject = globalThis.window) {
	if (!panel) return null;
	const top = panel.getBoundingClientRect?.().top ?? 0;
	const height = floatingPanelHeight({ top, viewportHeight: windowObject?.innerHeight });
	panel.style.maxHeight = `${Math.floor(height)}px`;
	return height;
}

export function createChartSelectorControl({
	L,
	map,
	baseMaps,
	getBaseMap,
	setBaseMap,
	overlays = [],
	folderClient = createFolderClient(),
	onFoldersChanged = () => {},
	position = "topleft",
	windowObject = globalThis.window,
}) {
	let panel;
	let button;
	let renderPanel = () => {};
	let fitPanel = () => {};
	let changeHandler = () => {};
	let mapClickHandler = () => {};
	const definition = L.Control.extend({
		options: { position },
			onAdd() {
			const container = L.DomUtil.create("div", "leaflet-bar ajrm-map-selector");
			button = L.DomUtil.create("button", "ajrm-map-button", container);
			button.type = "button";
			setMapControlHoverHelp(button, "Choose maps and charts");
			button.setAttribute("aria-label", "Choose maps and charts");
			button.setAttribute("aria-expanded", "false");
			button.innerHTML = MAP_CONTROL_ICONS.layers;
			panel = L.DomUtil.create("div", "ajrm-map-panel", container);
			panel.hidden = true;
			renderPanel = () => {
				const base = Object.keys(baseMaps).map((name) => renderOption({ name, type: "radio", checked: getBaseMap() === name })).join("");
				const normal = overlays.filter((item) => item.name !== AUTO_CHARTS_NAME);
				const automatic = overlays.find((item) => item.name === AUTO_CHARTS_NAME);
				panel.innerHTML = `<div class="ajrm-map-title">Basemap</div>${base}<div class="ajrm-map-title">Overlays</div>${normal.map((item) => renderOption({ name: item.name, type: "checkbox", checked: item.isEnabled() })).join("")}${automatic ? renderOption({ name: automatic.name, type: "checkbox", checked: automatic.isEnabled() }) : ""}${automatic ? '<details data-folders hidden><summary>Chart folders</summary><div data-folder-list>Loading chart folders…</div></details>' : ""}`;
			};
			const refreshFolders = async () => {
				const details = panel.querySelector("[data-folders]");
				if (!details) return;
				try {
					const result = await folderClient.list();
					details.hidden = !result.supported || result.folders.length === 0;
					const list = details.querySelector("[data-folder-list]");
					if (list) list.innerHTML = renderFolders(result.folders);
					fitFloatingPanel(panel, windowObject);
				} catch (error) {
					details.hidden = false;
					details.querySelector("[data-folder-list]").textContent = error.message;
					fitFloatingPanel(panel, windowObject);
				}
			};
			fitPanel = () => {
				if (!panel.hidden) fitFloatingPanel(panel, windowObject);
			};
			renderPanel();
			L.DomEvent.disableClickPropagation(container);
			L.DomEvent.disableScrollPropagation(container);
			L.DomEvent.on(button, "click", (event) => {
				L.DomEvent.stop(event);
				panel.hidden = !panel.hidden;
				button.setAttribute("aria-expanded", String(!panel.hidden));
				if (!panel.hidden) {
					renderPanel();
					fitPanel();
					void refreshFolders();
				}
			});
			windowObject?.addEventListener?.("resize", fitPanel);
			changeHandler = async (event) => {
				const input = event.target;
				if (!input || String(input.tagName).toLowerCase() !== "input") return;
				if (input.dataset.chartFolder !== undefined) {
					input.disabled = true;
					try {
						await folderClient.setEnabled(input.value, input.checked);
						await onFoldersChanged();
						await refreshFolders();
					} catch (error) {
						input.checked = !input.checked;
						input.disabled = false;
						globalThis.alert?.(error.message);
					}
					return;
				}
				const foldersWereOpen = panel.querySelector("[data-folders]")?.open === true;
				if (input.type === "radio") setBaseMap(input.value);
				else overlays.find((item) => item.name === input.value)?.setEnabled(input.checked);
				renderPanel();
				const folderDetails = panel.querySelector("[data-folders]");
				if (folderDetails) folderDetails.open = foldersWereOpen;
				await refreshFolders();
			};
			panel.addEventListener("change", changeHandler);
			mapClickHandler = () => {
				panel.hidden = true;
				button.setAttribute("aria-expanded", "false");
			};
			map.on("click", mapClickHandler);
			return container;
		},
		onRemove() {
			windowObject?.removeEventListener?.("resize", fitPanel);
			panel?.removeEventListener?.("change", changeHandler);
			map.off?.("click", mapClickHandler);
		},
	});
	const control = new definition();
	return { control, addTo: (target = map) => control.addTo(target), update: () => panel && renderPanel() };
}

export function normalizeCoordinateFormat(value, fallback = "dms") {
	return ["dms", "degrees-minutes", "decimal"].includes(value) ? value : fallback;
}

export function formatCoordinate(value, axis, format = "dms") {
	if (!Number.isFinite(value)) return "—";
	const hemisphere = axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
	const absolute = Math.abs(value);
	if (format === "decimal") return `${absolute.toFixed(6)}°${hemisphere}`;
	const degrees = Math.floor(absolute);
	const minutesValue = (absolute - degrees) * 60;
	if (format === "degrees-minutes") return `${degrees}° ${minutesValue.toFixed(3)}′ ${hemisphere}`;
	const minutes = Math.floor(minutesValue);
	const seconds = (minutesValue - minutes) * 60;
	return `${degrees}° ${minutes}′ ${seconds.toFixed(1)}″ ${hemisphere}`;
}
