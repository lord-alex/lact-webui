/**
 * Default GPU config used when the daemon reports no saved configuration
 * (get_gpu_config returns null for GPUs that were never modified).
 */
export function defaultGpuConfig() {
  return {
    fan_control_enabled: false,
    fan_control_settings: {
      mode: "static",
      static_speed: 0.5,
      temperature_key: "edge",
      interval_ms: 500,
      curve: { 40: 0.3, 50: 0.35, 60: 0.5, 70: 0.75, 80: 1.0 },
    },
    performance_level: null,
    power_cap: null,
    gpu_vf_curve: {},
    mem_vf_curve: {},
    power_profile_mode_index: null,
  };
}

/**
 * Base (hardware default) clocks table cache.
 * The daemon's clocks table reflects currently applied VF overrides, so the
 * true defaults are only visible while a GPU has no overrides. Cache them.
 */
const VF_BASE_PREFIX = "lact.vfBase.";

export function loadVfBase(gpuId) {
  try {
    return JSON.parse(localStorage.getItem(VF_BASE_PREFIX + gpuId)) ?? null;
  } catch {
    return null;
  }
}

export function saveVfBase(gpuId, clocks) {
  try {
    localStorage.setItem(VF_BASE_PREFIX + gpuId, JSON.stringify(clocks));
  } catch {
    /* storage unavailable */
  }
}

export function hasVfOverrides(config) {
  return (
    Object.keys(config?.gpu_vf_curve ?? {}).length > 0 ||
    Object.keys(config?.mem_vf_curve ?? {}).length > 0
  );
}

export async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function apiPut(path, body) {
  const res = await fetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Subscribe to a GPU stats stream. Returns an unsubscribe function. */
export function streamStats(gpuId, onSample) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/devices/${encodeURIComponent(gpuId)}/stream`);
  ws.onmessage = (evt) => {
    try {
      onSample(JSON.parse(evt.data));
    } catch {
      /* ignore malformed frames */
    }
  };
  return () => ws.close();
}
