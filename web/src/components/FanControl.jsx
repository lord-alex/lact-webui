import React, { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPut, apiPost, defaultGpuConfig } from "../lib/api.js";

const CONFIRM_WINDOW_MS = 4500; // daemon auto-reverts after 5s

const CURVE_TEMP_MIN = 30;
const CURVE_TEMP_MAX = 95;

export function FanControlModal({ gpuId, gpuName, onClose }) {
  const [config, setConfig] = useState(null);
  const [sensorKeys, setSensorKeys] = useState([]);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);
  const [pending, setPending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [note, setNote] = useState(null);

  useEffect(() => {
    let alive = true;
    apiGet(`/api/devices/${encodeURIComponent(gpuId)}/config`)
      .then((cfg) => alive && setConfig(cfg ?? defaultGpuConfig()))
      .catch((e) => alive && setError(e.message));
    // Sensor keys come from sniffing one live stats frame.
    fetchTempKeys(gpuId).then((keys) => alive && keys && setSensorKeys(keys));
    return () => {
      alive = false;
    };
  }, [gpuId]);

  async function fetchTempKeys(gpuId) {
    // Sniff one stats frame over WS to discover available temperature sensors.
    return new Promise((resolve) => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/api/devices/${encodeURIComponent(gpuId)}/stream`);
      const timer = setTimeout(() => {
        ws.close();
        resolve(null);
      }, 2500);
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.stats?.temps) {
            clearTimeout(timer);
            ws.close();
            resolve(Object.keys(msg.stats.temps));
          }
        } catch {
          /* ignore */
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
    });
  }

  const patchConfig = (fn) => setConfig((c) => ({ ...c, ...fn(c) }));

  async function handleApply() {
    setApplying(true);
    setError(null);
    try {
      await apiPut(`/api/devices/${encodeURIComponent(gpuId)}/config`, config);
      setPending(true);
      setCountdown(Math.round(CONFIRM_WINDOW_MS / 1000));
    } catch (e) {
      setError(e.message);
    } finally {
      setApplying(false);
    }
  }

  const handleConfirm = useCallback(
    async (command) => {
      try {
        await apiPost(`/api/devices/${encodeURIComponent(gpuId)}/confirm`, { command });
        setPending(false);
        setCountdown(0);
        if (command === "confirm") {
          setNote("Settings saved.");
        } else {
          setNote("Settings reverted.");
          setConfig(await apiGet(`/api/devices/${encodeURIComponent(gpuId)}/config`));
        }
      } catch (e) {
        setError(e.message);
        setPending(false);
        setCountdown(0);
      }
    },
    [gpuId],
  );

  // Auto-revert if the user does nothing while the confirm dialog is open.
  const countdownRef = useRef(handleConfirm);
  countdownRef.current = handleConfirm;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(t);
          countdownRef.current("revert");
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [pending]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Fan Control — {gpuName}</h2>
          <button className="icon-btn" onClick={onClose} title="Close" type="button">
            ✕
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {note && <div className="note-banner">{note}</div>}

        {pending ? (
          <ConfirmBox countdown={countdown} onConfirm={() => handleConfirm("confirm")} onRevert={() => handleConfirm("revert")} />
        ) : config ? (
          <>
            <FanSettings config={config} patchConfig={patchConfig} sensorKeys={sensorKeys} />
            <div className="modal-footer">
              <button className="btn secondary" onClick={onClose} type="button">
                Cancel
              </button>
              <button className="btn primary" onClick={handleApply} disabled={applying} type="button">
                {applying ? "Applying…" : "Apply"}
              </button>
            </div>
          </>
        ) : (
          <div className="loading">Loading configuration…</div>
        )}
      </div>
    </div>
  );
}

function FanSettings({ config, patchConfig, sensorKeys }) {
  const enabled = config.fan_control_enabled;
  const settings = config.fan_control_settings ?? {};
  const mode = settings.mode ?? "static";
  const curve = settings.curve ?? {};

  return (
    <div className="fan-settings">
      <label className="switch-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) =>
            patchConfig(() => ({
              fan_control_enabled: e.target.checked,
              fan_control_settings: e.target.checked
                ? { ...settings, mode: settings.mode === "default" ? "static" : settings.mode }
                : settings,
            }))
          }
        />
        <span>Custom fan control enabled</span>
      </label>

      {enabled && (
        <>
          <div className="form-row">
            <span className="form-label">Mode</span>
            <select
              value={mode === "default" ? "static" : mode}
              onChange={(e) =>
                patchConfig(() => ({
                  fan_control_settings: { ...settings, mode: e.target.value },
                }))
              }
            >
              <option value="static">Static</option>
              <option value="curve">Curve</option>
            </select>
          </div>

          <div className="form-row">
            <span className="form-label">Temperature sensor</span>
            <select
              value={settings.temperature_key ?? "edge"}
              onChange={(e) =>
                patchConfig(() => ({
                  fan_control_settings: { ...settings, temperature_key: e.target.value },
                }))
              }
            >
              {(sensorKeys.length > 0 ? sensorKeys : ["edge", "hotspot", "junction", "mem"]).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <span className="form-label">Update interval (ms)</span>
            <input
              type="number"
              min={100}
              max={5000}
              step={100}
              value={settings.interval_ms ?? 500}
              onChange={(e) =>
                patchConfig(() => ({
                  fan_control_settings: { ...settings, interval_ms: Number(e.target.value) },
                }))
              }
            />
          </div>

          {mode === "static" && (
            <div className="form-row">
              <span className="form-label">Static speed</span>
              <div className="slider-row">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round((settings.static_speed ?? 0.5) * 100)}
                  onChange={(e) =>
                    patchConfig(() => ({
                      fan_control_settings: { ...settings, static_speed: Number(e.target.value) / 100 },
                    }))
                  }
                />
                <span className="slider-value">{Math.round((settings.static_speed ?? 0.5) * 100)}%</span>
              </div>
            </div>
          )}

          {mode === "curve" && <CurveEditor curve={curve} onChange={(c) => patchConfig(() => ({ fan_control_settings: { ...settings, curve: c } }))} />}
        </>
      )}
    </div>
  );
}

function CurveEditor({ curve, onChange }) {
  // curve is {"40": 0.4, ...} temp -> speed fraction
  const points = useCallback(
    () =>
      Object.entries(curve)
        .map(([t, s]) => ({ t: Number(t), s: Number(s) }))
        .sort((a, b) => a.t - b.t),
    [curve],
  );

  const svgRef = useRef(null);
  const dragIndex = useRef(null);

  const PLOT = { x: 42, y: 10, w: 460, h: 240 };

  const toPx = (t, s) => [
    PLOT.x + ((t - CURVE_TEMP_MIN) / (CURVE_TEMP_MAX - CURVE_TEMP_MIN)) * PLOT.w,
    PLOT.y + (1 - s) * PLOT.h,
  ];
  const fromPx = (x, y) => [
    CURVE_TEMP_MIN + ((x - PLOT.x) / PLOT.w) * (CURVE_TEMP_MAX - CURVE_TEMP_MIN),
    1 - (y - PLOT.y) / PLOT.h,
  ];

  function commit(newPoints) {
    newPoints.sort((a, b) => a.t - b.t);
    const obj = {};
    for (const p of newPoints) {
      obj[String(Math.round(p.t))] = Math.round(clamp(p.s, 0.05, 1) * 100) / 100;
    }
    onChange(obj);
  }

  function pointerPos(evt) {
    const rect = svgRef.current.getBoundingClientRect();
    const sx = PLOT.w / (rect.width - 0);
    const sy = PLOT.h / (rect.height - 0);
    return [(evt.clientX - rect.left) * (600 / rect.width), (evt.clientY - rect.top) * (260 / rect.height)];
  }

  const onMove = (evt) => {
    if (dragIndex.current == null) return;
    const [x, y] = pointerPos(evt);
    const pts = points();
    const i = dragIndex.current;
    if (!pts[i]) return;
    const [t, s] = fromPx(clamp(x, PLOT.x, PLOT.x + PLOT.w), clamp(y, PLOT.y, PLOT.y + PLOT.h));
    pts[i] = { t: clamp(t, CURVE_TEMP_MIN, CURVE_TEMP_MAX), s: clamp(s, 0.05, 1) };
    commit(pts);
  };

  const onUp = () => {
    dragIndex.current = null;
  };

  function onBackgroundClick(evt) {
    if (evt.detail !== 1 || dragIndex.current != null) return;
    const [x, y] = pointerPos(evt);
    if (x < PLOT.x || x > PLOT.x + PLOT.w || y < PLOT.y || y > PLOT.y + PLOT.h) return;
    const [t, s] = fromPx(x, y);
    const pts = points();
    // Avoid stacking points on nearly the same temperature
    if (pts.some((p) => Math.abs(p.t - t) < 2)) return;
    commit([...pts, { t: clamp(t, CURVE_TEMP_MIN, CURVE_TEMP_MAX), s: clamp(s, 0.05, 1) }]);
  }

  function onPointDoubleClick(index) {
    const pts = points();
    if (pts.length <= 1) return;
    pts.splice(index, 1);
    commit(pts);
  }

  const pts = points();
  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${toPx(p.t, p.s).join(" ")}`).join(" ");

  const tempTicks = [30, 40, 50, 60, 70, 80, 90];
  const speedTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="curve-editor">
      <svg
        ref={svgRef}
        viewBox="0 0 600 260"
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        onClick={onBackgroundClick}
      >
        {/* plot background */}
        <rect x={PLOT.x} y={PLOT.y} width={PLOT.w} height={PLOT.h} className="curve-plot-bg" />
        {/* gridlines */}
        {tempTicks.map((t) => {
          const [x] = toPx(t, 0);
          return (
            <g key={`t${t}`}>
              <line x1={x} y1={PLOT.y} x2={x} y2={PLOT.y + PLOT.h} className="curve-grid" />
              <text x={x} y={PLOT.y + PLOT.h + 16} className="curve-tick" textAnchor="middle">
                {t}°
              </text>
            </g>
          );
        })}
        {speedTicks.map((s) => {
          const [, y] = toPx(0, s);
          return (
            <g key={`s${s}`}>
              <line x1={PLOT.x} y1={y} x2={PLOT.x + PLOT.w} y2={y} className="curve-grid" />
              <text x={PLOT.x - 8} y={y + 4} className="curve-tick" textAnchor="end">
                {Math.round(s * 100)}%
              </text>
            </g>
          );
        })}
        {/* current-config polyline */}
        <path d={linePath} className="curve-line" />
        {pts.map((p, i) => {
          const [x, y] = toPx(p.t, p.s);
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={7}
              className="curve-point"
              onPointerDown={(e) => {
                dragIndex.current = i;
                e.target.setPointerCapture?.(e.pointerId);
              }}
              onDoubleClick={() => onPointDoubleClick(i)}
            />
          );
        })}
      </svg>
      <div className="curve-hint">Drag points to adjust · click empty space to add · double-click a point to remove</div>
    </div>
  );
}

export function ConfirmBox({ countdown, onConfirm, onRevert }) {
  return (
    <div className="confirm-box">
      <div className="confirm-title">Keep these fan settings?</div>
      <div className="confirm-text">
        The daemon will revert automatically in <b>{countdown}s</b> if not confirmed.
      </div>
      <div className="confirm-actions">
        <button className="btn danger" onClick={onRevert} type="button">
          Revert
        </button>
        <button className="btn primary" onClick={onConfirm} type="button">
          Confirm
        </button>
      </div>
    </div>
  );
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
