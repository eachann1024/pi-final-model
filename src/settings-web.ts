import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

export class SettingsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** A session-owned loopback bridge. Only the URL fragment holds the access token. */
export async function startSettingsWeb(snapshot: () => unknown, update: (value: unknown) => Promise<void>) {
  const token = randomBytes(24).toString("hex");
  const [page, script, manifest, icon] = await Promise.all([
    readFile(new URL("./settings.html", import.meta.url), "utf8"),
    readFile(new URL("./settings.js", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("./icon.svg", import.meta.url), "utf8"),
  ]);
  const version = String(JSON.parse(manifest).version);
  const html = page.replace("__VERSION__", /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ? version : "");
  let origin = "";
  let closed = false;
  let queue = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requests = 0;
  let deadline = Date.now();
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  const arm = () => {
    clearTimeout(timer);
    if (closed || requests) return;
    timer = setTimeout(close, Math.max(0, deadline - Date.now()));
    timer.unref();
  };
  const touch = () => { deadline = Date.now() + 30 * 60_000; arm(); };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (req.headers.host !== origin.slice(7) || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403).end(); return;
    }
    if (req.method === "GET" && req.url === "/icon.svg") {
      res.setHeader("Content-Type", "image/svg+xml");
      res.end(icon); return;
    }
    if (req.method === "GET" && (req.url === "/" || req.url === "/settings.js")) {
      res.setHeader("Content-Type", req.url === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8");
      res.end(req.url === "/" ? html : script); return;
    }
    if (req.url !== "/settings" || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end(); return;
    }
    clearTimeout(timer);
    requests++;
    let renewed = false;
    try {
      if (req.method === "PUT") {
        if (req.headers["content-type"] !== "application/json") throw new SettingsError("请求格式无效。", 415);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk);
          size += buffer.length;
          if (size > 16384) throw new SettingsError("设置内容过长。", 413);
          chunks.push(buffer);
        }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const saving = queue.then(() => {
          if (closed) throw new SettingsError("设置页已关闭，请重新打开。", 410);
          return update(value);
        });
        queue = saving.catch(() => {});
        await saving;
      } else if (req.method !== "GET") throw new SettingsError("不支持的操作。", 405);
      else await queue;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(snapshot()));
      renewed = true;
    } catch (error) {
      const status = error instanceof SettingsError ? error.status : error instanceof SyntaxError ? 400 : 500;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error instanceof SettingsError ? error.message : status === 400 ? "设置格式无效。" : "无法保存，请检查配置文件权限后重试。" }));
    } finally {
      requests--;
      if (renewed) touch(); else arm();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { close(); throw new Error("无法启动设置页。"); }
  origin = `http://127.0.0.1:${address.port}`;
  server.unref();
  touch();
  return { url: `${origin}/#${token}`, get closed() { return closed; }, touch, close };
}
