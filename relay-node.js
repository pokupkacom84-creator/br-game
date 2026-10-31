// Релей для своего VPS: node relay-node.js  (npm i ws)
// Поставьте перед ним nginx/Caddy с доменом и TLS — страница на HTTPS требует wss://.
// nginx: proxy_pass http://127.0.0.1:8787; proxy_http_version 1.1; Upgrade/Connection заголовки.
const { WebSocketServer, WebSocket } = require("ws");
const url = require("url");
const hostFor = (h) => /^[a-z0-9-]+\.web\.telegram\.org$/.test(h) ? h
  : /^149\.154\.175\.5\d$/.test(h) ? "pluto.web.telegram.org"
  : /^149\.154\.175\.100$/.test(h) ? "aurora.web.telegram.org"
  : /^149\.154\.167\.(91|92)$/.test(h) ? "vesta.web.telegram.org"
  : /^91\.108\.56\.\d+$/.test(h) ? "flora.web.telegram.org"
  : "venus.web.telegram.org";
const wss = new WebSocketServer({ port: +process.env.PORT || 8787, handleProtocols: () => "binary" });
wss.on("connection", (c, req) => {
  const host = hostFor(url.parse(req.url, true).query.h || "");
  const up = new WebSocket("wss://" + host + "/apiws", "binary", { headers: { Origin: "https://web.telegram.org" } });
  const q = [];
  c.on("message", (d) => (up.readyState === 1 ? up.send(d) : q.push(d)));
  up.on("open", () => q.splice(0).forEach((d) => up.send(d)));
  up.on("message", (d) => c.readyState === 1 && c.send(d));
  const end = () => { try { c.close(); } catch (_) {} try { up.close(); } catch (_) {} };
  c.on("close", end); up.on("close", end); c.on("error", end); up.on("error", end);
});
console.log("relay on :" + (process.env.PORT || 8787));
