import { createServer } from "node:http";
import { toNodeListener } from "h3";
import sirv from "sirv";
import { createApi } from "./app.ts";
import {
  createDefaultVoiceRouterController,
  type VoiceRouterController,
} from "./features/voice-router/controller.ts";
import { attachVoiceRouterSocket } from "./features/voice/transport.ts";

export function createHttpServer(options: {
  appName: string;
  webRoot?: string;
  logRequests?: boolean;
  voiceRouterController?: VoiceRouterController;
}) {
  const controller =
    options.voiceRouterController ?? createDefaultVoiceRouterController(process.env);
  const api = toNodeListener(createApi({ ...options, voiceRouterController: controller }));
  const staticFiles = options.webRoot
    ? sirv(options.webRoot, {
        single: true,
        etag: true,
        onNoMatch(_req, res) {
          res.setHeader("cache-control", "no-store");
          res.statusCode = 404;
          res.end();
        },
      })
    : undefined;
  const server = createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    let pathname: string;
    try {
      if (!rawUrl.startsWith("/")) throw new URIError("Expected an origin-form URL");
      const parsed = new URL(`http://localhost${rawUrl}`);
      pathname = decodeURI(parsed.pathname);
      if (/[\\\u0000-\u001f\u007f]/u.test(pathname)) {
        throw new URIError("Path contains a forbidden character");
      }
      // Re-encode exactly once so H3 and sirv both receive the same canonical path.
      req.url = `${encodeURI(pathname)}${parsed.search}`;
    } catch {
      res.writeHead(400, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      res.end("Bad request path");
      return;
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      void api(req, res);
      return;
    }
    if (staticFiles && (req.method === "GET" || req.method === "HEAD")) {
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
      res.setHeader("x-frame-options", "SAMEORIGIN");
      res.setHeader(
        "cache-control",
        /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u.test(pathname)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
      staticFiles(req, res);
      return;
    }
    res.writeHead(404, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    res.end("Not found. In development open the Vite port, not the API port.");
  });
  const closeVoiceSessions = attachVoiceRouterSocket(server, controller, process.env);
  return Object.assign(server, { closeVoiceSessions });
}
