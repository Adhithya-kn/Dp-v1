import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "./database.ts";
import {
  BENGALURU_SECTOR_REGIONS,
  ROAD_REGISTRY,
  computeMfdDensity,
  getAllCorridors,
  matchPlacesToCorridors,
  normalizeCorridorId,
} from "./roadRegistry.ts";
import {
  calculateSpi,
  classifyTrafficSeverity,
  getLosColor,
  greenshieldsEquilibrium,
  optimizeIntersectionSignals,
} from "./physics.ts";
import { TrafficPredictor, validatePredictionFeatures } from "./predictor.ts";
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
  type CorridorTelemetryItem,
} from "./services.ts";
import { VisionService, projectPoint, solveHomography } from "./visionService.ts";
import {
  applyNms,
  filterTwoWheelerRiders,
  trackAndAnalyzeFrames,
  type FrameDetectionsInput,
} from "./cvTracker.ts";

test("roadRegistry has 24 Bengaluru corridors, normalizes IDs, and matches places", () => {
  const all = getAllCorridors();
  assert.equal(Object.keys(ROAD_REGISTRY).length, 24);
  assert.equal(all.length, 24);
  assert.equal(normalizeCorridorId("BLR-COR-01"), "RD_BLR_01");
  assert.equal(normalizeCorridorId("rd_blr_11", true), "BLR-COR-11");

  const silkMatches = matchPlacesToCorridors("Silk Board", 3);
  assert.ok(silkMatches.length > 0);
  assert.equal(silkMatches[0].road_id, "RD_BLR_11");

  assert.equal(computeMfdDensity(1000, 0), 150);
  assert.equal(computeMfdDensity(-50, 40), 0);
  assert.equal(computeMfdDensity(1000, 40), 25);
});

test("physics enforces SPI, Greenshields equilibrium, and Webster signal bounds", () => {
  assert.equal(calculateSpi(30, 60), 50);
  const [spdLow, losLow] = greenshieldsEquilibrium(10000, 50000, 60);
  const [spdHigh, losHigh] = greenshieldsEquilibrium(47000, 50000, 60);
  assert.ok(spdLow > spdHigh);
  assert.equal(losLow, "Low");
  assert.equal(losHigh, "Severe");

  const sig = optimizeIntersectionSignals(1600, 900, 2, 2, 0);
  assert.ok(sig.optimal_cycle_sec >= 45 && sig.optimal_cycle_sec <= 150);
  assert.ok(sig.ns_green_sec >= 10 && sig.ew_green_sec >= 10);
});

test("TrafficPredictor loads XGBoost trees, validates inputs, and computes real Saabas feature attribution", () => {
  const predictor = new TrafficPredictor();
  assert.equal(predictor.isTrained(), true);
  assert.equal(Object.keys(predictor.topology).length, 24);

  // Strict input validation
  assert.equal(validatePredictionFeatures(null).ok, false);
  assert.equal(validatePredictionFeatures({}).ok, false);
  assert.equal(validatePredictionFeatures({ average_speed: 999 }).ok, false);
  assert.equal(validatePredictionFeatures({ hour: 25 }).ok, false);
  assert.equal(validatePredictionFeatures({ vehicle_count: 15000, average_speed: 35 }).ok, true);

  const freeFeatures = {
    vehicle_count: 8500,
    average_speed: 52,
    capacity_utilization: 20,
    congestion_level: "Low",
    hour: 3,
    day_of_week: 6,
    is_weekend: 1,
  };
  const peakFeatures = {
    vehicle_count: 51000,
    average_speed: 14,
    capacity_utilization: 96,
    congestion_level: "Severe",
    hour: 18,
    day_of_week: 2,
    is_weekend: 0,
  };

  const [freeClass, freeProbs] = predictor.predictSegment(freeFeatures);
  const freeSum = Object.values(freeProbs).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(freeSum - 1.0) < 0.01);
  assert.equal(freeClass, "Low");

  const [peakClass, peakProbs] = predictor.predictSegment(peakFeatures);
  const peakSum = Object.values(peakProbs).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(peakSum - 1.0) < 0.01);
  assert.ok(peakClass === "Severe" || peakClass === "High");

  // Real Saabas attribution differs by input and normalizes to ~1.0
  const expFree = predictor.explainPrediction(freeFeatures);
  const expPeak = predictor.explainPrediction(peakFeatures);
  const freeImpSum = expFree.feature_contributions.reduce((acc, d) => acc + d.importance, 0);
  const peakImpSum = expPeak.feature_contributions.reduce((acc, d) => acc + d.importance, 0);
  assert.ok(Math.abs(freeImpSum - 1.0) < 0.02, `Expected free attribution sum ~1, got ${freeImpSum}`);
  assert.ok(Math.abs(peakImpSum - 1.0) < 0.02, `Expected peak attribution sum ~1, got ${peakImpSum}`);
  const freeSignature = expFree.feature_contributions.map((d) => `${d.feature}:${d.importance}`).join(",");
  const peakSignature = expPeak.feature_contributions.map((d) => `${d.feature}:${d.importance}`).join(",");
  assert.notEqual(freeSignature, peakSignature, "Saabas explanations must vary dynamically with inputs");
});

