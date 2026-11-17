import React, { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, streamStats } from "./lib/api.js";
import { TimeChart } from "./components/TimeChart.jsx";
import { FanControlModal } from "./components/FanControl.jsx";
import { PowerClocksModal } from "./components/PowerClocks.jsx";

const SENSORS_LABELS = { edge: "Edge", hotspot: "Hotspot", junction: "Junction", mem: "Memory", vr_sox: "VR SoX" };

const SERIES_COLORS = ["#4fd1c5", "#f6ad55", "#f56565", "#63b3ed", "#b794f4", "#68d391", "#f687b3"];

export default function App() {
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiGet("/api/devices")
      .then(setDevices)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <h1>LACT</h1>
        <span className="subtitle">GPU monitor</span>
        {error && <span className="error-badge">{error}</span>}
      </header>
      {!devices ? (
        <div className="loading">Loading…</div>
      ) : devices.length === 0 ? (
        <div className="loading">No GPUs found</div>
      ) : (
        devices.map((d) => <GpuCard key={d.id} gpuId={d.id} name={d.name} />)
      )}
    </div>
  );
}

function GpuCard({ gpuId, name }) {
  const [stats, setStats] = useState(null);
  const [connError, setConnError] = useState(null);
  const [showFanControl, setShowFanControl] = useState(false);
  const [showPowerClocks, setShowPowerClocks] = useState(false);

  // Refs assigned by each TimeChart to receive samples
  const tempRef = useRef(() => {});
  const clockRef = useRef(() => {});
  const powerRef = useRef(() => {});
  const fanRef = useRef(() => {});

  useEffect(() => {
    setStats(null);
    const unsubscribe = streamStats(gpuId, (msg) => {
      if (msg.error) {
        setConnError(msg.error);
        return;
      }
      setConnError(null);
      setStats(msg);

      const { timestamp, stats: s } = msg;
      tempRef.current?.(timestamp, (key) => getTemp(s, key));
      clockRef.current?.(timestamp, (key) => {
        if (key === "gpu_clock") return s.clockspeed?.gpu_clockspeed ?? null;
        if (key === "vram_clock") return s.clockspeed?.vram_clockspeed ?? null;
        if (key === "gpu_volt") return s.voltage?.gpu ?? null;
        return null;
      });
      powerRef.current?.(timestamp, (key) => {
        if (key === "power") return s.power?.current ?? null;
        if (key === "power_cap") return s.power?.cap_current ?? null;
        return null;
      });
      fanRef.current?.(timestamp, (key) => {
        if (key === "fan_rpm") return s.fan?.speed_current ?? null;
        if (key === "fan_pct") return s.fan?.pwm_current != null ? Math.round((s.fan.pwm_current / s.fan.pwm_max) * 100) : null;
        if (key === "busy") return s.busy_percent ?? null;
        return null;
      });
    });
    return unsubscribe;
  }, [gpuId]);

  const tempKeys = useMemo(() => Object.keys(stats?.stats?.temps ?? {}), [stats]);
  const tempSeries = useMemo(
    () =>
      tempKeys.map((k, i) => ({
        key: k,
        label: SENSORS_LABELS[k] ?? k,
        color: SERIES_COLORS[i % SERIES_COLORS.length],
      })),
    [tempKeys],
  );

  const fan = stats?.stats?.fan;
  const fanPct = fan?.pwm_current != null && fan?.pwm_max ? Math.round((fan.pwm_current / fan.pwm_max) * 100) : null;

  return (
    <section className="gpu-card">
      <div className="gpu-header">
        <button className="btn small" onClick={() => setShowFanControl(true)} type="button" title="Fan control">
          Fans
        </button>
        <button className="btn small" onClick={() => setShowPowerClocks(true)} type="button" title="Power, clocks and voltage">
          Power
        </button>
        <h2>{name}</h2>
        {connError && <span className="error-badge">{connError}</span>}
      </div>
      <div className="tiles">
        <Tile label="Temp" value={fmt(primaryTemp(stats), "°C")} hint={tempKeys[0] ? (SENSORS_LABELS[tempKeys[0]] ?? tempKeys[0]) : null} />
        <Tile label="Fan" value={fmt(fan?.speed_current, " RPM")} hint={fanPct != null ? `${fanPct}% PWM` : null} />
        <Tile label="GPU Clock" value={fmt(stats?.stats?.clockspeed?.gpu_clockspeed, " MHz")} />
        <Tile label="VRAM Clock" value={fmt(stats?.stats?.clockspeed?.vram_clockspeed, " MHz")} />
        <Tile label="VRAM Usage" value={fmtGiB(stats?.stats?.vram)} />
        <Tile label="GPU Volt" value={fmt(stats?.stats?.voltage?.gpu, " mV")} />
        <Tile label="Power" value={fmt(stats?.stats?.power?.current, " W")} hint={stats?.stats?.power?.cap_current != null ? `cap ${stats.stats.power.cap_current} W` : null} />
        <Tile label="Utilization" value={fmt(stats?.stats?.busy_percent, "%")} />
      </div>
      <div className="charts">
        {tempSeries.length > 0 && <TimeChart title="Temperatures" series={tempSeries} pushSample={tempRef} />}
        <TimeChart
          title="Clocks & Voltage"
          series={[
            { key: "gpu_clock", label: "GPU MHz", color: "#4fd1c5" },
            { key: "vram_clock", label: "VRAM MHz", color: "#63b3ed" },
            { key: "gpu_volt", label: "Voltage mV", color: "#f6ad55" },
          ]}
          pushSample={clockRef}
        />
        <TimeChart
          title="Power"
          series={[
            { key: "power", label: "Power W", color: "#f56565" },
            { key: "power_cap", label: "Cap W", color: "#b794f4" },
          ]}
          pushSample={powerRef}
        />
        <TimeChart
          title="Fan & Utilization"
          series={[
            { key: "fan_rpm", label: "RPM", color: "#68d391" },
            { key: "fan_pct", label: "PWM %", color: "#f687b3" },
            { key: "busy", label: "Busy %", color: "#63b3ed" },
          ]}
          pushSample={fanRef}
        />
      </div>
      {showFanControl && <FanControlModal gpuId={gpuId} gpuName={name} onClose={() => setShowFanControl(false)} />}
      {showPowerClocks && <PowerClocksModal gpuId={gpuId} gpuName={name} onClose={() => setShowPowerClocks(false)} />}
    </section>
  );
}

function Tile({ label, value, hint }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value ?? "—"}</div>
      {hint && <div className="tile-hint">{hint}</div>}
    </div>
  );
}

function primaryTemp(stats) {
  const temps = stats?.stats?.temps;
  if (!temps) return null;
  const keys = Object.keys(temps);
  if (keys.length === 0) return null;
  const primary = keys.find((k) => temps[k].primary) ?? keys[0];
  return temps[primary].current;
}

function getTemp(stats, key) {
  const t = stats?.temps?.[key];
  return t ? t.current : null;
}

function fmt(v, unit) {
  return v == null ? null : `${v}${unit}`;
}

function fmtGiB(vram) {
  if (!vram || vram.total == null) return null;
  const usedMiB = (vram.used ?? 0) / 1024 / 1024;
  const totalMiB = vram.total / 1024 / 1024;
  return `${Math.round(usedMiB)} / ${Math.round(totalMiB)} MiB`;
}
