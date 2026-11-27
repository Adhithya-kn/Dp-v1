import { getApp } from "../server.ts";

let app: ReturnType<typeof getApp>;
try {
  app = getApp();
} catch (err) {
  console.error("[VERCEL_STARTUP_ERROR]", err);
  throw err;
}

export default app;
