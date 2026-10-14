import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import { DASH_COOKIE, dashCookieValue, deny, safeEqual } from "./security.js";

export function defaultDashboardDir(): string {
  return fileURLToPath(new URL("../dashboard/", import.meta.url));
}

/**
 * `GET /?token=<token>` trades the bearer token for the HttpOnly dashboard cookie and redirects to `/`;
 * `GET /` serves index.html uncached; `/assets/*` serves the built bundle.
 */
export function registerStatic(app: Express, opts: { token: string; dir?: string }): void {
  const dir = opts.dir ?? defaultDashboardDir();
  const cookie = dashCookieValue(opts.token);

  app.get("/", (req: Request, res: Response) => {
    const presented = req.query.token;
    if (presented !== undefined) {
      if (typeof presented !== "string" || !safeEqual(presented, opts.token)) return deny(res, 401, "unauthorized");
      // Persistent (400 days, the browser maximum) so the dashboard still opens after a browser restart.
      res.setHeader("Set-Cookie", `${DASH_COOKIE}=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000`);
      res.setHeader("Cache-Control", "no-store");
      return res.redirect(302, "/");
    }
    const index = join(dir, "index.html");
    if (!existsSync(index)) return deny(res, 503, "dashboard_not_built", { hint: "run npm run build in the gisool package" });
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(index);
  });

  app.use("/assets", express.static(join(dir, "assets"), { index: false, fallthrough: false }));
}
