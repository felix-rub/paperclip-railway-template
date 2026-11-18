import { request } from "node:http";

export function attachUpgradeProxy(server, { port, ready }) {
  server.on("upgrade", (req, socket, head) => {
    if (!ready()) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    let responseStarted = false;
    let peer;
    const upstream = request({
      hostname: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        "x-forwarded-host": req.headers.host,
        "x-forwarded-proto": "https",
        "x-forwarded-for": req.socket.remoteAddress,
      },
    });
    upstream.setTimeout(15_000, () => upstream.destroy(new Error("WebSocket handshake timed out")));
    const writeHeaders = response => {
      responseStarted = true;
      const headers = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        headers.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      }
      socket.write(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n${headers.join("\r\n")}\r\n\r\n`);
    };
    const shutdown = () => {
      upstream.destroy();
      peer?.destroy();
    };
    socket.on("error", shutdown);
    socket.once("close", shutdown);
    upstream.once("error", error => {
      console.error("Paperclip WebSocket upstream failed:", error.message);
      if (socket.destroyed) return;
      if (responseStarted) socket.destroy();
      else socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    upstream.once("response", response => {
      // Preserve upstream authentication failures instead of accepting the socket.
      writeHeaders(response);
      response.pipe(socket);
    });
    upstream.once("upgrade", (response, upstreamSocket, upstreamHead) => {
      peer = upstreamSocket;
      if (socket.destroyed) return shutdown();
      upstreamSocket.setTimeout(0);
      writeHeaders(response);
      if (head.length) upstreamSocket.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      upstreamSocket.on("error", () => socket.destroy());
      upstreamSocket.once("close", () => socket.destroy());
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstream.end();
  });
}
