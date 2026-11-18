import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stat, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { LactdClient, StatsPoller, DaemonError } from "./lactd.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5170);
const HOST = process.env.HOST ?? "127.0.0.1";
const WEB_DIST = process.env.WEB_DIST ?? path.resolve(__dirname, "../../web/dist");

const lactd = new LactdClient();
const pollers = new Map(); // gpuId -> StatsPoller

function getPoller(gpuId) {
  if (!pollers.has(gpuId)) {
    pollers.set(gpuId, new StatsPoller(lactd, gpuId));
  }
  return pollers.get(gpuId);
}

const app = Fastify({ logger: true });

// Vulkan device enumeration (from the vulkan-enum helper, no display needed)
const VULKAN_ENUM = path.resolve(__dirname, "../vulkan-enum");
let vulkanCache = { data: null, at: 0 };
app.get("/api/vulkan", async () => {
  const TTL = 300_000;
  if (vulkanCache.data && Date.now() - vulkanCache.at < TTL) return vulkanCache.data;
  let out = "";
  try {
    out = await new Promise((resolve, reject) => {
      execFile(VULKAN_ENUM, { timeout: 5000, env: { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
  } catch (e) {
    app.log.warn({ err: e.message }, "vulkan-enum failed");
    return [];
  }
  // skip software renderers (llvmpipe: Mesa vendor 0x10005)
  const devices = out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((d) => d && d.vendorId !== 0x10005);
  vulkanCache = { data: devices, at: Date.now() };
  return devices;
});

await app.register(fastifyWebsocket);

app.get("/api/system", async () => lactd.request("system_info"));

app.get("/api/devices", async () => lactd.request("list_devices"));

app.get("/api/devices/:id/info", async (req) =>
  lactd.request("device_info", { id: req.params.id }),
);

app.get("/api/devices/:id/config", async (req) =>
  lactd.request("get_gpu_config", { id: req.params.id }),
);

app.get("/api/devices/:id/clocks", async (req) =>
  lactd.request("device_clocks_info", { id: req.params.id }),
);

app.put("/api/devices/:id/config", async (req) =>
  lactd.request("set_gpu_config", { id: req.params.id, config: req.body }),
);

app.post("/api/devices/:id/confirm", async (req) =>
  lactd.request("confirm_pending_config", { command: req.body?.command ?? "confirm" }),
);

// AMD power profile modes are not exposed by the daemon API; read the sysfs file
// for the PCI address embedded in the gpu id (…-0000:XX:YY.Z).
app.get("/api/devices/:id/pp-modes", async (req) => {
  const pciAddr = req.params.id.split("-").pop();
  const filePath = path.join("/sys/bus/pci/devices", pciAddr, "pp_power_profile_mode");
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return { modes: [], active_index: null };
  }
  const modes = [];
  let activeIndex = null;
  for (const line of content.split("\n").slice(1)) {
    const m = line.match(/^\s*(\d+)\s+([A-Za-z0-9_]+)\s*(\*)?\s*:/);
    if (m) {
      modes.push({ index: Number(m[1]), name: m[2] });
      if (m[3]) activeIndex = Number(m[1]);
    }
  }
  return { modes, active_index: activeIndex };
});

app.get("/api/devices/:id/stream", { websocket: true }, (socket, req) => {
  const unsubscribe = getPoller(req.params.id).subscribe((msg) => {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(msg));
    }
  });
  socket.on("close", unsubscribe);
});

app.setErrorHandler((err, req, reply) => {
  req.log.error(err);
  const status = err instanceof DaemonError ? 502 : 500;
  reply.code(status).send({ error: err.message });
});

const webDistExists = await stat(WEB_DIST).then((s) => s.isDirectory()).catch(() => false);
if (webDistExists) {
  await fastifyStatic(app, { root: WEB_DIST });
  // SPA fallback
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      reply.code(404).send({ error: "not found" });
    } else {
      reply.sendFile("index.html");
    }
  });
} else {
  app.log.warn(`Web dist not found at ${WEB_DIST}, serving API only`);
}

await lactd.connect();
lactd.on("disconnect", (err) => app.log.error({ err }, "lost connection to lactd, will reconnect on next request"));

await app.listen({ port: PORT, host: HOST });
app.log.info(`LACT web bridge listening on http://${HOST}:${PORT}`);
