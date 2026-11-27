import { roundTo } from "./physics.ts";

export type RoadUserClass =
  | "car"
  | "motorcycle"
  | "auto_rickshaw"
  | "bus"
  | "lcv"
  | "truck"
  | "bicycle"
  | "pedestrian";

export interface DetectionBox {
  track_id?: number;
  class_name: RoadUserClass;
  confidence: number;
  box_2d: [number, number, number, number]; // [ymin, xmin, ymax, xmax] normalized 0..1000
}

export interface FrameDetectionsInput {
  frame_index: number;
  timestamp_sec: number;
  detections: DetectionBox[];
}

export interface TrackedFrameOutput {
  frame_index: number;
  timestamp_sec: number;
  car: number;
  motorcycle: number;
  auto_rickshaw: number;
  bus: number;
  lcv: number;
  truck: number;
  bicycle: number;
  pedestrian: number;
  estimated_speed_kmh: number;
  lane_occupancy_pct: number;
  mean_confidence: number;
  incidents: Array<{ type: string; severity: string; message: string }>;
  detections: DetectionBox[];
}

export interface UniqueClassCounts {
  car: number;
  motorcycle: number;
  auto_rickshaw: number;
  bus: number;
  lcv: number;
  truck: number;
  bicycle: number;
  pedestrian: number;
}

export interface TrackSummary {
  track_id: number;
  class_name: RoadUserClass;
  first_seen_sec: number;
  last_seen_sec: number;
  first_frame_idx: number;
  hits: number;
  speed_kmh: number;
  direction: "Inbound" | "Outbound";
  crossed_gate_a: boolean;
  crossed_gate_b: boolean;
  transit_duration_sec: number | null;
  mean_confidence: number;
}

export interface TrackerAnalysisResult {
  frames: TrackedFrameOutput[];
  tracks: TrackSummary[];
  unique_class_counts: UniqueClassCounts;
  overall_unique_vehicles: number;
  inbound_count: number;
  outbound_count: number;
  dominant_flow_direction: string;
  scene_summary: string;
  model_used: string;
  gate_transitions_count: number;
  median_gate_transit_sec: number | null;
}

const VEHICLE_CLASSES: ReadonlySet<RoadUserClass> = new Set([
  "car",
  "motorcycle",
  "auto_rickshaw",
  "bus",
  "lcv",
  "truck",
  "bicycle",
]);

const FOUR_WHEELER_FAMILY: ReadonlySet<RoadUserClass> = new Set([
  "car",
  "auto_rickshaw",
  "lcv",
  "truck",
  "bus",
]);

const TWO_WHEELER_FAMILY: ReadonlySet<RoadUserClass> = new Set([
  "motorcycle",
  "bicycle",
]);

// Typical Indian urban vehicle lengths (meters) for perspective speed scaling
const REF_LENGTH_METERS: Record<RoadUserClass, number> = {
  car: 4.3,
  motorcycle: 2.0,
  auto_rickshaw: 2.7,
  bus: 10.5,
  lcv: 5.0,
  truck: 7.5,
  bicycle: 1.8,
  pedestrian: 0.7,
};

export function computeBoxIou(
  a: [number, number, number, number],
  b: [number, number, number, number]
): number {
  const y1 = Math.max(a[0], b[0]);
  const x1 = Math.max(a[1], b[1]);
  const y2 = Math.min(a[2], b[2]);
  const x2 = Math.min(a[3], b[3]);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const interArea = interW * interH;
  if (interArea <= 0) return 0;
  const areaA = Math.max(1, (a[2] - a[0]) * (a[3] - a[1]));
  const areaB = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
  return interArea / (areaA + areaB - interArea);
}

function classesCompatible(a: RoadUserClass, b: RoadUserClass): boolean {
  if (a === b) return true;
  if (FOUR_WHEELER_FAMILY.has(a) && FOUR_WHEELER_FAMILY.has(b)) return true;
  if (TWO_WHEELER_FAMILY.has(a) && TWO_WHEELER_FAMILY.has(b)) return true;
  return false;
}

/**
 * Class-aware Non-Maximum Suppression (removes duplicate overlapping boxes
 * for the same physical vehicle).
 */
