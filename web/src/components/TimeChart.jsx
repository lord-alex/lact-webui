import { useCallback, useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

const MAX_POINTS = 600;

/**
 * Rolling time-series chart.
 *
 * props:
 *   title      - heading above the chart
 *   series     - [{ key, label, color }] describing the plotted series
 *   pushSample - ref that this component assigns a sample sink function to;
 *                the owner calls pushSample.current(timestamp, extract)
 *                on every stats frame, extract(key) returning the value.
 */
export function TimeChart({ title, series, pushSample }) {
  const containerRef = useRef(null);
  const plotRef = useRef(null);
  const dataRef = useRef({ t: [], ...Object.fromEntries(series.map((s) => [s.key, []])) });
  const seriesRef = useRef(series);
  seriesRef.current = series;

  const [visible, setVisible] = useState(
    Object.fromEntries(series.map((s, i) => [i, true])),
  );

  // Stable across renders: pushes the buffered data into the current plot.
  const setData = useCallback(() => {
    const d = dataRef.current;
    plotRef.current?.setData([d.t, ...seriesRef.current.map((s) => d[s.key])]);
  }, []);

  useChart(plotRef, containerRef, series, visible, dataRef, setData);

  const pushRef = useRef(null);
  pushRef.current = (sample) => {
    const d = dataRef.current;
    d.t.push(sample.t);
    for (const s of seriesRef.current) {
      if (!d[s.key]) d[s.key] = [];
      const v = sample[s.key];
      d[s.key].push(v === undefined || v === null ? null : v);
    }
    if (d.t.length > MAX_POINTS) {
      d.t.shift();
      for (const k of Object.keys(d)) {
        if (k !== "t" && d[k].length > 0) d[k].shift();
      }
    }
    setData();
  };

  useEffect(() => {
    pushSample.current = (t, extract) => {
      const sample = { t };
      for (const s of seriesRef.current) sample[s.key] = extract(s.key);
      pushRef.current(sample);
    };
  }, [pushSample]);

  const toggle = (i) => setVisible((v) => ({ ...v, [i]: !v[i] }));

  return (
    <div className="chart-card">
      <div className="chart-header">
        <h3>{title}</h3>
        <div className="legend">
          {series.map((s, i) => (
            <button
              key={s.key}
              className={`legend-chip${visible[i] ? " on" : ""}`}
              style={{ "--c": s.color }}
              onClick={() => toggle(i)}
              type="button"
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-body" ref={containerRef} />
    </div>
  );
}

function useChart(plotRef, containerRef, series, visible, dataRef, setData) {
  const seriesRef = useRef(series);
  seriesRef.current = series;

  // Create the plot once; only rebuild it when the set of series keys changes
  // (e.g. a new temperature sensor appears), restoring buffered data.
  useEffect(() => {
    const body = containerRef.current;
    const width = body.clientWidth;
    const height = 180;

    const createPlot = (widthOverride) => {
      return new uPlot(
        {
          width: widthOverride ?? width,
          height,
          cursor: { points: { show: false } },
          legend: { show: false },
          scales: { x: { time: true } },
          axes: [
            {
              stroke: "#54607a",
              grid: { stroke: "#252b3b" },
              ticks: { stroke: "#252b3b" },
            },
            {
              stroke: "#54607a",
              grid: { stroke: "#252b3b" },
              ticks: { stroke: "#252b3b" },
              side: 1,
            },
          ],
          series: [
            {},
            ...seriesRef.current.map((s) => ({
              label: s.label,
              stroke: s.color,
              width: 1.5,
              spanGaps: true,
              points: { show: false },
            })),
          ],
        },
        null,
        body,
      );
    };

    const u = createPlot();
    plotRef.current = u;

    const onResize = () => {
      u.setSize({ width: body.clientWidth, height });
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      u.destroy();
      plotRef.current = null;
    };
  }, [containerRef, plotRef, dataRef, setData]);

  // Rebuild the plot if the series keys change (same data is restored).
  const seriesKeys = series.map((s) => s.key).join(",");
  const lastSeriesKeys = useRef(seriesKeys);
  useEffect(() => {
    if (lastSeriesKeys.current === seriesKeys) return;
    lastSeriesKeys.current = seriesKeys;

    const u = plotRef.current;
    const body = containerRef.current;
    if (!u || !body) return;

    u.destroy();
    const rebuilt = new uPlot(
      {
        width: body.clientWidth,
        height: 180,
        cursor: { points: { show: false } },
        legend: { show: false },
        scales: { x: { time: true } },
        axes: [
          {
            stroke: "#54607a",
            grid: { stroke: "#252b3b" },
            ticks: { stroke: "#252b3b" },
          },
          {
            stroke: "#54607a",
            grid: { stroke: "#252b3b" },
            ticks: { stroke: "#252b3b" },
            side: 1,
          },
        ],
        series: [
          {},
          ...series.map((s) => ({
            label: s.label,
            stroke: s.color,
            width: 1.5,
            spanGaps: true,
            points: { show: false },
          })),
        ],
      },
      null,
      body,
    );
    plotRef.current = rebuilt;
    setData();
  }, [seriesKeys, containerRef, plotRef, setData]);

  // Apply legend visibility toggles.
  useEffect(() => {
    const u = plotRef.current;
    if (!u || dataRef.current.t.length === 0) return;
    u.series.forEach((s, i) => {
      if (i > 0) s.show = visible[i - 1];
    });
    u.redraw();
  }, [visible, seriesKeys]);
}
