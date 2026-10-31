// Cloudflare Worker: WebSocket-релей до серверов Telegram (*.web.telegram.org/apiws)
// Деплой: wrangler deploy  (или вставить код в Workers → Quick edit)
const DC = ["pluto", "venus", "aurora", "vesta", "flora"];
function hostFor(h) {
  if (/^[a-z0-9-]+\.web\.telegram\.org$/.test(h)) return h;
  // gramjs иногда подключается по IP дата-центра
  if (/^149\.154\.175\.5\d$/.test(h)) return "pluto.web.telegram.org";
  if (/^149\.154\.167\.(4\d|5\d|2\d\d)$/.test(h)) return "venus.web.telegram.org";
  if (/^149\.154\.175\.100$/.test(h)) return "aurora.web.telegram.org";
  if (/^149\.154\.167\.(91|92)$/.test(h)) return "vesta.web.telegram.org";
  if (/^91\.108\.56\.\d+$/.test(h)) return "flora.web.telegram.org";
  return "venus.web.telegram.org";
}
export default {
  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("ok");
    const host = hostFor(new URL(req.url).searchParams.get("h") || "");
    const up = await fetch("https://" + host + "/apiws", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "binary" } });
    const upWs = up.webSocket;
    if (!upWs) return new Response("upstream failed", { status: 502 });
    upWs.accept();
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (e) => { try { upWs.send(e.data); } catch (_) {} });
    upWs.addEventListener("message", (e) => { try { server.send(e.data); } catch (_) {} });
    const close = () => { try { server.close(); } catch (_) {} try { upWs.close(); } catch (_) {} };
    server.addEventListener("close", close); upWs.addEventListener("close", close);
    server.addEventListener("error", close); upWs.addEventListener("error", close);
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": "binary" } });
  },
};