export function applyNms(detections: DetectionBox[], iouThreshold = 0.52): DetectionBox[] {
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  const kept: DetectionBox[] = [];
  for (const det of sorted) {
    let suppressed = false;
    for (const prev of kept) {
      if (classesCompatible(det.class_name, prev.class_name)) {
        const iou = computeBoxIou(det.box_2d, prev.box_2d);
        if (iou >= iouThreshold) {
          suppressed = true;
          break;
        }
      }
    }
    if (!suppressed) kept.push(det);
  }
  return kept;
}

/**
 * Separates riders sitting on motorcycles/bicycles from roadside pedestrians
 * so two-wheeler riders are not double-counted as pedestrians.
 */
export function filterTwoWheelerRiders(detections: DetectionBox[]): DetectionBox[] {
  const twoWheelers = detections.filter(
    (d) => d.class_name === "motorcycle" || d.class_name === "bicycle"
  );
  if (twoWheelers.length === 0) return detections;

  return detections.filter((det) => {
    if (det.class_name !== "pedestrian") return true;
    const [py1, px1, py2, px2] = det.box_2d;
    const pw = Math.max(1, px2 - px1);
    const pcx = (px1 + px2) / 2;

    for (const tw of twoWheelers) {
      const [ty1, tx1, ty2, tx2] = tw.box_2d;
      const twW = Math.max(1, tx2 - tx1);
      const overlapX = Math.max(0, Math.min(px2, tx2) - Math.max(px1, tx1));
      const horizRatio = overlapX / Math.min(pw, twW);
      const centerInsideX = pcx >= tx1 - twW * 0.15 && pcx <= tx2 + twW * 0.15;
      // Rider typically sits slightly above / overlapping the motorcycle/bicycle vertical span
      const verticalOverlap = py2 >= ty1 - 35 && py1 <= ty2 + 10 && py2 <= ty2 + 65;
      if ((horizRatio >= 0.42 || centerInsideX) && verticalOverlap) {
        return false; // Rider on two-wheeler, not a standalone pedestrian
      }
    }
    return true;
  });
}

/**
 * Computes carriageway lane occupancy (%) via exact 50x35 union grid
 * over vehicle bounding boxes in the active roadway region (y in 280..1000).
 */
export function computeFrameOccupancyPct(detections: DetectionBox[]): number {
  const cols = 50;
  const rows = 35;
  const roiMinY = 280;
  const roiSpanY = 1000 - roiMinY;
  const vehicles = detections.filter((d) => VEHICLE_CLASSES.has(d.class_name));
  if (vehicles.length === 0) return 0;

  let occupied = 0;
  for (let r = 0; r < rows; r++) {
    const cy = roiMinY + ((r + 0.5) / rows) * roiSpanY;
    for (let c = 0; c < cols; c++) {
      const cx = ((c + 0.5) / cols) * 1000;
      for (const v of vehicles) {
        const [y1, x1, y2, x2] = v.box_2d;
        if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) {
          occupied++;
          break;
        }
      }
    }
  }
  return roundTo(Math.min(100, (occupied / (cols * rows)) * 100), 1);
}

interface ActiveTrack {
  track_id: number;
  class_votes: Record<RoadUserClass, number>;
  last_box: [number, number, number, number];
  first_cx: number;
  first_cy: number;
  last_cx: number;
  last_cy: number;
  vx: number;
  vy: number;
  first_seen_sec: number;
  last_seen_sec: number;
  first_frame_idx: number;
  last_frame_idx: number;
  hits: number;
  misses: number;
  total_displacement: number;
  diag_sum: number;
  conf_sum: number;
  max_confidence: number;
  crossed_gate_a: boolean;
  crossed_gate_b: boolean;
  gate_a_sec: number | null;
  gate_b_sec: number | null;
}

function emptyVotes(): Record<RoadUserClass, number> {
  return {
    car: 0,
    motorcycle: 0,
    auto_rickshaw: 0,
    bus: 0,
    lcv: 0,
    truck: 0,
    bicycle: 0,
    pedestrian: 0,
  };
}