test("SQLite persistence survives restarts for users, sessions, events, cameras, and measurements", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-traffic-db-"));
  const dbPath = path.join(tmpDir, "test_smart_traffic.db");

  try {
    // First boot
    const db1 = new AppDatabase({ dbPath });
    const sec1 = new SecurityManager(process.cwd(), db1);
    const evt1 = new EventManager(process.cwd(), db1);
    const pred1 = new TrafficPredictor();
    const nav1 = new RouteNavigator(pred1, evt1);
    const api1 = new ApiManager(db1);
    const bridge1 = new LiveTrafficDataBridge(pred1, api1, nav1, db1);

    const loginRes = sec1.login("traffic_admin", "Admin@123");
    assert.equal(loginRes.ok, true);
    assert.equal(loginRes.session?.role, "Traffic Management");
    const token = loginRes.session!.token;

    const badLogin = sec1.login("traffic_admin", "WrongPassword!");
    assert.equal(badLogin.ok, false);
    assert.equal(badLogin.session, null);

    const addEvt = evt1.addEvent({
      name: "Persisted Metro Girder Lift",
      city_zone: "Indiranagar",
      affected_roads: ["RD_BLR_01"],
      date: "2026-11-30",
      start_time: "08:00",
      end_time: "12:00",
      is_published: true,
    });
    assert.equal(addEvt.ok, true);
    const createdEventId = addEvt.event!.id;

    bridge1.injectTrafficMeasurement({
      corridor_id: "RD_BLR_11",
      current_speed: 11.5,
      vehicle_count: 42000,
    });
    db1.close();

    // Second boot (simulate server restart)
    const db2 = new AppDatabase({ dbPath });
    const sec2 = new SecurityManager(process.cwd(), db2);
    const evt2 = new EventManager(process.cwd(), db2);
    const pred2 = new TrafficPredictor();
    const nav2 = new RouteNavigator(pred2, evt2);
    const api2 = new ApiManager(db2);
    const bridge2 = new LiveTrafficDataBridge(pred2, api2, nav2, db2);

    // Session persists across restart
    const restoredUser = sec2.getUserByToken(token);
    assert.equal(restoredUser?.username, "traffic_admin");

    // Logout invalidates session in SQLite
    assert.equal(sec2.logout(token), true);
    assert.equal(sec2.getUserByToken(token), null);

    // Event persists across restart
    const allEvts = evt2.getAllEvents();
    assert.ok(allEvts.some((e) => e.id === createdEventId));

    // Ingested traffic measurement persists across restart
    const state = bridge2.getCorridorState("RD_BLR_11");
    assert.equal(state?.current_speed, 11.5);
    assert.equal(state?.vehicle_count, 42000);
    db2.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("solveHomography computes exact 4-point perspective mapping and rejects collinear points", () => {
  const src: Array<[number, number]> = [
    [220, 480],
    [1060, 480],
    [1220, 710],
    [60, 710],
  ];
  const dst: Array<[number, number]> = [
    [0, 36],
    [14, 36],
    [14, 0],
    [0, 0],
  ];

  const solved = solveHomography(src, dst);
  assert.equal(solved.matrix.length, 3);
  assert.ok(solved.pixels_per_meter > 5 && solved.pixels_per_meter < 200);

  for (let i = 0; i < 4; i++) {
    const [mx, my] = projectPoint(solved.matrix, src[i]);
    assert.ok(Math.abs(mx - dst[i][0]) < 1e-4, `X error too large at corner ${i}: ${mx} vs ${dst[i][0]}`);
    assert.ok(Math.abs(my - dst[i][1]) < 1e-4, `Y error too large at corner ${i}: ${my} vs ${dst[i][1]}`);
  }

  assert.throws(() => {
    solveHomography(
      [
        [0, 0],
        [10, 10],
        [20, 20],
        [30, 30],
      ],
      dst
    );
  });
});

test("RouteNavigator, PolicySimulator, and HeatmapService produce consistent Bengaluru outputs", () => {
  const db = new AppDatabase({ dbPath: ":memory:" });
  const predictor = new TrafficPredictor();
  const eventMgr = new EventManager(process.cwd(), db);
  const nav = new RouteNavigator(predictor, eventMgr);
  const sim = new PolicySimulator(predictor);
  const junc = new JunctionService(predictor, eventMgr);
  const heat = new HeatmapService(predictor, junc, eventMgr);

  const route = nav.evaluateRoute("RD_BLR_01", "RD_BLR_11", "2026-11-04", "18:00");
  assert.ok(route.primary_route.length >= 2);
  assert.ok(route.primary_polylines.length > 0);
  assert.ok(route.primary_travel_time_minutes > 0);

  const simRes = sim.simulateZonePolicy(null, 0.25, 0.15, 18, 2);
  assert.equal(simRes.total_segments_evaluated, 24);
  assert.equal(simRes.summary.worsened_segments, 0);
  assert.ok(simRes.summary.improved_segments > 0);

  const tri = heat.getTriPillarHeatmap(30, "all");
  assert.equal(Array.isArray(tri.traffic_layer) ? tri.traffic_layer.length : 0, 24);
  assert.equal(Array.isArray(tri.crowd_layer) ? tri.crowd_layer.length : 0, 6);
  assert.equal(Array.isArray(tri.junction_layer) ? tri.junction_layer.length : 0, 24);
  db.close();
});

test("cvTracker deduplicates overlapping boxes, filters motorcycle riders, tracks persistent IDs, and detects stopped vehicles", () => {
  // 1. NMS suppresses duplicate overlapping vehicle box
  const nmsOut = applyNms([
    { class_name: "car", confidence: 0.91, box_2d: [400, 200, 580, 420] },
    { class_name: "car", confidence: 0.65, box_2d: [405, 205, 578, 418] },
    { class_name: "bus", confidence: 0.88, box_2d: [300, 600, 650, 900] },
  ]);
  assert.equal(nmsOut.length, 2);

  // 2. Rider sitting on a motorcycle is NOT double-counted as a standalone pedestrian
  const filtered = filterTwoWheelerRiders([
    { class_name: "motorcycle", confidence: 0.85, box_2d: [500, 300, 680, 410] },
    { class_name: "pedestrian", confidence: 0.80, box_2d: [440, 315, 650, 395] }, // rider on bike
    { class_name: "pedestrian", confidence: 0.78, box_2d: [450, 820, 680, 880] }, // roadside pedestrian
  ]);
  assert.equal(filtered.filter((d) => d.class_name === "motorcycle").length, 1);
  assert.equal(filtered.filter((d) => d.class_name === "pedestrian").length, 1);

  // 3. Multi-frame IoU tracking assigns persistent track_id, computes direction split & stopped vehicle alert
  const frames: FrameDetectionsInput[] = [0, 1, 2, 3, 4, 5].map((i) => ({
    frame_index: i,
    timestamp_sec: i * 1.2,
    detections: [
      // Moving inbound car (downward across Gate A=380 -> Gate B=800)
      { class_name: "car", confidence: 0.92, box_2d: [250 + i * 105, 220, 370 + i * 105, 360] },
      // Stationary stalled LCV in middle lane for 6.0s
      { class_name: "lcv", confidence: 0.87, box_2d: [520, 560, 670, 720] },
    ],
  }));

  const res = trackAndAnalyzeFrames(frames, {
    width: 1280,
    height: 720,
    fps: 30,
    duration_seconds: 6.0,
    total_frames: 180,
  });

  assert.equal(res.unique_class_counts.car, 1);
  assert.equal(res.unique_class_counts.lcv, 1);
  assert.equal(res.overall_unique_vehicles, 2);
  assert.equal(res.gate_transitions_count, 1);
  assert.ok(res.frames.every((f) => f.detections.every((d) => typeof d.track_id === "number")));
  const allIncidents = res.frames.flatMap((f) => f.incidents);
  assert.ok(allIncidents.some((inc) => inc.type === "INCIDENT_STOPPED_VEHICLE"));
});

test("VisionService runs real local FFprobe + FFmpeg + Ultralytics YOLOv11s ONNX pipeline and exact Indo-HCM PCU reconciliation", async () => {
  const { execFileSync } = await import("node:child_process");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-traffic-cv-test-"));
  const clipPath = path.join(tmpDir, "tiny_clip.mp4");
  try {
    // Generate a real 2-second MP4 via FFmpeg (no static dummy sample files)
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=2:size=320x240:rate=10",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        clipPath,
      ],
      { timeout: 15_000 }
    );
    const clipBuf = fs.readFileSync(clipPath);

    // 1. Real Ultralytics YOLOv11s ONNX inference runs end-to-end with zero external API keys
    const dbReal = new AppDatabase({ dbPath: ":memory:" });
    const visionReal = new VisionService(process.cwd(), dbReal);
    assert.equal(visionReal.isYolo11Ready(), true, "models/yolo11/yolo11s.onnx must be present");
    const statusReal = visionReal.getStatus();
    assert.equal(statusReal.data.yolo_loaded, true);
    assert.equal(statusReal.data.yolo_model, "yolo11s.onnx");

    const upReal = visionReal.saveDirectUpload(clipBuf, "tiny_clip.mp4", "traffic_admin");
    assert.equal(upReal.code, 200);
    const realVidId = (upReal.body.data as { video_id: string }).video_id;
    const procReal = visionReal.processVideo({ video_id: realVidId, filename: "tiny_clip.mp4" }, "traffic_admin");
    assert.equal(procReal.code, 200);
    const realJob = await visionReal.waitForJob((procReal.body.data as { job_id: string }).job_id, 30_000);
    assert.equal(realJob?.status, "COMPLETED", `YOLOv11s real job failed: ${realJob?.error_message}`);
    assert.equal((realJob?.results as { processing_provenance?: string })?.processing_provenance, "YOLOV11_ONNX_LOCAL");
    // Cleanup uploaded test clip in workspace uploads dir
    if (realJob?.output_video_path && fs.existsSync(realJob.output_video_path)) {
      fs.rmSync(realJob.output_video_path, { force: true });
    }
    dbReal.close();

    // 2. Deterministic Indo-HCM PCU reconciliation, CSV/JSON export & Webster actuation
    const db = new AppDatabase({ dbPath: ":memory:" });
    const vision = new VisionService(tmpDir, db, {
      frameAnalyzer: async (frames, meta) => {
        assert.ok(frames.length >= 2, "FFmpeg should extract at least 2 keyframes");
        assert.equal(meta.width, 320);
        assert.equal(meta.height, 240);
        return {
          frames: frames.map((f, idx) => ({
            frame_index: idx,
            timestamp_sec: f.timestamp_sec,
            car: 4,
            motorcycle: 6,
            auto_rickshaw: 3,
            bus: 1,
            lcv: 1,
            truck: 1,
            bicycle: 1,
            pedestrian: 2,
            estimated_speed_kmh: 14.5,
            lane_occupancy_pct: 68.0,
            mean_confidence: 0.91,
            incidents: [],
            detections: [
              { track_id: 1, class_name: "car", confidence: 0.94, box_2d: [400, 120, 620, 340] },
              { track_id: 2, class_name: "truck", confidence: 0.92, box_2d: [310, 520, 640, 820] },
            ],
          })),
          unique_class_counts: {
            car: 8,
            motorcycle: 12,
            auto_rickshaw: 5,
            bus: 1,
            lcv: 2,
            truck: 1,
            bicycle: 1,
            pedestrian: 4,
          },
          overall_unique_vehicles: 30,
          inbound_count: 21,
          outbound_count: 9,
          dominant_flow_direction: "Inbound Dominant",
          scene_summary: "YOLOv11s tracked 30 unique vehicles across arterial corridor.",
          model_used: "Ultralytics YOLO11S (ONNX)",
          gate_transitions_count: 14,
          median_gate_transit_sec: 4.8,
        };
      },
    });

    const upload = vision.saveDirectUpload(clipBuf, "tiny_clip.mp4", "traffic_admin");
    assert.equal(upload.code, 200);
    const vidId = (upload.body.data as { video_id: string }).video_id;

    const proc = vision.processVideo({ video_id: vidId, filename: "tiny_clip.mp4" }, "traffic_admin");
    assert.equal(proc.code, 200);
    const jobId = (proc.body.data as { job_id: string }).job_id;

    const finished = await vision.waitForJob(jobId, 20_000);
    assert.ok(finished, "Vision job did not finish");
    assert.equal(finished.status, "COMPLETED", `Expected COMPLETED, got ${finished.status}: ${finished.error_message}`);
    assert.equal(finished.width, 320);
    assert.equal(finished.height, 240);

    const results = vision.getResults(jobId);
    assert.equal(results.code, 200);
    const data = results.body.data as Record<string, unknown>;
    assert.equal(data.processing_provenance, "YOLOV11_ONNX_LOCAL");
    assert.equal(data.total_unique_vehicles, 30);
    assert.equal((data.direction_counts as { inbound: number; outbound: number }).inbound, 21);
    assert.equal((data.direction_counts as { inbound: number; outbound: number }).outbound, 9);
    // Exact Indo-HCM PCU: 8*1.0 + 12*0.5 + 5*1.2 + 1*3.0 + 2*1.5 + 1*3.0 + 1*0.4 = 29.4
    assert.equal((data.pcu_telemetry as { total_pcu: number }).total_pcu, 29.4);
    assert.equal((data.route_flow as { transitions_count: number }).transitions_count, 14);
    assert.ok(Array.isArray(data.frame_detections) && (data.frame_detections as unknown[]).length >= 2);

    const csvExp = vision.exportTelemetry(jobId, "csv");
    assert.equal(csvExp.code, 200);
    assert.ok(csvExp.body.startsWith("passage_id,track_id"));

    const actRes = vision.actuateLiveGrid(
      { corridor_id: "RD_BLR_11", vision_metrics: data },
      "traffic_admin"
    );
    assert.equal(actRes.code, 200);
    const actData = actRes.body.data as {
      corridor_id: string;
      webster_signal_actuation: { optimal_cycle_sec: number; ns_green_sec: number };
    };
    assert.equal(actData.corridor_id, "RD_BLR_11");
    assert.ok(actData.webster_signal_actuation.optimal_cycle_sec >= 45);
    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("corridor directives compute distinct corridor-specific Webster timings and live status exposes weather", () => {
  const all = getAllCorridors();
  for (const cor of all) {
    assert.ok(Array.isArray(cor.path) && cor.path.length >= 2);
    for (const pt of cor.path) {
      assert.ok(Array.isArray(pt) && pt.length === 2);
      assert.ok(Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
    }
  }

  const db = new AppDatabase({ dbPath: ":memory:" });
  const predictor = new TrafficPredictor();
  const eventMgr = new EventManager(process.cwd(), db);
  const nav = new RouteNavigator(predictor, eventMgr);
  const apiMgr = new ApiManager(db);
  const bridge = new LiveTrafficDataBridge(predictor, apiMgr, nav, db);
  const status = bridge.getLiveStatus();
  assert.ok(status.provider && status.provider !== "--");
  assert.ok(status.status_code && status.status_code !== "unknown");
  assert.ok(status.last_sync && status.last_sync.includes("IST"));
  assert.equal(typeof status.weather.temperature, "number");

  const dirHeavy = generateActionDirective("RD_BLR_11", "Electronic City South", "Severe", true, "Metro Work", 46000, 8);
  const dirLight = generateActionDirective("RD_BLR_18", "M.G. Road CBD", "Severe", false, "", 16000, 4);
  assert.equal(dirHeavy.directive_code, "DIR-SEV-01");
  assert.equal(dirHeavy.priority_level, "URGENT_PRIORITY_1");
  assert.ok(dirHeavy.operational_action.includes("PRIORITY DISPATCH"));
  assert.ok(dirHeavy.vms_broadcast_message.includes("ALERT"));
  assert.notEqual(
    dirHeavy.signal_actuation_parameters.directional_hourly_pcu,
    dirLight.signal_actuation_parameters.directional_hourly_pcu,
    "Corridor directives must reflect actual corridor volume rather than a single constant"
  );
  db.close();
});

test("classifyTrafficSeverity maps free flow to green and bottlenecks to red across 8 Bengaluru regions", () => {
  assert.equal(BENGALURU_SECTOR_REGIONS.length, 8);
  for (const reg of BENGALURU_SECTOR_REGIONS) {
    assert.ok(reg.polygon.length >= 4, `Region ${reg.region_id} must have a valid polygon`);
    assert.ok(Number.isFinite(reg.center.lat) && Number.isFinite(reg.center.lng));
  }

  const low = classifyTrafficSeverity(48, 55);
  assert.equal(low.los, "Low");
  assert.equal(low.color, "#10b981");
  assert.equal(getLosColor("Low"), "#10b981");

  // Urban street moving at full free-flow speed (26/26 km/h => SPI 100%) must still be Low (Green)
  const urbanFreeFlow = classifyTrafficSeverity(26, 26);
  assert.equal(urbanFreeFlow.los, "Low");
  assert.equal(urbanFreeFlow.color, "#10b981");

  const mod = classifyTrafficSeverity(39, 55);
  assert.equal(mod.los, "Moderate");
  assert.equal(mod.color, "#f59e0b");

  const high = classifyTrafficSeverity(30, 55);
  assert.equal(high.los, "High");
  assert.equal(high.color, "#f97316");

  const sev = classifyTrafficSeverity(10, 55);
  assert.equal(sev.los, "Severe");
  assert.equal(sev.color, "#ef4444");
  assert.ok(sev.weight > high.weight && high.weight > mod.weight && mod.weight > low.weight);

  const db = new AppDatabase({ dbPath: ":memory:" });
  const predictor = new TrafficPredictor();
  const eventMgr = new EventManager(process.cwd(), db);
  const junc = new JunctionService(predictor, eventMgr);
  const heat = new HeatmapService(predictor, junc, eventMgr);

  const nowIso = new Date().toISOString();
  const allCorridors = getAllCorridors();
  const syntheticLive: CorridorTelemetryItem[] = allCorridors.map((cor) => {
    const isJammedZone = cor.city_zone === "Electronic City South";
    const isClearZone = cor.city_zone === "Hebbal North";
    const speed = isJammedZone ? 9 : isClearZone ? 52 : 39;
    const sevInfo = classifyTrafficSeverity(speed, 55);
    const pt = cor.coordinates[0] ?? [12.9716, 77.5946];
    return {
      road_id: cor.road_id,
      road_name: cor.name,
      city_zone: cor.city_zone,
      intersection_name: cor.intersection_name,
      lat: pt[0],
      lon: pt[1],
      current_speed: speed,
      free_flow_speed: 55,
      spi: sevInfo.spi,
      congestion_level: sevInfo.los,
      predicted_future_congestion: sevInfo.los,
      prediction_probabilities: { Low: 0.25, Moderate: 0.25, High: 0.25, Severe: 0.25 },
      vehicle_count: isJammedZone ? 46000 : isClearZone ? 11000 : 25000,
      capacity_utilization: isJammedZone ? 92 : isClearZone ? 22 : 55,
      confidence: 0.95,
      is_road_closed: false,
      is_live: true,
      is_cached: false,
      is_stale: false,
      is_historical_fallback: false,
      has_valid_live_observation: true,
      provenance: "Test Live Telemetry",
      source: "Test Live Telemetry",
      observation_time: nowIso,
      retrieval_time: nowIso,
      weather_condition: "Clear",
      temperature_c: 26,
      precipitation_mm: 0,
      lanes: cor.lanes,
      coordinates: cor.coordinates,
    };
  });

  const tri = heat.getTriPillarHeatmap(0, "all", syntheticLive);
  const regionLayer = tri.region_layer as Array<{
    region_id: string;
    city_zone: string;
    congestion_level: string;
    color: string;
    avg_speed_kmh: number;
  }>;
  const junctionLayer = tri.junction_layer as Array<{
    city_zone: string;
    predicted_los: string;
    is_jam_hotspot: boolean;
    alert_level: string;
  }>;
  const summary = tri.summary as {
    low_count: number;
    moderate_count: number;
    high_count: number;
    severe_count: number;
    total_corridors: number;
    live_corridor_count: number;
  };

  assert.equal(regionLayer.length, 8);
  const ecityRegion = regionLayer.find((r) => r.city_zone === "Electronic City South");
  const hebbalRegion = regionLayer.find((r) => r.city_zone === "Hebbal North");
  assert.ok(ecityRegion && hebbalRegion);
  assert.equal(ecityRegion.congestion_level, "Severe");
  assert.equal(ecityRegion.color, "#ef4444");
  assert.equal(hebbalRegion.congestion_level, "Low");
  assert.equal(hebbalRegion.color, "#10b981");

  assert.equal(summary.total_corridors, 24);
  assert.equal(summary.live_corridor_count, 24);
  assert.ok(summary.severe_count > 0 && summary.low_count > 0);

  for (const j of junctionLayer) {
    if (j.predicted_los === "Severe") {
      assert.equal(j.is_jam_hotspot, true);
      assert.equal(j.alert_level, "JAM_ALERT");
    } else {
      assert.equal(j.is_jam_hotspot, false);
      assert.notEqual(j.alert_level, "JAM_ALERT");
    }
  }
  db.close();
});

