import fs from "node:fs";
import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { AppDatabase } from "./src/server/database.ts";
import {
  ROAD_REGISTRY,
  computeMfdDensity,
  getAllCorridors,
  getCorridorLaneInfo,
  matchPlacesToCorridors,
  normalizeCorridorId,
} from "./src/server/roadRegistry.ts";
import { classifySpeedLos, classifyTrafficSeverity, roundTo } from "./src/server/physics.ts";
import { TrafficPredictor, validatePredictionFeatures } from "./src/server/predictor.ts";
import {
  ApiManager,
  EventManager,
  HeatmapService,
  JunctionService,
  LiveTrafficDataBridge,
  PolicySimulator,
  RouteNavigator,
  SecurityManager,
  generateActionDirective,
  isValidIdentifier,
  isValidIsoDate,
  nowIso,
  parseTimeStr,
} from "./src/server/services.ts";
import type { SessionRecord } from "./src/server/services.ts";
import { VisionService } from "./src/server/visionService.ts";

const BASE_DIR = process.cwd();

function loadLocalEnvFile(baseDir: string): void {
  const envPath = path.join(baseDir, ".env");
  if (!fs.existsSync(envPath)) return;
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = val;
      }
    }
  } catch {
    // Non-fatal if .env is unreadable
  }
}

loadLocalEnvFile(BASE_DIR);

export interface AppRuntimeOptions {
  baseDir?: string;
  dbPath?: string;
}

