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
