import { randomUUID } from "node:crypto";
import {
  createApp,
  createError,
  createRouter,
  defineEventHandler,
  send,
  setHeader,
  setResponseStatus,
} from "h3";
import { registerEchoRoutes } from "./features/echo/routes.ts";
import { healthSchema } from "../shared/contracts.ts";

export function createApi(options: { appName: string; logRequests?: boolean }) {
  const app = createApp({
    debug: false,
    onError(error, event) {
      const status = error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
      const requestId = event.context.requestId ?? "unavailable";
      if (status >= 500) {
        const cause = error.cause instanceof Error ? error.cause : error;
        const errorType = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(cause.name) ? cause.name : "Error";
        // Keep enough information for correlation without logging messages, stacks,
        // request data, headers or upstream/provider responses.
        console.error(JSON.stringify({ event: "request_error", requestId, status, errorType }));
      }
      setResponseStatus(event, status);
      setHeader(event, "content-type", "application/json; charset=utf-8");
      // Never return a stack, provider response, body or secret to the client.
      return send(
        event,
        JSON.stringify({
          error: {
            code: `HTTP_${status}`,
            message:
              status >= 500 ? "Internal server error" : error.statusMessage || "Request failed",
          },
          requestId,
        }),
      );
    },
  });
  app.use(
    defineEventHandler((event) => {
      const requestId = randomUUID();
      const started = performance.now();
      event.context.requestId = requestId;
      setHeader(event, "x-request-id", requestId);
      setHeader(event, "x-content-type-options", "nosniff");
      setHeader(event, "cache-control", "no-store");
      if (options.logRequests !== false) {
        event.node.res.once("finish", () => {
          console.log(
            JSON.stringify({
              event: "request",
              requestId,
              method: event.method,
              // Do not log query strings, headers, payloads or credentials.
              status: event.node.res.statusCode,
              durationMs: Math.round(performance.now() - started),
            }),
          );
        });
      }
    }),
  );
  const router = createRouter();
  const healthHandler = defineEventHandler((event) =>
    healthSchema.parse({
      status: "ok",
      app: options.appName,
      requestId: event.context.requestId,
    }),
  );
  router.get("/api/health", healthHandler);
  router.head("/api/health", healthHandler);
  router.use(
    "/api/health",
    defineEventHandler((event) => {
      setHeader(event, "allow", "GET, HEAD");
      throw createError({ statusCode: 405, statusMessage: "Method not allowed" });
    }),
  );
  registerEchoRoutes(router);
  app.use(router);
  app.use(
    defineEventHandler(() => {
      throw createError({ statusCode: 404, statusMessage: "API route not found" });
    }),
  );
  return app;
}