function dominantClass(votes: Record<RoadUserClass, number>): RoadUserClass {
  let best: RoadUserClass = "car";
  let bestScore = -1;
  for (const [cls, score] of Object.entries(votes) as Array<[RoadUserClass, number]>) {
    if (score > bestScore) {
      bestScore = score;
      best = cls;
    }
  }
  return best;
}

function boxCenterAndSize(box: [number, number, number, number]) {
  const [y1, x1, y2, x2] = box;
  const w = Math.max(1, x2 - x1);
  const h = Math.max(1, y2 - y1);
  return { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, w, h, diag: Math.hypot(w, h) };
}

export function trackAndAnalyzeFrames(
  rawFrames: FrameDetectionsInput[],
  meta: { width: number; height: number; fps: number; duration_seconds: number; total_frames: number },
  options?: {
    model_used?: string;
    pixels_per_meter?: number;
    is_calibrated?: boolean;
  }
): TrackerAnalysisResult {
  const modelUsed = options?.model_used || "Ultralytics YOLOv11s (ONNX)";
  const GATE_A_Y = 380; // 38% frame height
  const GATE_B_Y = 800; // 80% frame height
  const maxMissedFrames = 2;

  let nextTrackId = 1;
  const activeTracks: ActiveTrack[] = [];
  const finishedTracks: ActiveTrack[] = [];

  const cleanedFrames = rawFrames.map((f) => ({
    frame_index: f.frame_index,
    timestamp_sec: f.timestamp_sec,
    detections: filterTwoWheelerRiders(applyNms(f.detections, 0.52)),
  }));

  const frameOutputs: TrackedFrameOutput[] = [];
  const frameTrackSpeeds: number[][] = cleanedFrames.map(() => []);

  for (let fi = 0; fi < cleanedFrames.length; fi++) {
    const fr = cleanedFrames[fi];
    const dets = fr.detections;
    const dtPrev =
      fi > 0 ? Math.max(0.1, fr.timestamp_sec - cleanedFrames[fi - 1].timestamp_sec) : 1.0;

    // 1. Score all compatible (track, detection) pairs using IoU + motion-predicted centroid distance
    const candidates: Array<{ ti: number; di: number; score: number }> = [];
    for (let ti = 0; ti < activeTracks.length; ti++) {
      const tr = activeTracks[ti];
      const trCls = dominantClass(tr.class_votes);
      const predDx = tr.vx * dtPrev;
      const predDy = tr.vy * dtPrev;
      const predBox: [number, number, number, number] = [
        Math.max(0, Math.min(1000, tr.last_box[0] + predDy)),
        Math.max(0, Math.min(1000, tr.last_box[1] + predDx)),
        Math.max(0, Math.min(1000, tr.last_box[2] + predDy)),
        Math.max(0, Math.min(1000, tr.last_box[3] + predDx)),
      ];
      const predGeom = boxCenterAndSize(predBox);

      for (let di = 0; di < dets.length; di++) {
        const det = dets[di];
        if (!classesCompatible(trCls, det.class_name)) continue;

        const detGeom = boxCenterAndSize(det.box_2d);
        const iou = computeBoxIou(predBox, det.box_2d);
        const dist = Math.hypot(detGeom.cx - predGeom.cx, detGeom.cy - predGeom.cy);
        const maxDist = Math.max(135, 1.45 * Math.max(predGeom.diag, detGeom.diag));
        const distScore = Math.max(0, 1 - dist / maxDist);

        // Size ratio sanity guard (prevent matching a tiny distant car with a huge foreground bus)
        const sizeRatio =
          Math.min(predGeom.diag, detGeom.diag) / Math.max(1, Math.max(predGeom.diag, detGeom.diag));
        if (sizeRatio < 0.35) continue;

        const exactBonus = trCls === det.class_name ? 0.08 : 0;
        const score = 0.62 * iou + 0.38 * distScore + exactBonus;
        if (score >= 0.24 || iou >= 0.16) {
          candidates.push({ ti, di, score });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const matchedTracks = new Set<number>();
    const matchedDets = new Set<number>();
    const trackedFrameDetections: DetectionBox[] = [];

    for (const cand of candidates) {
      if (matchedTracks.has(cand.ti) || matchedDets.has(cand.di)) continue;
      matchedTracks.add(cand.ti);
      matchedDets.add(cand.di);

      const tr = activeTracks[cand.ti];
      const det = dets[cand.di];
      const geom = boxCenterAndSize(det.box_2d);
      const stepDt = Math.max(0.1, fr.timestamp_sec - tr.last_seen_sec);
      const stepDx = geom.cx - tr.last_cx;
      const stepDy = geom.cy - tr.last_cy;
      const stepDist = Math.hypot(stepDx, stepDy);

      // Gate crossing detection (vertical transit across 38% and 80% heights)
      const prevCy = tr.last_cy;
      const curCy = geom.cy;
      if (!tr.crossed_gate_a && ((prevCy <= GATE_A_Y && curCy >= GATE_A_Y) || (prevCy >= GATE_A_Y && curCy <= GATE_A_Y))) {
        tr.crossed_gate_a = true;
        tr.gate_a_sec = fr.timestamp_sec;
      }
      if (!tr.crossed_gate_b && ((prevCy <= GATE_B_Y && curCy >= GATE_B_Y) || (prevCy >= GATE_B_Y && curCy <= GATE_B_Y))) {
        tr.crossed_gate_b = true;
        tr.gate_b_sec = fr.timestamp_sec;
      }

      // Exponentially smoothed velocity
      tr.vx = tr.hits === 1 ? stepDx / stepDt : 0.6 * (stepDx / stepDt) + 0.4 * tr.vx;
      tr.vy = tr.hits === 1 ? stepDy / stepDt : 0.6 * (stepDy / stepDt) + 0.4 * tr.vy;
      tr.last_box = det.box_2d;
      tr.last_cx = geom.cx;
      tr.last_cy = geom.cy;
      tr.last_seen_sec = fr.timestamp_sec;
      tr.last_frame_idx = fr.frame_index;
      tr.hits += 1;
      tr.misses = 0;
      tr.total_displacement += stepDist;
      tr.diag_sum += geom.diag;
      tr.conf_sum += det.confidence;
      if (det.confidence > tr.max_confidence) tr.max_confidence = det.confidence;
      tr.class_votes[det.class_name] += det.confidence;

      const resolvedCls = dominantClass(tr.class_votes);
      if (VEHICLE_CLASSES.has(resolvedCls)) {
        const refM = REF_LENGTH_METERS[resolvedCls] || 4.3;
        const metersPerUnit =
          options?.is_calibrated && options.pixels_per_meter && options.pixels_per_meter > 1
            ? (meta.width / 1000) / options.pixels_per_meter
            : refM / Math.max(50, geom.diag);
        const instSpeed = Math.min(72, Math.max(0, ((stepDist * metersPerUnit) / stepDt) * 3.6));
        frameTrackSpeeds[fi].push(instSpeed);
      }

      trackedFrameDetections.push({
        track_id: tr.track_id,
        class_name: resolvedCls,
        confidence: det.confidence,
        box_2d: det.box_2d,
      });
    }

    // 2. Age unmatched active tracks
    for (let ti = activeTracks.length - 1; ti >= 0; ti--) {
      if (!matchedTracks.has(ti)) {
        activeTracks[ti].misses += 1;
        if (activeTracks[ti].misses > maxMissedFrames) {
          finishedTracks.push(activeTracks[ti]);
          activeTracks.splice(ti, 1);
        }
      }
    }

    // 3. Spawn new tracks for unmatched detections
    for (let di = 0; di < dets.length; di++) {
      if (matchedDets.has(di)) continue;
      const det = dets[di];
      const geom = boxCenterAndSize(det.box_2d);
      const votes = emptyVotes();
      votes[det.class_name] = det.confidence;
      const tr: ActiveTrack = {
        track_id: nextTrackId++,
        class_votes: votes,
        last_box: det.box_2d,
        first_cx: geom.cx,
        first_cy: geom.cy,
        last_cx: geom.cx,
        last_cy: geom.cy,
        vx: 0,
        vy: 0,
        first_seen_sec: fr.timestamp_sec,
        last_seen_sec: fr.timestamp_sec,
        first_frame_idx: fr.frame_index,
        last_frame_idx: fr.frame_index,
        hits: 1,
        misses: 0,
        total_displacement: 0,
        diag_sum: geom.diag,
        conf_sum: det.confidence,
        max_confidence: det.confidence,
        crossed_gate_a: false,
        crossed_gate_b: false,
        gate_a_sec: null,
        gate_b_sec: null,
      };
      activeTracks.push(tr);
      trackedFrameDetections.push({
        track_id: tr.track_id,
        class_name: det.class_name,
        confidence: det.confidence,
        box_2d: det.box_2d,
      });
    }

    // Per-frame class breakdown & occupancy
    const fCounts: UniqueClassCounts = {
      car: 0,
      motorcycle: 0,
      auto_rickshaw: 0,
      bus: 0,
      lcv: 0,
      truck: 0,
      bicycle: 0,
      pedestrian: 0,
    };
    let confSum = 0;
    for (const d of trackedFrameDetections) {
      fCounts[d.class_name] += 1;
      confSum += d.confidence;
    }

    const occPct = computeFrameOccupancyPct(trackedFrameDetections);
    const meanConf =
      trackedFrameDetections.length > 0
        ? roundTo(confSum / trackedFrameDetections.length, 3)
        : 0.0;

    frameOutputs.push({
      frame_index: fr.frame_index,
      timestamp_sec: fr.timestamp_sec,
      car: fCounts.car,
      motorcycle: fCounts.motorcycle,
      auto_rickshaw: fCounts.auto_rickshaw,
      bus: fCounts.bus,
      lcv: fCounts.lcv,
      truck: fCounts.truck,
      bicycle: fCounts.bicycle,
      pedestrian: fCounts.pedestrian,
      estimated_speed_kmh: 0, // filled right after smoothing
      lane_occupancy_pct: occPct,
      mean_confidence: meanConf,
      incidents: [],
      detections: trackedFrameDetections,
    });
  }

  // Finalize all remaining active tracks
  const allTracks = [...finishedTracks, ...activeTracks];

  // Filter confirmed tracks: >=2 hits, or high-confidence (>=0.62) single-frame vehicle at clip edges / very short clips
  const lastFrameIdx = Math.max(0, cleanedFrames.length - 1);
  const confirmedTracks = allTracks.filter((tr) => {
    if (tr.hits >= 2) return true;
    const isEdgeFrame = tr.first_frame_idx === 0 || tr.last_frame_idx === lastFrameIdx;
    return tr.max_confidence >= 0.62 && (cleanedFrames.length <= 3 || isEdgeFrame);
  });

  // Compute per-track summaries & clip-level metrics
  const uniqueCounts: UniqueClassCounts = {
    car: 0,
    motorcycle: 0,
    auto_rickshaw: 0,
    bus: 0,
    lcv: 0,
    truck: 0,
    bicycle: 0,
    pedestrian: 0,
  };

  let inboundCount = 0;
  let outboundCount = 0;
  let gateTransitions = 0;
  const gateTransitDurations: number[] = [];
  const trackSummaries: TrackSummary[] = [];
  const stoppedTrackAlerts: Array<{ track_id: number; class_name: RoadUserClass; duration_sec: number; timestamp_sec: number }> = [];

  for (const tr of confirmedTracks) {
    const cls = dominantClass(tr.class_votes);
    uniqueCounts[cls] += 1;

    const dt = Math.max(0.2, tr.last_seen_sec - tr.first_seen_sec);
    const avgDiag = tr.diag_sum / Math.max(1, tr.hits);
    const refM = REF_LENGTH_METERS[cls] || 4.3;
    const metersPerUnit =
      options?.is_calibrated && options.pixels_per_meter && options.pixels_per_meter > 1
        ? (meta.width / 1000) / options.pixels_per_meter
        : refM / Math.max(50, avgDiag);
    const speedKmh =
      tr.hits >= 2
        ? roundTo(Math.min(72, Math.max(0, ((tr.total_displacement * metersPerUnit) / dt) * 3.6)), 1)
        : 0;

    const netDx = tr.last_cx - tr.first_cx;
    const netDy = tr.last_cy - tr.first_cy;
    const netDisp = Math.hypot(netDx, netDy);
    const direction: "Inbound" | "Outbound" =
      Math.abs(netDy) >= Math.abs(netDx)
        ? netDy >= 0
          ? "Inbound"
          : "Outbound"
        : netDx >= 0
          ? "Inbound"
          : "Outbound";

    if (VEHICLE_CLASSES.has(cls)) {
      if (direction === "Inbound") inboundCount += 1;
      else outboundCount += 1;

      if (tr.crossed_gate_a && tr.crossed_gate_b && tr.gate_a_sec != null && tr.gate_b_sec != null) {
        gateTransitions += 1;
        gateTransitDurations.push(roundTo(Math.abs(tr.gate_b_sec - tr.gate_a_sec), 1));
      }

      // Stopped/stalled vehicle detection inside roadway
      if (tr.hits >= 5 && dt >= 5.0 && netDisp < 28 && tr.last_cy >= 350 && tr.last_cy <= 940) {
        stoppedTrackAlerts.push({
          track_id: tr.track_id,
          class_name: cls,
          duration_sec: roundTo(dt, 1),
          timestamp_sec: tr.last_seen_sec,
        });
      }
    }

    const transitDur =
      tr.gate_a_sec != null && tr.gate_b_sec != null
        ? roundTo(Math.abs(tr.gate_b_sec - tr.gate_a_sec), 1)
        : null;

    trackSummaries.push({
      track_id: tr.track_id,
      class_name: cls,
      first_seen_sec: tr.first_seen_sec,
      last_seen_sec: tr.last_seen_sec,
      first_frame_idx: tr.first_frame_idx,
      hits: tr.hits,
      speed_kmh: speedKmh,
      direction,
      crossed_gate_a: tr.crossed_gate_a,
      crossed_gate_b: tr.crossed_gate_b,
      transit_duration_sec: transitDur,
      mean_confidence: roundTo(tr.conf_sum / Math.max(1, tr.hits), 3),
    });
  }

  // Compute global moving-vehicle mean speed to backfill frame 0 (which has no previous frame)
  const movingTrackSpeeds = trackSummaries
    .filter((t) => VEHICLE_CLASSES.has(t.class_name) && t.hits >= 2)
    .map((t) => t.speed_kmh)
    .sort((a, b) => a - b);

  const globalMedianSpeed =
    movingTrackSpeeds.length > 0
      ? movingTrackSpeeds[Math.floor(movingTrackSpeeds.length / 2)]
      : 0;

  // Populate per-frame speeds & attach real detected incidents
  let spillbackAdded = false;
  let pedConflictAdded = false;

  for (let fi = 0; fi < frameOutputs.length; fi++) {
    const spds = frameTrackSpeeds[fi].sort((a, b) => a - b);
    const frameSpd =
      spds.length > 0 ? roundTo(spds[Math.floor(spds.length / 2)], 1) : roundTo(globalMedianSpeed, 1);
    frameOutputs[fi].estimated_speed_kmh = frameSpd;

    const frameVeh =
      frameOutputs[fi].car +
      frameOutputs[fi].motorcycle +
      frameOutputs[fi].auto_rickshaw +
      frameOutputs[fi].bus +
      frameOutputs[fi].lcv +
      frameOutputs[fi].truck +
      frameOutputs[fi].bicycle;

    // Genuine severe queue / spillback alert
    if (!spillbackAdded && frameVeh >= 10 && (frameOutputs[fi].lane_occupancy_pct >= 58 || frameSpd < 14)) {
      frameOutputs[fi].incidents.push({
        type: "INCIDENT_CONGESTION_SPILLBACK",
        severity: frameSpd < 10 ? "High" : "Moderate",
        message: `Dense slow-moving queue detected (${frameVeh} simultaneous vehicles, ${frameOutputs[fi].lane_occupancy_pct}% road occupancy, ~${frameSpd} km/h).`,
      });
      spillbackAdded = true;
    }

    // Genuine pedestrian-carriageway proximity alert
    if (!pedConflictAdded && frameVeh >= 4) {
      const roadPed = frameOutputs[fi].detections.find(
        (d) =>
          d.class_name === "pedestrian" &&
          d.box_2d[1] >= 160 &&
          d.box_2d[3] <= 840 &&
          d.box_2d[2] >= 520 &&
          d.box_2d[2] <= 940
      );
      if (roadPed) {
        frameOutputs[fi].incidents.push({
          type: "INCIDENT_PEDESTRIAN_CARRIAGEWAY",
          severity: "Moderate",
          message: `Pedestrian detected in active carriageway lanes alongside ${frameVeh} vehicles.`,
        });
        pedConflictAdded = true;
      }
    }
  }

  // Attach stopped-vehicle alerts (top 2 longest stationary vehicles)
  for (const st of stoppedTrackAlerts.sort((a, b) => b.duration_sec - a.duration_sec).slice(0, 2)) {
    const targetFrame = frameOutputs.find((f) => f.timestamp_sec >= st.timestamp_sec) ?? frameOutputs[frameOutputs.length - 1];
    if (targetFrame) {
      targetFrame.incidents.push({
        type: "INCIDENT_STOPPED_VEHICLE",
        severity: st.duration_sec >= 8 ? "High" : "Moderate",
        message: `Tracked ${st.class_name.replace(/_/g, " ")} (#${st.track_id}) remained stationary in carriageway for ${st.duration_sec}s.`,
      });
    }
  }

  const totalUniqueVehicles =
    uniqueCounts.car +
    uniqueCounts.motorcycle +
    uniqueCounts.auto_rickshaw +
    uniqueCounts.bus +
    uniqueCounts.lcv +
    uniqueCounts.truck +
    uniqueCounts.bicycle;

  const dominantFlowDirection =
    inboundCount === 0 && outboundCount === 0
      ? "Stationary / Low Flow"
      : inboundCount >= outboundCount * 1.35
        ? "Inbound Dominant"
        : outboundCount >= inboundCount * 1.35
          ? "Outbound Dominant"
          : "Bidirectional Mixed Flow";

  gateTransitDurations.sort((a, b) => a - b);
  const medianGateTransitSec =
    gateTransitDurations.length > 0
      ? gateTransitDurations[Math.floor(gateTransitDurations.length / 2)]
      : null;

  const plural = (n: number, singular: string, pluralForm: string) =>
    `${n} ${n === 1 ? singular : pluralForm}`;

  const classParts: string[] = [];
  if (uniqueCounts.motorcycle > 0) classParts.push(plural(uniqueCounts.motorcycle, "motorcycle", "motorcycles"));
  if (uniqueCounts.car > 0) classParts.push(plural(uniqueCounts.car, "car", "cars"));
  if (uniqueCounts.auto_rickshaw > 0) classParts.push(plural(uniqueCounts.auto_rickshaw, "auto-rickshaw", "auto-rickshaws"));
  if (uniqueCounts.lcv > 0) classParts.push(plural(uniqueCounts.lcv, "LCV", "LCVs"));
  if (uniqueCounts.truck > 0) classParts.push(plural(uniqueCounts.truck, "truck", "trucks"));
  if (uniqueCounts.bus > 0) classParts.push(plural(uniqueCounts.bus, "bus", "buses"));
  if (uniqueCounts.bicycle > 0) classParts.push(plural(uniqueCounts.bicycle, "bicycle", "bicycles"));

  const sceneSummary =
    totalUniqueVehicles > 0
      ? `YOLOv11s tracked ${plural(totalUniqueVehicles, "unique vehicle", "unique vehicles")} across ${frameOutputs.length} sampled frames (${classParts.join(", ")}) plus ${plural(uniqueCounts.pedestrian, "roadside pedestrian", "roadside pedestrians")} at ~${roundTo(globalMedianSpeed, 1)} km/h.`
      : `YOLOv11s analyzed ${frameOutputs.length} frames with zero confirmed motorized vehicles detected.`;

  return {
    frames: frameOutputs,
    tracks: trackSummaries,
    unique_class_counts: uniqueCounts,
    overall_unique_vehicles: totalUniqueVehicles,
    inbound_count: inboundCount,
    outbound_count: outboundCount,
    dominant_flow_direction: dominantFlowDirection,
    scene_summary: sceneSummary,
    model_used: modelUsed,
    gate_transitions_count: gateTransitions,
    median_gate_transit_sec: medianGateTransitSec,
  };
}