export function createApp(opts?: AppRuntimeOptions) {
  const baseDir = opts?.baseDir ?? BASE_DIR;
  const staticDir = path.join(baseDir, "public");
  const guidesDir = path.join(staticDir, "guides");

  const appDb = new AppDatabase({ baseDir, dbPath: opts?.dbPath });
  const predictor = new TrafficPredictor(baseDir);
  const security = new SecurityManager(baseDir, appDb);
  const eventMgr = new EventManager(baseDir, appDb);
  const navigator = new RouteNavigator(predictor, eventMgr);
  const simulator = new PolicySimulator(predictor);
  const junctionService = new JunctionService(predictor, eventMgr);
  const heatmapService = new HeatmapService(predictor, junctionService, eventMgr);
  const apiManager = new ApiManager(appDb);
  const liveBridge = new LiveTrafficDataBridge(predictor, apiManager, navigator, appDb);
  const visionService = new VisionService(baseDir, appDb);

  // Non-blocking startup sync for live Open-Meteo Bengaluru weather
  liveBridge.refreshLiveWeather().catch(() => {});

  const app = express();

  // CORS & Security headers
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With, X-Filename, X-Upload-ID, X-Chunk-Index, X-Chunk-SHA256, Upload-ID, Chunk-Index, Chunk-SHA256"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE, HEAD");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Raw binary parsers for video upload & chunk upload endpoints
  app.use("/api/vision/upload/chunk", express.raw({ type: "*/*", limit: "10mb" }));
  app.use("/api/vision/upload", (req, res, next) => {
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    if (ct.includes("application/json")) {
      express.json({ limit: "25mb" })(req, res, next);
    } else {
      express.raw({ type: "*/*", limit: "50mb" })(req, res, next);
    }
  });
  app.use(express.json({ limit: "10mb" }));

  // -------------------------------------------------------------------------
  // Auth & RBAC Middleware (Strict SQLite Session Verification)
  // -------------------------------------------------------------------------
  function extractToken(req: Request): string {
    const authHeader = String(req.headers.authorization || "");
    if (authHeader.startsWith("Bearer ")) {
      return authHeader.slice(7).trim();
    }
    if (typeof req.query.token === "string" && req.query.token.trim()) {
      return req.query.token.trim();
    }
    return "";
  }

  function getAuthUser(req: Request): SessionRecord | null {
    const token = extractToken(req);
    if (!token) return null;
    return security.getUserByToken(token);
  }

  function sendErr(res: Response, message: string, status = 400) {
    res.status(status).json({
      success: false,
      status: "error",
      error: message,
      message,
      code: status,
      timestamp: nowIso(),
    });
  }

  function requireAuth(req: Request, res: Response, next: NextFunction) {
    const user = getAuthUser(req);
    if (!user) {
      sendErr(res, "Authentication required. Please sign in with a valid session token.", 401);
      return;
    }
    res.locals.authUser = user;
    next();
  }

  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    const user = getAuthUser(req);
    if (!user) {
      sendErr(res, "Authentication required. Please sign in with a valid session token.", 401);
      return;
    }
    if (user.role !== "Traffic Management") {
      sendErr(res, "Traffic Management operator privileges required for this action.", 403);
      return;
    }
    res.locals.authUser = user;
    next();
  }

  function streamVideoWithRange(req: Request, res: Response, filePath: string, mime = "video/mp4") {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.status(404).end();
      return;
    }
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range && range.startsWith("bytes=")) {
      const parts = range.slice(6).trim().split("-");
      const start = parts[0] ? parseInt(parts[0], 10) : 0;
      const end = parts[1] ? Math.min(parseInt(parts[1], 10), fileSize - 1) : fileSize - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start >= fileSize || start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
        return;
      }
      const chunkLen = end - start + 1;
      res.writeHead(206, {
        "Content-Type": mime,
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Content-Length": chunkLen,
        "Accept-Ranges": "bytes",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": fileSize,
      "Accept-Ranges": "bytes",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  }

  // -------------------------------------------------------------------------
  // HTML Routes (Login & Portal)
  // -------------------------------------------------------------------------
  const LOGIN_ROUTES = ["/", "/login", "/signin", "/login.html"];
  const PORTAL_ROUTES = [
    "/portal",
    "/dashboard",
    "/app",
    "/index.html",
    "/traffic",
    "/heatmap",
    "/vision",
    "/live_traffic",
    "/live-traffic",
    "/monitor",
    "/predict",
    "/decide",
  ];

  app.get("/favicon.ico", (_req, res) => res.status(204).end());
  app.get(["/synthesizer", "/synthesizer/"], (_req, res) => res.redirect(302, "/portal"));

  app.get(LOGIN_ROUTES, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.join(staticDir, "login.html"));
  });

  app.get(PORTAL_ROUTES, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.join(staticDir, "index.html"));
  });

  // Operator guides & system diagrams
  app.use("/guides", express.static(guidesDir));
  app.use("/architecture", express.static(guidesDir));

  // -------------------------------------------------------------------------
  // Health & Metrics & Evaluation
  // -------------------------------------------------------------------------
  app.all(["/health", "/api/health", "/api/health/liveness", "/api/health/readiness"], (req, res) => {
    const isReadiness =
      req.path === "/api/health/readiness" ||
      String(req.query.readiness || "").toLowerCase() === "true" ||
      req.query.type === "readiness";

    if (req.method === "HEAD") {
      res.status(200).setHeader("Content-Type", "application/json; charset=utf-8").end();
      return;
    }

    if (isReadiness) {
      const dbOk = appDb.isHealthy();
      const checks = {
        predictor_loaded: predictor.isTrained() && Object.keys(predictor.topology).length > 0,
        database_connected: dbOk,
        event_engine_ready: dbOk && eventMgr.getEventCount() >= 0,
        storage_writeable: dbOk,
        security_db_ready: dbOk && security.getUserCount() > 0,
        integrations_ready: true,
      };
      const allReady = Object.values(checks).every(Boolean);
      res.status(allReady ? 200 : 503).json({
        success: allReady,
        status: allReady ? "ready" : "not_ready",
        service: "Smart Traffic AI",
        readiness: allReady,
        liveness: true,
        checks,
        database_tables: appDb.getTableCounts(),
        timestamp: nowIso(),
      });
      return;
    }

    res.json({
      success: true,
      status: "healthy",
      liveness: true,
      service: "Smart Traffic AI",
      timestamp: nowIso(),
    });
  });

  app.get("/api/evaluation/summary", async (_req, res) => {
    const mlMetrics = predictor.metrics;
    const ffmpegOk = await visionService.checkFfmpegAvailable();
    const yoloOk = visionService.isYolo11Ready();
    res.json({
      success: true,
      status: "success",
      cv: {
        status: ffmpegOk && yoloOk ? "live_pipeline_ready" : "degraded_cv_pipeline",
        engine: yoloOk ? "Ultralytics YOLOv11s (ONNX) + IoU Tracker" : "YOLOv11s Weights Missing",
        ffmpeg_available: ffmpegOk,
        yolo_loaded: yoloOk,
        message:
          ffmpegOk && yoloOk
            ? "Local FFprobe/FFmpeg frame extraction with Ultralytics YOLOv11s (ONNX) vehicle detection and IoU multi-object tracking active."
            : "CV pipeline degraded: verify FFmpeg and models/yolo11/yolo11s.onnx.",
      },
      ml: {
        status: Object.keys(mlMetrics).length > 0 ? "measured_chronological_benchmark" : "not_measured",
        accuracy_pct: mlMetrics.accuracy_pct ?? null,
        weighted_f1_pct: mlMetrics.weighted_f1_pct ?? null,
        macro_f1_pct: mlMetrics.macro_f1_pct ?? null,
        prediction_horizon: mlMetrics.prediction_horizon ?? null,
        split_metadata: mlMetrics.split_metadata ?? null,
        dataset_provenance: mlMetrics.dataset_provenance ?? null,
        dataset_limitations: mlMetrics.dataset_limitations ?? null,
        baselines: predictor.baselines ?? { status: "not_measured" },
      },
      system: {
        status: appDb.isHealthy() ? "operational" : "degraded",
        runtime: "Node.js 22 TypeScript Express + SQLite WAL + Pure-JSON XGBoost 320-Tree Inference",
        database_tables: appDb.getTableCounts(),
      },
      timestamp: nowIso(),
    });
  });

  app.get("/api/metrics", (_req, res) => {
    const topo = predictor.topology;
    const totalRoads = Object.keys(topo).length;
    const severeCount = Object.values(topo).filter(
      (i) => i.common_congestion === "Severe" || i.peak_congestion === "Severe"
    ).length;
    const zonesCount = new Set(Object.values(topo).map((i) => i.city_zone)).size;
    const metrics: Record<string, unknown> = {
      ...predictor.metrics,
      total_records: predictor.metrics.total_samples ?? 57576,
      total_corridors: totalRoads || 24,
      total_zones: zonesCount || 8,
      severe_pct: totalRoads ? roundTo((severeCount / totalRoads) * 100, 1) : 0.0,
      relieved_corridors: Math.max(1, totalRoads - severeCount),
    };
    if (predictor.baselines) metrics.baselines = predictor.baselines;
    res.json({
      success: true,
      status: "success",
      metrics,
      data: metrics,
      timestamp: nowIso(),
    });
  });

  // -------------------------------------------------------------------------
  // Auth Routes
  // -------------------------------------------------------------------------
  app.post("/api/auth/login", (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    const rl = security.checkRateLimit("login", clientIp, 30, 60);
    if (!rl.allowed) {
      res.status(429).json({
        success: false,
        status: "error",
        message: `Too many login attempts. Retry in ${rl.retryAfter}s.`,
        timestamp: nowIso(),
      });
      return;
    }
    const { ok, msg, session } = security.login(req.body?.username, req.body?.password);
    res.status(ok ? 200 : 401).json({
      success: ok,
      status: ok ? "success" : "error",
      message: msg,
      ...(ok && session ? { session } : {}),
      timestamp: nowIso(),
    });
  });

  app.get("/api/auth/me", requireAuth, (_req, res) => {
    const user = res.locals.authUser as SessionRecord;
    res.json({
      success: true,
      status: "success",
      session: user,
      user: {
        username: user.username,
        role: user.role,
        created_at: user.created_at,
        expires_at: user.expires_at,
      },
      timestamp: nowIso(),
    });
  });

  app.post("/api/auth/logout", requireAuth, (req, res) => {
    const token = extractToken(req);
    security.logout(token);
    res.json({
      success: true,
      status: "success",
      message: "Signed out successfully.",
      timestamp: nowIso(),
    });
  });

  app.post("/api/auth/register", (req, res) => {
    const user = getAuthUser(req);
    const isAdmin = Boolean(user && user.role === "Traffic Management");
    const { ok, msg } = security.register(req.body?.username, req.body?.password, req.body?.role, isAdmin);
    res.status(ok ? 200 : 400).json({
      success: ok,
      status: ok ? "success" : "error",
      message: msg,
      timestamp: nowIso(),
    });
  });

  app.post("/api/auth/delete", requireAdmin, (req, res) => {
    const ok = security.deleteUser(req.body?.username);
    res.status(ok ? 200 : 404).json({
      success: ok,
      status: ok ? "success" : "error",
      message: ok ? "User deleted" : "User not found",
      timestamp: nowIso(),
    });
  });

  // -------------------------------------------------------------------------
  // Roads, Zones & Live Telemetry
  // -------------------------------------------------------------------------
  app.get("/api/roads", async (req, res) => {
    let zone = typeof req.query.zone === "string" ? req.query.zone : null;
    if (zone && zone.toLowerCase() === "all") zone = null;
    const roads = navigator.getAvailableRoads(zone);
    const telemetry = await liveBridge.refreshCorridorTelemetry();
    const telemMap = new Map(telemetry.map((t) => [t.road_id, t]));

    const enriched = roads.map((r) => {
      const t = telemMap.get(String(r.road_id));
      return {
        ...r,
        current_speed: t?.current_speed ?? r.avg_speed,
        vehicle_count: t?.vehicle_count ?? r.avg_volume,
        congestion_level: t?.congestion_level ?? r.peak_congestion ?? "Moderate",
        is_live: t?.is_live ?? false,
        is_cached: t?.is_cached ?? false,
        provenance: t?.provenance ?? "Empirical Bengaluru Baseline",
        source: t?.source ?? "Telemetry",
        observation_time: t?.observation_time ?? nowIso(),
        weather_condition: t?.weather_condition ?? "Clear",
        temperature_c: t?.temperature_c ?? 26.5,
        predicted_future_congestion: t?.predicted_future_congestion ?? t?.congestion_level ?? "Moderate",
      };
    });

    res.json({
      success: true,
      status: "success",
      count: enriched.length,
      roads: enriched,
      timestamp: nowIso(),
    });
  });

  app.get("/api/zones/summary", async (_req, res) => {
    const telemetry = await liveBridge.refreshCorridorTelemetry();
    const groups = new Map<string, typeof telemetry>();
    for (const item of telemetry) {
      const list = groups.get(item.city_zone) ?? [];
      list.push(item);
      groups.set(item.city_zone, list);
    }

    const zones = Array.from(groups.entries()).map(([zone, items]) => {
      const totalRoads = items.length;
      const criticalRoads = items.filter((c) => c.congestion_level === "High" || c.congestion_level === "Severe").length;
      const pctCritical = totalRoads > 0 ? roundTo((criticalRoads / totalRoads) * 100, 1) : 0.0;
      const meanSpeed = totalRoads > 0 ? roundTo(items.reduce((a, b) => a + b.current_speed, 0) / totalRoads, 1) : 0.0;
      const totalVph = items.reduce((a, b) => a + b.vehicle_count, 0);
      const hasLive = items.some((c) => c.is_live);
      const prov = hasLive
        ? "TomTom Live API"
        : items.some((c) => c.is_cached)
          ? "Cached API response"
          : items[0]?.provenance || "Empirical Bengaluru Baseline";
      return {
        zone,
        total_roads: totalRoads,
        critical_roads: criticalRoads,
        pct_critical: pctCritical,
        mean_speed: meanSpeed,
        total_vph: totalVph,
        has_live_data: hasLive,
        provenance: prov,
      };
    });
    zones.sort((a, b) => b.pct_critical - a.pct_critical);

    res.json({
      success: true,
      status: "success",
      zones,
      timestamp: nowIso(),
    });
  });

  app.get("/api/live/status", async (_req, res) => {
    await liveBridge.refreshLiveWeather();
    res.json(liveBridge.getLiveStatus());
  });

  app.get(["/api/live/corridors", "/api/live/telemetry"], async (req, res) => {
    const zone = typeof req.query.zone === "string" ? req.query.zone : null;
    let corridors = await liveBridge.refreshCorridorTelemetry();
    if (zone && zone.toLowerCase() !== "all") {
      corridors = corridors.filter((c) => c.city_zone.toLowerCase() === zone.toLowerCase());
    }
    res.json({
      success: true,
      status: "success",
      count: corridors.length,
      corridors,
      status_info: liveBridge.getLiveStatus(),
      timestamp: nowIso(),
    });
  });

  app.post(["/api/live/corridors", "/api/live/telemetry"], async (req, res) => {
    const zone = req.body?.zone ? String(req.body.zone) : null;
    const force = Boolean(req.body?.force_refresh);
    let corridors = await liveBridge.refreshCorridorTelemetry({ forceRefresh: force });
    if (zone && zone.toLowerCase() !== "all") {
      corridors = corridors.filter((c) => c.city_zone.toLowerCase() === zone.toLowerCase());
    }
    res.json({
      success: true,
      status: "success",
      count: corridors.length,
      corridors,
      status_info: liveBridge.getLiveStatus(),
      timestamp: nowIso(),
    });
  });

  app.post("/api/live/refresh", async (_req, res) => {
    const corridors = await liveBridge.refreshCorridorTelemetry({ forceRefresh: true });
    res.json({
      success: true,
      status: "success",
      count: corridors.length,
      corridors,
      status_info: liveBridge.getLiveStatus(),
      timestamp: nowIso(),
    });
  });

  app.get("/api/traffic-state/:corridorId", (req, res) => {
    const cid = normalizeCorridorId(String(req.params.corridorId || ""));
    if (!ROAD_REGISTRY[cid]) {
      sendErr(res, `Corridor '${cid}' is not a registered Bengaluru corridor.`, 404);
      return;
    }
    const state = liveBridge.getCorridorState(cid);
    res.json({
      success: true,
      status: "success",
      corridor_id: cid,
      state,
      timestamp: nowIso(),
    });
  });

  app.post("/api/traffic-state/ingest", requireAdmin, (req, res) => {
    try {
      const data = liveBridge.injectTrafficMeasurement(req.body || {});
      res.json({
        success: true,
        status: "success",
        message: "Traffic measurement ingested and persisted to SQLite.",
        data,
        timestamp: nowIso(),
      });
    } catch (err) {
      sendErr(res, err instanceof Error ? err.message : "Invalid measurement", 400);
    }
  });

  app.post(["/api/live/route", "/api/live/evaluate_route"], async (req, res) => {
    const evalRes = await liveBridge.evaluateLiveRouteAsync(
      String(req.body?.origin_road || "RD_BLR_01"),
      String(req.body?.destination_road || "RD_BLR_02"),
      req.body?.date ? String(req.body.date) : undefined,
      req.body?.time ? String(req.body.time) : undefined,
      !Boolean(req.body?.all)
    );
    res.json({
      success: true,
      status: "success",
      evaluation: evalRes,
      data: evalRes,
      timestamp: nowIso(),
    });
  });

  app.post("/api/live/predict", (req, res) => {
    const validation = validatePredictionFeatures(req.body?.features);
    if ("error" in validation) {
      sendErr(res, validation.error, 400);
      return;
    }
    const [predClass, probDist] = predictor.predictSegment(validation.features);
    const provenance = {
      model_name: "XGBoost Pure-JSON 320-Tree Ensemble",
      dataset_version: predictor.metrics.dataset_version ?? "Bengaluru_Traffic_Hourly_v1.0",
      model_version: predictor.metrics.model_version ?? "2.0.0-chronological",
      temporal_validation: "Chronological Out-of-Time Date Grouping",
      inference_engine: "Deterministic Tree Traversal",
    };
    res.json({
      success: true,
      status: "success",
      predicted_class: predClass,
      probabilities: probDist,
      provenance,
      model_provenance: provenance,
      timestamp: nowIso(),
    });
  });

  app.post("/api/predict/explain", (req, res) => {
    const validation = validatePredictionFeatures(req.body?.features);
    if ("error" in validation) {
      sendErr(res, validation.error, 400);
      return;
    }
    const explanation = predictor.explainPrediction(validation.features);
    res.json({
      success: true,
      status: "success",
      explanation,
      data: explanation,
      timestamp: nowIso(),
    });
  });

  // -------------------------------------------------------------------------
  // Events Routes
  // -------------------------------------------------------------------------
  app.get(["/api/events", "/api/events/historical"], (req, res) => {
    const isHistory =
      req.path === "/api/events/historical" || String(req.query.history || "").toLowerCase() === "true";
    const includeUnpublished =
      String(req.query.all || "").toLowerCase() === "true" ||
      String(req.query.unpublished || "").toLowerCase() === "true";
    let zone = typeof req.query.zone === "string" ? req.query.zone : null;
    if (zone && zone.toLowerCase() === "all") zone = null;
    const date = typeof req.query.date === "string" ? req.query.date : null;

    const events = isHistory
      ? eventMgr.getHistoricalEvents(zone)
      : date
        ? eventMgr.findActiveEvents({ zone, date, publishedOnly: !includeUnpublished })
        : eventMgr.getScheduledEvents(zone, !includeUnpublished);

    res.json({
      success: true,
      status: "success",
      count: events.length,
      is_historical: isHistory,
      events,
      latest_alert: eventMgr.getLatestAlert(),
      timestamp: nowIso(),
    });
  });

  app.post("/api/events/add", requireAdmin, (req, res) => {
    const { ok, msg, event } = eventMgr.addEvent(req.body || {});
    res.status(ok ? 200 : 400).json({
      success: ok,
      status: ok ? "success" : "error",
      message: msg,
      ...(event ? { event } : {}),
      timestamp: nowIso(),
    });
  });

  app.post("/api/events/publish", requireAdmin, (req, res) => {
    const eid = String(req.body?.event_id || req.body?.id || "");
    const { ok, msg, event } = eventMgr.publishEvent(eid, req.body);
    res.status(ok ? 200 : 404).json({
      success: ok,
      status: ok ? "success" : "error",
      message: msg,
      ...(event ? { event } : {}),
      timestamp: nowIso(),
    });
  });

  app.post(["/api/events/unpublish", "/api/events/retract"], requireAdmin, (req, res) => {
    const eid = String(req.body?.event_id || req.body?.id || "");
    const { ok, msg } = eventMgr.unpublishEvent(eid);
    res.status(ok ? 200 : 404).json({
      success: ok,
      status: ok ? "success" : "error",
      message: msg,
      timestamp: nowIso(),
    });
  });

  app.post("/api/events/delete", requireAdmin, (req, res) => {
    const eid = String(req.body?.event_id || req.body?.id || "");
    const { ok, msg } = eventMgr.deleteEvent(eid);
    res.status(ok ? 200 : 404).json({
      success: ok,
      status: ok ? "success" : "error",
      message: msg,
      timestamp: nowIso(),
    });
  });

  app.post(["/api/events/sync", "/api/events/live/sync"], requireAdmin, async (req, res) => {
    const zone = req.body?.zone ? String(req.body.zone) : null;
    const syncRes = await eventMgr.syncBengaluruLiveIncidents(zone, apiManager.tomtomKey);
    res.json({
      success: true,
      status: "success",
      message:
        syncRes.synced_from === "tomtom_live_v5"
          ? `Synchronized ${syncRes.imported_count} live TomTom incidents for Bengaluru (${zone || "all"}).`
          : `Synchronized SQLite event registry for zone: ${zone || "all"} (configure TomTom key for live external incident feed).`,
      synced_from: syncRes.synced_from,
      imported_count: syncRes.imported_count,
      count: syncRes.events.length,
      events: syncRes.events,
      timestamp: nowIso(),
    });
  });

  // -------------------------------------------------------------------------
  // Dispatch, Routing, Junctions & Policy Simulation
  // -------------------------------------------------------------------------
  app.get("/api/dispatch/directives", (req, res) => {
    const zone =
      typeof req.query.zone === "string" && req.query.zone.toLowerCase() !== "all" ? req.query.zone : "Indiranagar";
    const roads = navigator.getAvailableRoads(zone);
    const now = new Date();
    const hour = now.getHours();
    const dow = (now.getDay() + 6) % 7;
    const isWeekend = dow >= 5 ? 1 : 0;

    const directives = roads.slice(0, 10).map((r) => {
      const rId = String(r.road_id);
      const vol = Number(r.peak_volume ?? r.avg_volume ?? 22000);
      const spd = Number(r.peak_speed ?? r.avg_speed ?? 28);
      const cap = Math.max(Number(r.capacity ?? 35000), 1);
      const [predCong] = predictor.predictSegment({
        city_zone: String(r.city_zone),
        road_id: rId,
        intersection_id: String(r.intersection_id),
        vehicle_count: vol,
        average_speed: spd,
        capacity_utilization: roundTo((vol / cap) * 100, 1),
        congestion_level: String(r.peak_congestion ?? r.common_congestion ?? "Moderate"),
        hour,
        day_of_week: dow,
        is_weekend: isWeekend,
      });
      const evts = eventMgr.findActiveEvents({ roadId: rId });
      const laneInfo = getCorridorLaneInfo(rId);
      return generateActionDirective(rId, zone, predCong, evts.length > 0, evts[0]?.name ?? "", vol, laneInfo.lanes);
    });

    res.json({
      success: true,
      status: "success",
      count: directives.length,
      directives,
      timestamp: nowIso(),
    });
  });

  app.post(["/api/route/evaluate", "/api/evaluate_route"], (req, res) => {
    const now = new Date();
    const defaultDate = now.toISOString().slice(0, 10);
    const defaultTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    const orig = String(req.body?.origin_road || "RD_BLR_01").trim();
    const dest = String(req.body?.destination_road || "RD_BLR_04").trim();
    if (!isValidIdentifier(orig) || !isValidIdentifier(dest)) {
      sendErr(res, `Invalid corridor identifier format: orig='${orig}', dest='${dest}'.`, 400);
      return;
    }
    const dateVal = String(req.body?.departure_date || req.body?.date || defaultDate).trim();
    if (!isValidIsoDate(dateVal)) {
      sendErr(res, `Invalid 'date' format: '${dateVal}'. Expected YYYY-MM-DD.`, 400);
      return;
    }
    const timeVal = String(req.body?.departure_time || req.body?.time || defaultTime).trim();
    try {
      parseTimeStr(timeVal);
    } catch {
      sendErr(res, `Invalid 'time' format: '${timeVal}'. Expected HH:MM.`, 400);
      return;
    }

    const evaluation = navigator.evaluateRoute(orig, dest, dateVal, timeVal);
    res.json({
      success: true,
      status: "success",
      evaluation,
      data: evaluation,
      timestamp: nowIso(),
    });
  });

  app.post("/api/junction/telemetry", (req, res) => {
    const now = new Date();
    const rawTime = String(
      req.body?.time || `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
    ).trim();
    let hour = now.getHours();
    let minute = now.getMinutes();
    try {
      [hour, minute] = parseTimeStr(rawTime);
    } catch {
      sendErr(res, `Invalid 'time' value: '${rawTime}'. Expected HH:MM.`, 400);
      return;
    }
    const roadId = String(req.body?.road_id || "RD_BLR_01").trim();
    const dateStr = String(req.body?.date || now.toISOString().slice(0, 10)).trim();
    const telemetry = junctionService.getJunctionTelemetry({
      roadId,
      hour,
      minute,
      isRerouted: Boolean(req.body?.is_rerouted),
      alternateRoadId: req.body?.alternate_road ? String(req.body.alternate_road) : null,
      dateStr,
    });
    res.json({
      success: true,
      status: "success",
      junction: telemetry,
      data: telemetry,
      timestamp: nowIso(),
    });
  });

  app.post(["/api/simulation/run", "/api/simulate", "/api/simulation"], (req, res) => {
    const result = simulator.simulateZonePolicy(
      req.body?.zone ?? null,
      Number(req.body?.alpha ?? 0.2),
      Number(req.body?.beta ?? 0.1),
      Number(req.body?.hour ?? 17),
      Number(req.body?.day_of_week ?? 3)
    );
    res.json({
      success: true,
      status: "success",
      simulation: result,
      data: result,
      timestamp: nowIso(),
    });
  });

  // -------------------------------------------------------------------------
  // Map, Heatmap & Config Routes
  // -------------------------------------------------------------------------
  app.get(["/api/map/config", "/api/config/google_maps"], (_req, res) => {
    const key = apiManager.googleMapsKey;
    const configured = key.length >= 12;
    const center = { lat: 12.9716, lng: 77.5946 };
    res.json({
      success: true,
      status: "success",
      configured,
      api_key: key,
      google_maps_api_key: key,
      masked_key: apiManager.maskKey(key),
      center,
      default_center: center,
      default_zoom: 12,
      corridors_count: 24,
      map_id: process.env.GOOGLE_MAPS_MAP_ID || "",
      libraries: ["places", "visualization", "geometry"],
      provider: "google_maps",
      timestamp: nowIso(),
    });
  });

  app.get("/api/map/places", (req, res) => {
    const qText = String(req.query.q || req.query.query || "");
    const limit = Number(req.query.limit || 6) || 6;
    const places = matchPlacesToCorridors(qText, limit);
    res.json({
      success: true,
      status: "success",
      query: qText,
      count: places.length,
      places,
      timestamp: nowIso(),
    });
  });

  app.get("/api/map/heatmap/v2", async (req, res) => {
    const horizon = parseInt(String(req.query.horizon || "0"), 10) || 0;
    const channel = String(req.query.channel || "all");
    const telemetry = await liveBridge.refreshCorridorTelemetry();
    res.json(heatmapService.getTriPillarHeatmap(horizon, channel, telemetry));
  });

  app.get("/api/map/heatmap", async (_req, res) => {
    const telemetry = await liveBridge.refreshCorridorTelemetry();
    res.json(heatmapService.getLegacyPointsProjection(telemetry));
  });

  app.get("/api/map/route_lanes", async (_req, res) => {
    const telemetry = await liveBridge.refreshCorridorTelemetry();
    const telemMap = new Map(telemetry.map((t) => [t.road_id, t]));
    const allBase = getAllCorridors();

    const corridorsOut = allBase.map((base) => {
      const rId = base.corridor_id;
      const telem = telemMap.get(rId);
      const topo = predictor.topology[rId];
      const curSpd = telem?.current_speed ?? topo?.avg_speed ?? base.speed_limit_kmh;
      const freeFlowSpd = telem?.free_flow_speed ?? base.free_flow_speed_kmh ?? base.speed_limit_kmh;
      const sev = classifyTrafficSeverity(curSpd, freeFlowSpd);
      const rawLos = telem ? sev.los : (topo?.common_congestion ?? sev.los);
      const rawVol = telem?.vehicle_count ?? topo?.avg_volume ?? 25000;
      let flowQ = rawVol > 5000 ? roundTo(rawVol * 0.045, 1) : roundTo(rawVol, 1);
      if (flowQ < 50) flowQ = 850.0;
      const densityK = computeMfdDensity(flowQ, curSpd, 150.0, 5.0);
      const predLos = telem?.predicted_future_congestion ?? rawLos;
      const predSpd =
        predLos === "Low"
          ? roundTo(Math.min(base.speed_limit_kmh, Math.max(38.0, curSpd * 1.05)), 1)
          : predLos === "Moderate"
            ? roundTo(Math.min(37.5, Math.max(27.0, curSpd * 0.95)), 1)
            : predLos === "High"
              ? roundTo(Math.min(26.5, Math.max(18.0, curSpd * 0.85)), 1)
              : roundTo(Math.min(17.5, Math.max(8.0, curSpd * 0.7)), 1);

      return {
        corridor_id: rId,
        road_id: rId,
        corridor_code: base.corridor_code,
        corridor_name: base.name,
        city_zone: base.city_zone,
        road_type: base.road_type,
        lanes: base.lanes,
        speed_limit_kmh: base.speed_limit_kmh,
        free_flow_speed_kmh: roundTo(freeFlowSpd, 1),
        current_speed_kmh: roundTo(curSpd, 1),
        predicted_speed_kmh: predSpd,
        spi: sev.spi,
        density_k: densityK,
        flow_q: flowQ,
        congestion_level: rawLos,
        predicted_future_congestion: predLos,
        color: sev.color,
        is_live: Boolean(telem?.is_live),
        path: base.path,
        junctions: base.junctions.map((j) => ({
          ...j,
          level_of_service: rawLos,
          status: "Operational",
          signal_state: "Actuated",
        })),
      };
    });

    res.json({
      success: true,
      status: "success",
      corridors_count: corridorsOut.length,
      corridors: corridorsOut,
      timestamp: nowIso(),
    });
  });

  app.post("/api/map/route_lanes", async (req, res) => {
    const now = new Date();
    const dateVal = String(req.body?.departure_date || req.body?.date || now.toISOString().slice(0, 10));
    const timeVal = String(
      req.body?.departure_time ||
        req.body?.time ||
        `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
    );
    const evaluation = await liveBridge.evaluateLiveRouteAsync(
      String(req.body?.origin_road || "RD_BLR_01"),
      String(req.body?.destination_road || "RD_BLR_04"),
      dateVal,
      timeVal
    );
    res.json({
      success: true,
      status: "success",
      evaluation,
      primary_polylines: evaluation.primary_polylines,
      recommended_polylines: evaluation.recommended_polylines,
      primary_lane_guidance: evaluation.primary_lane_guidance,
      recommended_lane_guidance: evaluation.recommended_lane_guidance,
      timestamp: nowIso(),
    });
  });

  app.get("/api/config/providers", (_req, res) => {
    res.json({
      success: true,
      status: "success",
      timestamp: nowIso(),
      data: apiManager.getProviders(),
      providers: apiManager.getProvidersList(),
    });
  });
  app.get("/api/config/status", (_req, res) => {
    res.json({ success: true, status: "success", timestamp: nowIso(), data: apiManager.getStatus() });
  });
  app.get("/api/config/health", (_req, res) => {
    res.json({ success: true, status: "success", timestamp: nowIso(), data: apiManager.getHealthReport() });
  });
  app.post("/api/config/tomtom", requireAdmin, (req, res) => {
    const r = apiManager.updateTomTomKey(req.body?.api_key);
    res.json({ success: r.ok, status: r.ok ? "success" : "error", message: r.msg, data: r.data, timestamp: nowIso() });
  });
  app.post("/api/config/google_maps", requireAdmin, (req, res) => {
    const r = apiManager.updateGoogleMapsKey(req.body?.api_key);
    res.json({ success: r.ok, status: r.ok ? "success" : "error", message: r.msg, data: r.data, timestamp: nowIso() });
  });
  app.post("/api/config/weather", requireAdmin, (req, res) => {
    const r = apiManager.updateWeatherConfig(req.body?.base_url);
    res.status(r.ok ? 200 : 400).json({
      success: r.ok,
      status: r.ok ? "success" : "error",
      message: r.msg,
      data: r.data,
      timestamp: nowIso(),
    });
  });
  app.post("/api/config/test/tomtom", async (_req, res) => {
    const probe = await apiManager.probeTomTom();
    res.json({
      success: probe.ok,
      status: probe.ok ? "success" : "warning",
      configured: probe.configured,
      latency_ms: probe.latency_ms,
      http_status: probe.http_status,
      sample_speed_kmh: probe.sample_speed_kmh,
      message: probe.message,
      data: apiManager.getProviders().tomtom,
      timestamp: nowIso(),
    });
  });
  app.post("/api/config/test/google_maps", async (_req, res) => {
    const probe = await apiManager.probeGoogleMaps();
    res.json({
      success: probe.ok,
      status: probe.ok ? "success" : "warning",
      configured: probe.configured,
      latency_ms: probe.latency_ms,
      http_status: probe.http_status,
      message: probe.message,
      data: apiManager.getProviders().google_maps,
      timestamp: nowIso(),
    });
  });
  app.post("/api/config/test/weather", async (_req, res) => {
    const probe = await apiManager.probeWeather();
    if (probe.ok) {
      await liveBridge.refreshLiveWeather(true);
    }
    res.json({
      success: probe.ok,
      status: probe.ok ? "success" : "warning",
      latency_ms: probe.latency_ms,
      http_status: probe.http_status,
      message: probe.message,
      weather: probe.weather ?? null,
      data: apiManager.getProviders().weather,
      timestamp: nowIso(),
    });
  });

  // -------------------------------------------------------------------------
  // Computer Vision & Cameras Routes
  // -------------------------------------------------------------------------
  app.get("/api/vision/status", (_req, res) => {
    res.json(visionService.getStatus());
  });

  app.get("/api/vision/cameras", (req, res) => {
    const cid = typeof req.query.corridor_id === "string" ? req.query.corridor_id : null;
    const cameras = visionService.cameraRegistry.listCameras(cid);
    res.json({ success: true, status: "success", count: cameras.length, cameras, timestamp: nowIso() });
  });

  app.get("/api/vision/cameras/:cameraId", (req, res) => {
    const camId = String(req.params.cameraId);
    const cam = visionService.cameraRegistry.get(camId);
    if (!cam) {
      sendErr(res, `Camera '${camId}' not found.`, 404);
      return;
    }
    res.json({ success: true, status: "success", camera: cam, timestamp: nowIso() });
  });

  app.post("/api/vision/cameras", requireAdmin, (req, res) => {
    try {
      const cam = visionService.cameraRegistry.upsert(req.body || {});
      res.json({ success: true, status: "success", message: "Camera registered.", camera: cam, timestamp: nowIso() });
    } catch (err) {
      sendErr(res, err instanceof Error ? err.message : "Invalid camera payload.", 400);
    }
  });

  app.post("/api/vision/cameras/:cameraId/calibrate", requireAdmin, (req, res) => {
    try {
      const cam = visionService.cameraRegistry.calibrate(
        String(req.params.cameraId),
        req.body?.src_points || [],
        req.body?.dst_points_meters || []
      );
      res.json({ success: true, status: "success", message: "Camera calibrated.", camera: cam, timestamp: nowIso() });
    } catch (err) {
      sendErr(res, err instanceof Error ? err.message : "Calibration failed.", 400);
    }
  });

  app.post("/api/vision/upload/init", requireAuth, (req, res) => {
    const user = res.locals.authUser as SessionRecord;
    const result = visionService.initChunkedUpload(req.body || {}, user.username);
    res.status(result.code).json(result.body);
  });

  app.post("/api/vision/upload/chunk", requireAuth, (req, res) => {
    const uploadId = String(req.headers["x-upload-id"] || req.headers["upload-id"] || "");
    const chunkIdx = parseInt(String(req.headers["x-chunk-index"] || req.headers["chunk-index"] || ""), 10);
    if (!uploadId || Number.isNaN(chunkIdx)) {
      sendErr(res, "Missing X-Upload-ID or X-Chunk-Index header.", 400);
      return;
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
    const result = visionService.saveChunk(uploadId, chunkIdx, buf);
    res.status(result.code).json(result.body);
  });

  app.get("/api/vision/upload/status", requireAuth, (req, res) => {
    const uploadId = String(req.query.upload_id || "");
    const result = visionService.getUploadStatus(uploadId);
    res.status(result.code).json(result.body);
  });

  app.post(["/api/vision/upload/complete", "/api/vision/upload/finalize"], requireAuth, (req, res) => {
    const result = visionService.completeChunkedUpload(req.body || {});
    res.status(result.code).json(result.body);
  });

  app.post("/api/vision/upload", requireAuth, (req, res) => {
    const user = res.locals.authUser as SessionRecord;
    const filenameHeader = String(req.headers["x-filename"] || "uploaded_traffic.mp4");
    if (Buffer.isBuffer(req.body)) {
      const r = visionService.saveDirectUpload(req.body, filenameHeader, user.username);
      res.status(r.code).json(r.body);
      return;
    }
    if (req.body && typeof req.body === "object" && req.body.file_data) {
      const buf = Buffer.from(String(req.body.file_data), "base64");
      const r = visionService.saveDirectUpload(buf, String(req.body.filename || filenameHeader), user.username);
      res.status(r.code).json(r.body);
      return;
    }
    sendErr(res, "Empty video upload payload.", 400);
  });

  app.post("/api/vision/process", requireAuth, (req, res) => {
    const user = res.locals.authUser as SessionRecord;
    const result = visionService.processVideo(req.body || {}, user.username);
    res.status(result.code).json(result.body);
  });

  app.get("/api/vision/jobs/:jobId", (req, res) => {
    const result = visionService.getJob(req.params.jobId);
    res.status(result.code).json(result.body);
  });

  app.get("/api/vision/results/:jobId", (req, res) => {
    const result = visionService.getResults(req.params.jobId);
    res.status(result.code).json(result.body);
  });

  app.get("/api/vision/export/:jobId", (req, res) => {
    const fmt = String(req.query.format || "csv");
    const exp = visionService.exportTelemetry(req.params.jobId, fmt);
    if (exp.code !== 200) {
      sendErr(res, exp.body, exp.code);
      return;
    }
    res.setHeader("Content-Type", exp.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${exp.filename}"`);
    res.status(200).send(exp.body);
  });

  app.all("/api/vision/video/:jobId", (req, res) => {
    const filePath = visionService.getVideoFilePath(req.params.jobId);
    if (!filePath) {
      sendErr(res, "Video not found.", 404);
      return;
    }
    streamVideoWithRange(req, res, filePath, "video/mp4");
  });

  app.post("/api/vision/live/actuate", requireAuth, (req, res) => {
    const user = res.locals.authUser as SessionRecord;
    const body = req.body || {};
    const cid = normalizeCorridorId(String(body.corridor_id || body.road_id || "RD_BLR_01"));
    const roadId = ROAD_REGISTRY[cid] ? cid : "RD_BLR_01";
    const reg = ROAD_REGISTRY[roadId];
    const vm = (body.vision_metrics && typeof body.vision_metrics === "object"
      ? (body.vision_metrics as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    const pcuObj = (vm.pcu_telemetry as Record<string, unknown> | undefined) ?? {};
    const kinObj = (vm.kinematics as Record<string, unknown> | undefined) ?? {};
    const densObj = (vm.traffic_density as Record<string, unknown> | undefined) ?? {};

    const now = new Date();
    const estVol = Math.max(
      1000,
      Math.round(Number(pcuObj.hourly_flow_pcu_per_hr ?? Number(pcuObj.total_pcu ?? vm.total_unique_vehicles ?? 0) * 24) * 12)
    );
    const estSpd = Math.max(
      4,
      Math.min(75, Number(kinObj.space_mean_speed_kmh ?? kinObj.avg_speed_kmh ?? 22))
    );
    const [predCong, probs] = predictor.predictSegment({
      city_zone: reg?.city_zone ?? "Indiranagar",
      road_id: roadId,
      intersection_id: reg?.intersection_id ?? "INT_BLR_01",
      vehicle_count: estVol,
      average_speed: estSpd,
      capacity_utilization: Math.min(100, Math.round((estVol / 45000) * 100)),
      congestion_level: String(densObj.peak_density_level ?? densObj.level ?? classifySpeedLos(estSpd)),
      hour: (now.getHours() + 1) % 24,
      day_of_week: (now.getDay() + 6) % 7,
      is_weekend: now.getDay() === 0 || now.getDay() === 6 ? 1 : 0,
    });

    const result = visionService.actuateLiveGrid(body, user.username, {
      predicted_congestion: predCong,
      probabilities: probs,
    });
    res.status(result.code).json(result.body);
  });

  // -------------------------------------------------------------------------
  // Synthesizer Sandbox Endpoints
  // -------------------------------------------------------------------------
  app.get("/api/synthesizer/storage/status", (_req, res) => {
    const tableCounts = appDb.getTableCounts();
    res.json({
      success: true,
      status: "success",
      data: {
        database_path: appDb.dbPath,
        database_healthy: appDb.isHealthy(),
        models_dir: path.join(baseDir, "models", "xgboost"),
        corridors_count: Object.keys(predictor.topology).length,
        events_count: eventMgr.getEventCount(),
        users_count: security.getUserCount(),
        vision_jobs_count: visionService.getJobCount(),
        tables: tableCounts,
      },
      timestamp: nowIso(),
    });
  });

  app.post("/api/synthesizer/handshake", async (_req, res) => {
    const dbHealthy = appDb.isHealthy();
    const xgbOk = predictor.isTrained() && Object.keys(predictor.topology).length > 0;
    const ffmpegOk = await visionService.checkFfmpegAvailable();
    const yoloOk = visionService.isYolo11Ready();
    const weatherProbe = await apiManager.probeWeather();

    const subsystems = {
      sqlite_storage: dbHealthy ? "ONLINE" : "DEGRADED",
      xgboost_engine: xgbOk ? "ONLINE" : "OFFLINE",
      event_manager: dbHealthy ? "ONLINE" : "DEGRADED",
      heatmap_tri_pillar: xgbOk ? "ONLINE" : "OFFLINE",
      vision_pipeline: ffmpegOk && yoloOk ? "ONLINE (FFMPEG+YOLOV11S)" : "DEGRADED",
      live_weather_feed: weatherProbe.ok ? `ONLINE (${weatherProbe.latency_ms}ms)` : "FALLBACK",
    };

    const allCoreOk = dbHealthy && xgbOk;
    res.json({
      success: allCoreOk,
      status: allCoreOk ? "success" : "degraded",
      data: {
        status: allCoreOk ? "CONNECTED" : "DEGRADED",
        subsystems,
        timestamp: nowIso(),
      },
    });
  });

  app.post("/api/synthesizer/predict/sandbox", (req, res) => {
    const validation = validatePredictionFeatures(req.body?.features);
    if ("error" in validation) {
      sendErr(res, validation.error, 400);
      return;
    }
    const features = validation.features;
    const t0 = performance.now();
    const [predC, probDict] = predictor.predictSegment(features);
    const inferMs = roundTo(performance.now() - t0, 3);
    const probsSorted = Object.values(probDict).sort((a, b) => b - a);
    let entropy = 0;
    for (const p of probsSorted) {
      if (p > 0.0001) entropy -= p * Math.log2(p);
    }
    res.json({
      success: true,
      status: "success",
      prediction: {
        predicted_congestion: predC,
        probabilities: probDict,
        confidence_margin: roundTo(probsSorted[0] - (probsSorted[1] ?? 0), 3),
        shannon_entropy: roundTo(entropy, 3),
        inference_latency_ms: inferMs,
        input_features: features,
      },
      timestamp: nowIso(),
    });
  });

  // -------------------------------------------------------------------------
  // Static Files & MP4/WebM Range Streaming from public/
  // -------------------------------------------------------------------------
  app.all(/^\/([^/]+\.(mp4|webm))$/i, (req, res, next) => {
    const fileName = path.basename(req.path);
    const candidate = path.join(staticDir, fileName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const mime = fileName.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4";
      streamVideoWithRange(req, res, candidate, mime);
      return;
    }
    next();
  });

  app.use("/static", express.static(staticDir, { etag: true }));
  app.use(express.static(staticDir, { etag: true }));

  // 404 handler for unknown /api/* routes
  app.use("/api", (req, res) => {
    sendErr(res, `Endpoint '${req.originalUrl}' not found`, 404);
  });

  return app;
}

let cachedServerlessApp: ReturnType<typeof createApp> | null = null;

export function getApp() {
  if (!cachedServerlessApp) {
    cachedServerlessApp = createApp();
  }
  return cachedServerlessApp;
}

// Start server when executed directly
const isMain =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname) ||
    process.argv[1].endsWith("server.ts"));

if (isMain) {
  const PORT =
    Number(process.env.AI_STUDIO_PORT) ||
    (process.env.NODE_ENV === "production" ? Number(process.env.PORT) : 0) ||
    3000;
  const HOST = "0.0.0.0";
  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`=================================================================`);
    console.log(` Smart Traffic AI Server Live on http://${HOST}:${PORT}`);
    console.log(` Bengaluru Metropolitan Traffic Operations Portal Active`);
    console.log(`=================================================================`);
  });
}
