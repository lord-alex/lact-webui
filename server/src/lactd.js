import net from "node:net";
import { EventEmitter } from "node:events";

const DEFAULT_SOCKET_PATH = "/run/lactd.sock";

/**
 * Connection to the LACT daemon.
 *
 * The daemon protocol is newline-delimited JSON: one response line per
 * request line. Requests are serialized through a promise queue so that
 * concurrent callers (HTTP handlers, stats pollers) never interleave.
 */
export class LactdClient extends EventEmitter {
  constructor({ socketPath = process.env.LACTD_SOCKET ?? DEFAULT_SOCKET_PATH } = {}) {
    super();
    this.socketPath = socketPath;
    this.socket = null;
    this.buffer = "";
    this.queue = [];
    this.connecting = null;
  }

  async connect() {
    if (this.socket?.readyForUse) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath);

      socket.once("connect", () => {
        socket.readyForUse = true;
        this.socket = socket;
        this.connecting = null;
        resolve();
      });

      socket.once("error", (err) => {
        if (this.connecting) {
          this.connecting = null;
          reject(err);
        }
        this._handleLoss(err);
      });

      socket.once("close", () => this._handleLoss(new Error("connection closed")));

      socket.setNoDelay(true);
      socket.on("data", (chunk) => this._onData(chunk));
    });

    return this.connecting;
  }

  _handleLoss(err) {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    // Fail anything in flight, callers re-queue automatically on retry.
    while (this.queue.length) {
      const { reject } = this.queue.shift();
      reject(err);
    }
    this.emit("disconnect", err);
  }

  _onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;

      const pending = this.queue.shift();
      if (!pending) continue;

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        pending.reject(new Error(`Unparseable daemon response: ${line.slice(0, 200)}`));
        continue;
      }
      if (parsed.status === "ok") {
        pending.resolve(parsed.data ?? null);
      } else {
        pending.reject(new DaemonError(parsed.data ?? "unknown daemon error"));
      }
    }
  }

  /** Send a single command and resolve with the `data` field of the response. */
  async request(command, args = undefined) {
    await this.connect();

    const payload = args === undefined ? { command } : { command, args };
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.queue.push(entry);
      this.socket.write(JSON.stringify(payload) + "\n", (err) => {
        if (err) {
          const i = this.queue.indexOf(entry);
          if (i !== -1) {
            this.queue.splice(i, 1);
            reject(err);
          }
        }
      });
    });
  }
}

export class DaemonError extends Error {
  constructor(message) {
    super(message);
    this.name = "DaemonError";
  }
}

/**
 * Polls device_stats for a given GPU and broadcasts to subscribers.
 * One poller per GPU regardless of how many WS clients are watching.
 */
export class StatsPoller {
  constructor(client, gpuId, intervalMs = 1000) {
    this.client = client;
    this.gpuId = gpuId;
    this.intervalMs = intervalMs;
    this.listeners = new Set();
    this.timer = null;
    this.inFlight = false;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    this._start();
    // Send the most recent snapshot immediately if we have one.
    if (this.last) fn(this.last);
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this._stop();
    };
  }

  async _tick() {
    if (this.inFlight || this.listeners.size === 0) return;
    this.inFlight = true;
    try {
      const stats = await this.client.request("device_stats", { id: this.gpuId });
      this.last = { timestamp: Date.now(), stats };
      for (const fn of this.listeners) {
        try {
          fn(this.last);
        } catch {
          /* listener errors must not break polling */
        }
      }
    } catch (err) {
      for (const fn of this.listeners) {
        try {
          fn({ timestamp: Date.now(), error: String(err.message ?? err) });
        } catch {
          /* ignore */
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  _start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), this.intervalMs);
    this._tick();
  }

  _stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
