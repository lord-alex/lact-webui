import React, { useEffect, useRef, useState } from "react";
import { apiGet, apiPut, apiPost } from "../lib/api.js";
import { ConfirmBox } from "./FanControl.jsx";

const CONFIRM_WINDOW_MS = 4500; // daemon auto-reverts after 5s

const PERF_LEVELS = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "high", label: "High" },
  { value: "highest", label: "Highest" },
  { value: "manual", label: "Manual" },
  { value: "profile_standard", label: "Profile: Standard" },
  { value: "profile_min_sclk", label: "Profile: Min core clock" },
  { value: "profile_min_mclk", label: "Profile: Min VRAM clock" },
  { value: "profile_peak", label: "Profile: Peak" },
];

export function PowerClocksModal({ gpuId, gpuName, onClose }) {
  const [config, setConfig] = useState(null);
  const [stats, setStats] = useState(null);
  const [clocks, setClocks] = useState(null);
  const [ppModes, setPpModes] = useState([]);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);
  const [pending, setPending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [note, setNote] = useState(null);

  useEffect(() => {
    let alive = true;
    const id = encodeURIComponent(gpuId);
    apiGet(`/api/devices/${id}/config`).then((c) => alive && setConfig(c)).catch((e) => alive && setError(e.message));
    fetch(`/api/devices/${id}/clocks`).then((r) => r.json()).then((c) => alive && setClocks(c)).catch(() => {});
    fetchStatsOnce(gpuId).then((s) => alive && s && setStats(s));
    fetch(`/api/devices/${id}/pp-modes`).then((r) => r.json()).then((p) => alive && setPpModes(p.modes ?? [])).catch(() => {});
    return () => {
      alive = false;
    };
  }, [gpuId]);

  async function fetchStatsOnce(gpuId) {
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
          if (msg.stats) {
            clearTimeout(timer);
            ws.close();
            resolve(msg.stats);
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

  const handleConfirm = async (command) => {
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
  };

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

  const power = stats?.power;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Power & Clocks — {gpuName}</h2>
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
            <section className="pc-section">
              <h3>Power limit</h3>
              {power?.cap_max != null ? (
                <PowerCap config={config} patchConfig={patchConfig} power={power} />
              ) : (
                <div className="muted">Power limit control is not available for this GPU.</div>
              )}
            </section>

            <section className="pc-section">
              <h3>Performance level</h3>
              <select
                value={config.performance_level ?? ""}
                onChange={(e) => patchConfig(() => ({ performance_level: e.target.value || null }))}
              >
                <option value="">(driver default)</option>
                {PERF_LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </section>

            {ppModes.length > 0 && (
              <section className="pc-section">
                <h3>Power profile mode</h3>
                <select
                  value={config.power_profile_mode_index ?? ""}
                  onChange={(e) => patchConfig(() => ({ power_profile_mode_index: e.target.value === "" ? null : Number(e.target.value) }))}
                >
                  <option value="">(unchanged)</option>
                  {ppModes.map((m) => (
                    <option key={m.index} value={m.index}>
                      {m.index} — {m.name}
                    </option>
                  ))}
                </select>
              </section>
            )}

            <section className="pc-section">
              <h3>Core clock / voltage curve (SCLK)</h3>
              <VfCurveTable
                levels={gcnLevels(clocks, "sclk_levels")}
                range={gcnRange(clocks, "vddc")}
                clockRange={gcnRange(clocks, "sclk")}
                overrides={config.gpu_vf_curve ?? {}}
                onChange={(v) => patchConfig(() => ({ gpu_vf_curve: v }))}
                clockLabel="MHz"
                voltageLabel="mV"
              />
            </section>

            <section className="pc-section">
              <h3>VRAM clock / voltage curve (MCLK)</h3>
              <VfCurveTable
                levels={gcnLevels(clocks, "mclk_levels")}
                range={gcnRange(clocks, "vddc")}
                clockRange={gcnRange(clocks, "mclk")}
                overrides={config.mem_vf_curve ?? {}}
                onChange={(v) => patchConfig(() => ({ mem_vf_curve: v }))}
                clockLabel="MHz"
                voltageLabel="mV"
              />
            </section>

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

function PowerCap({ config, patchConfig, power }) {
  const useCustom = config.power_cap != null;
  const value = useCustom ? config.power_cap : (power.cap_default ?? power.cap_current ?? 0);

  return (
    <div>
      <label className="switch-row">
        <input
          type="checkbox"
          checked={useCustom}
          onChange={(e) => patchConfig(() => ({ power_cap: e.target.checked ? value : null }))}
        />
        <span>Custom power limit</span>
      </label>
      {useCustom && (
        <div className="form-row" style={{ marginTop: 8 }}>
          <div className="slider-row" style={{ width: "100%" }}>
            <input
              type="range"
              min={power.cap_min ?? 0}
              max={power.cap_max ?? 300}
              step={1}
              value={value}
              onChange={(e) => patchConfig(() => ({ power_cap: Number(e.target.value) }))}
            />
            <span className="slider-value">{value} W</span>
          </div>
        </div>
      )}
      <div className="muted" style={{ marginTop: 6 }}>
        Range: {power.cap_min} – {power.cap_max} W · default {power.cap_default} W
      </div>
    </div>
  );
}

function gcnLevels(clocks, key) {
  const table = clocks?.table;
  if (table?.type === "amd" && table.value?.kind === "gcn") {
    return table.value.data?.[key] ?? null;
  }
  return null;
}

function gcnRange(clocks, key) {
  const table = clocks?.table;
  if (table?.type === "amd" && table.value?.kind === "gcn") {
    return table.value.data?.od_range?.[key] ?? null;
  }
  return null;
}

/**
 * Editable VF point list.
 * `levels` — default points from the clocks table [{clockspeed, voltage}]
 * `overrides` — config map {"<index>": {voltage, clockspeed}} with optional fields
 */
function VfCurveTable({ levels, range, clockRange, overrides, onChange, clockLabel, voltageLabel }) {
  if (!levels || levels.length === 0) {
    return <div className="muted">Clocks table is not available for this GPU.</div>;
  }

  const clampClock = (v) => (clockRange ? Math.min(clockRange.max, Math.max(clockRange.min, v)) : v);
  const clampVolt = (v) => (range ? Math.min(range.max, Math.max(range.min, v)) : v);

  const getOverride = (i) => overrides[String(i)] ?? {};

  function setPoint(i, field, raw) {
    const value = raw === "" ? undefined : Number(raw);
    const next = { ...overrides };
    const point = { ...(next[String(i)] ?? {}) };
    point[field] = value;
    if (point.voltage === undefined && point.clockspeed === undefined) {
      delete next[String(i)];
    } else {
      next[String(i)] = point;
    }
    onChange(next);
  }

  function clampPoint(i, field, clampFn, limitRange) {
    if (!limitRange) return;
    const o = getOverride(i);
    const raw = o[field];
    if (raw === undefined || raw === null || raw === "") return;
    const clamped = clampFn(Number(raw));
    if (clamped !== raw) setPoint(i, field, clamped);
  }

  function resetAll() {
    onChange({});
  }

  const modified = Object.keys(overrides).length > 0;

  return (
    <div>
      <table className="vf-table">
        <thead>
          <tr>
            <th>State</th>
            <th>Clock ({clockLabel})</th>
            <th>Voltage ({voltageLabel})</th>
          </tr>
        </thead>
        <tbody>
          {levels.map((lvl, i) => {
            const o = getOverride(i);
            const clock = o.clockspeed ?? lvl.clockspeed;
            const volt = o.voltage ?? lvl.voltage;
            const isMod = o.clockspeed !== undefined || o.voltage !== undefined;
            return (
              <tr key={i} className={isMod ? "modified" : ""}>
                <td>{i}</td>
                <td>
                  <input
                    type="number"
                    min={clockRange?.min}
                    max={clockRange?.max}
                    value={clock ?? ""}
                    onChange={(e) => setPoint(i, "clockspeed", e.target.value === "" ? undefined : Number(e.target.value))}
                    onBlur={(e) => clampPoint(i, "clockspeed", clampClock, clockRange)}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={range?.min}
                    max={range?.max}
                    value={volt ?? ""}
                    onChange={(e) => setPoint(i, "voltage", e.target.value === "" ? undefined : Number(e.target.value))}
                    onBlur={(e) => clampPoint(i, "voltage", clampVolt, range)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="vf-footer">
        <span className="muted">
          Ranges: clock {clockRange ? `${clockRange.min}–${clockRange.max}` : "?"} {clockLabel}, voltage {range ? `${range.min}–${range.max}` : "?"} {voltageLabel}
        </span>
        <button className="btn small" onClick={resetAll} disabled={!modified} type="button">
          Reset curve to defaults
        </button>
      </div>
    </div>
  );
}
