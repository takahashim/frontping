// 依存ゼロの静的サーバ。examples/wizard を配信し、
// /sdk.js では frontping SDK のビルド成果物（sdk/dist/index.js）を返す。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sdkDist = join(here, "..", "..", "sdk", "dist", "index.js");
const PORT = Number(process.env.PORT) || 5173;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url || "/").split("?")[0]);
    if (path === "/") path = "/index.html";

    // SDK のビルド成果物を配信
    if (path === "/sdk.js") {
      const body = await readFile(sdkDist).catch(() => null);
      if (!body) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("SDK 未ビルドです。先に `pnpm --dir ../../sdk build` を実行してください。");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" });
      res.end(body);
      return;
    }

    // endpoint 注入（ローカル既定はローカル Worker。WIZARD_ENDPOINT で上書き可）
    if (path === "/config.js") {
      const endpoint = process.env.WIZARD_ENDPOINT ?? "http://localhost:8787";
      res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" });
      res.end(`window.FRONTPING_ENDPOINT = ${JSON.stringify(endpoint)};\n`);
      return;
    }

    // ディレクトリトラバーサル防止
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
    const file = join(here, safe);
    if (!file.startsWith(here)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`wizard demo: http://localhost:${PORT}`);
  console.log("frontping worker は http://localhost:8787 で起動しておくこと（worker/ で `pnpm exec wrangler dev`）");
});
