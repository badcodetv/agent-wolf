import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Logger } from "./logger.js";
import { WolfError } from "./errors.js";

/**
 * Builds the Express 5 app. Kept separate from index.ts so tests can
 * `import { createApp }` and drive it with `supertest`-style requests
 * without binding a real port.
 */
export function createApp(logger: Logger): Express {
  const app = express();
  app.use(express.json());

  // Mounted at /api/healthz, not /healthz: nginx's /api/ location (prod)
  // and vite's /api proxy (dev) both forward the full path unrewritten
  // (see web/nginx.conf.template and web/vite.config.ts), matching every
  // route in § "Wolf API routes" of the plan, which are all /api/....
  app.get("/api/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // One shared error handler: any route that throws (or calls `next(err)`
  // with) a WolfError is answered with its taxonomy status and kind, never
  // a raw stack trace. Non-WolfErrors are logged and answered as 500.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof WolfError) {
      logger.warn({ kind: err.kind, path: req.path, msg: err.message }, "request failed");
      res.status(err.status).json({ kind: err.kind, message: err.message, details: err.details });
      return;
    }
    logger.error({ err, path: req.path }, "unhandled error");
    res.status(500).json({ kind: "unavailable", message: "internal error" });
  });

  return app;
}
