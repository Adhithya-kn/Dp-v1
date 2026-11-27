import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AppDatabase } from "./database.ts";
import { roundTo } from "./physics.ts";
import { getRoadName, normalizeCorridorId, ROAD_REGISTRY } from "./roadRegistry.ts";
import { isValidIdentifier, nowIso } from "./services.ts";
import {
  trackAndAnalyzeFrames,
  type DetectionBox,
  type FrameDetectionsInput,
  type TrackSummary,
  type TrackedFrameOutput,
  type UniqueClassCounts,
} from "./cvTracker.ts";
import { analyzeFramesWithYolo11, detectImageBuffersWithYolo11, isYolo11ModelReady } from "./yolo11Engine.ts";

const execFileAsync = promisify(execFile);

const YOLO11_MODEL_LABEL = "Ultralytics YOLOv11s (ONNX)";

// Indo-HCM Passenger Car Unit (PCU) equivalency weights
const INDO_HCM_PCU: Record<string, number> = {
  car: 1.0,
  motorcycle: 0.5,
  auto_rickshaw: 1.2,
  bus: 3.0,
  lcv: 1.5,
  truck: 3.0,
  bicycle: 0.4,
};

// ---------------------------------------------------------------------------
// Path Confinement & Real 4-Point DLT Homography Math
// ---------------------------------------------------------------------------

export function assertPathInside(rootDir: string, targetPath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error("Path traversal rejected: target escapes permitted storage directory.");
  }
  return resolvedTarget;
}

function solveLinear8x8(A: number[][], b: number[]): number[] {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const val = Math.abs(M[r][col]);
      if (val > maxAbs) {
        maxAbs = val;
        pivotRow = r;
      }
    }
    if (maxAbs < 1e-10) {
      throw new Error("Calibration points are collinear or degenerate; cannot solve planar homography.");
    }
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }
    const pivot = M[col][col];
    for (let c = col; c <= n; c++) {
      M[col][c] /= pivot;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let c = col; c <= n; c++) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }

  return M.map((row) => row[n]);
}

function validateQuadPoints(points: unknown[], label: string): Array<[number, number]> {
  if (!Array.isArray(points) || points.length !== 4) {
    throw new Error(`Exactly 4 ${label} points are required.`);
  }
  return points.map((pt, idx) => {
    if (!Array.isArray(pt) || pt.length < 2) {
      throw new Error(`Invalid ${label} point at index ${idx}.`);
    }
    const x = Number(pt[0]);
    const y = Number(pt[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Non-finite coordinates in ${label} point at index ${idx}.`);
    }
    return [x, y];
  });
}

function polygonPerimeter(pts: Array<[number, number]>): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += Math.hypot(x2 - x1, y2 - y1);
  }
  return sum;
}

export function solveHomography(
  srcPointsRaw: unknown[],
  dstPointsRaw: unknown[]
): { matrix: number[][]; pixels_per_meter: number } {
  const src = validateQuadPoints(srcPointsRaw, "source");
  const dst = validateQuadPoints(dstPointsRaw, "destination");

  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }

  const h = solveLinear8x8(A, b);
  const matrix: number[][] = [
    [roundTo(h[0], 8), roundTo(h[1], 8), roundTo(h[2], 8)],
    [roundTo(h[3], 8), roundTo(h[4], 8), roundTo(h[5], 8)],
    [roundTo(h[6], 8), roundTo(h[7], 8), 1.0],
  ];

  const srcPerim = polygonPerimeter(src);
  const dstPerim = polygonPerimeter(dst);
  const ppm = dstPerim > 1e-6 ? roundTo(srcPerim / dstPerim, 2) : 12.5;

  return { matrix, pixels_per_meter: ppm };
}

export function projectPoint(H: number[][], pt: [number, number]): [number, number] {
  const [x, y] = pt;
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  if (Math.abs(w) < 1e-12) return [0, 0];
  const X = (H[0][0] * x + H[0][1] * y + H[0][2]) / w;
  const Y = (H[1][0] * x + H[1][1] * y + H[1][2]) / w;
  return [X, Y];
}

// ---------------------------------------------------------------------------
// CameraRegistry (SQLite-backed with real 4-point DLT homography)
// ---------------------------------------------------------------------------

export interface CameraRecord {
  camera_id: string;
  corridor_id: string;
  name: string;
  roi_polygon: number[][];
  lane_polygons: number[][][];
  homography_matrix: number[][];
  pixels_per_meter: number;
  is_homography_calibrated: boolean;
  updated_at: number;
}

export class CameraRegistry {
  private appDb: AppDatabase;

  constructor(appDb: AppDatabase) {
    this.appDb = appDb;
    this.seedDefaultsIfEmpty();
  }

  private seedDefaultsIfEmpty(): void {
    const row = this.appDb.db.prepare("SELECT COUNT(*) AS c FROM cameras").get() as { c?: number } | undefined;
    if ((row?.c ?? 0) > 0) return;

    const now = Date.now() / 1000;
    const defaultCalib1 = solveHomography(
      [[220, 260], [1060, 260], [1220, 690], [60, 690]],
      [[0, 45], [14, 45], [14, 0], [0, 0]]
    );
    const defaultCalib2 = solveHomography(
      [[240, 220], [1040, 220], [1200, 680], [80, 680]],
      [[0, 50], [16, 50], [16, 0], [0, 0]]
    );
    const defaultCalib3 = solveHomography(
      [[180, 180], [1100, 180], [1240, 700], [40, 700]],
      [[0, 60], [21, 60], [21, 0], [0, 0]]
    );
    const defaultCalib4 = solveHomography(
      [[200, 200], [1080, 200], [1220, 690], [60, 690]],
      [[0, 55], [18, 55], [18, 0], [0, 0]]
    );

    const defaults: CameraRecord[] = [
      {
        camera_id: "CAM_BLR_01",
        corridor_id: "RD_BLR_01",
        name: "Indiranagar 100 Feet Road CCTV #1",
        roi_polygon: [[0.05, 0.2], [0.95, 0.2], [0.95, 0.95], [0.05, 0.95]],
        lane_polygons: [
          [[0.05, 0.2], [0.48, 0.2], [0.48, 0.95], [0.05, 0.95]],
          [[0.52, 0.2], [0.95, 0.2], [0.95, 0.95], [0.52, 0.95]],
        ],
        homography_matrix: defaultCalib1.matrix,
        pixels_per_meter: defaultCalib1.pixels_per_meter,
        is_homography_calibrated: true,
        updated_at: now,
      },
      {
        camera_id: "CAM_BLR_02",
        corridor_id: "RD_BLR_02",
        name: "MG Road - Trinity Circle CCTV #2",
        roi_polygon: [[0.1, 0.15], [0.9, 0.15], [0.95, 0.9], [0.05, 0.9]],
        lane_polygons: [],
        homography_matrix: defaultCalib2.matrix,
        pixels_per_meter: defaultCalib2.pixels_per_meter,
        is_homography_calibrated: true,
        updated_at: now,
      },
      {
        camera_id: "CAM_BLR_03",
        corridor_id: "RD_BLR_03",
        name: "Hebbal Flyover Express CCTV #3",
        roi_polygon: [[0.0, 0.1], [1.0, 0.1], [1.0, 1.0], [0.0, 1.0]],
        lane_polygons: [],
        homography_matrix: defaultCalib3.matrix,
        pixels_per_meter: defaultCalib3.pixels_per_meter,
        is_homography_calibrated: true,
        updated_at: now,
      },
      {
        camera_id: "CAM_BLR_04",
        corridor_id: "RD_BLR_04",
        name: "CMH Road Indiranagar CCTV #4",
        roi_polygon: [[0.05, 0.1], [0.95, 0.1], [0.95, 0.95], [0.05, 0.95]],
        lane_polygons: [],
        homography_matrix: defaultCalib4.matrix,
        pixels_per_meter: defaultCalib4.pixels_per_meter,
        is_homography_calibrated: true,
        updated_at: now,
      },
    ];

    for (const c of defaults) {
      this.saveCamera(c);
    }
  }

  private rowToCamera(row: Record<string, unknown>): CameraRecord {
    return {
      camera_id: String(row.camera_id),
      corridor_id: String(row.corridor_id),
      name: String(row.name),
      roi_polygon: JSON.parse(String(row.roi_polygon_json || "[]")),
      lane_polygons: JSON.parse(String(row.lane_polygons_json || "[]")),
      homography_matrix: JSON.parse(String(row.homography_matrix_json || "[[1,0,0],[0,1,0],[0,0,1]]")),
      pixels_per_meter: Number(row.pixels_per_meter ?? 12.5),
      is_homography_calibrated: Boolean(row.is_homography_calibrated),
      updated_at: Number(row.updated_at ?? Date.now() / 1000),
    };
  }

  private saveCamera(rec: CameraRecord): void {
    this.appDb.db
      .prepare(
        `INSERT INTO cameras (
           camera_id, corridor_id, name, roi_polygon_json, lane_polygons_json,
           homography_matrix_json, pixels_per_meter, is_homography_calibrated, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(camera_id) DO UPDATE SET
           corridor_id = excluded.corridor_id,
           name = excluded.name,
           roi_polygon_json = excluded.roi_polygon_json,
           lane_polygons_json = excluded.lane_polygons_json,
           homography_matrix_json = excluded.homography_matrix_json,
           pixels_per_meter = excluded.pixels_per_meter,
           is_homography_calibrated = excluded.is_homography_calibrated,
           updated_at = excluded.updated_at`
      )
      .run(
        rec.camera_id,
        rec.corridor_id,
        rec.name,
        JSON.stringify(rec.roi_polygon),
        JSON.stringify(rec.lane_polygons),
        JSON.stringify(rec.homography_matrix),
        rec.pixels_per_meter,
        rec.is_homography_calibrated ? 1 : 0,
        rec.updated_at
      );
  }

  public listCameras(corridorId?: string | null): CameraRecord[] {
    let rows: Array<Record<string, unknown>>;
    if (corridorId) {
      const norm = normalizeCorridorId(corridorId);
      rows = this.appDb.db
        .prepare("SELECT * FROM cameras WHERE corridor_id = ? ORDER BY camera_id ASC")
        .all(norm) as Array<Record<string, unknown>>;
    } else {
      rows = this.appDb.db
        .prepare("SELECT * FROM cameras ORDER BY camera_id ASC")
        .all() as Array<Record<string, unknown>>;
    }
    return rows.map((r) => this.rowToCamera(r));
  }

  public get(cameraId: string): CameraRecord | null {
    const row = this.appDb.db
      .prepare("SELECT * FROM cameras WHERE camera_id = ?")
      .get(cameraId) as Record<string, unknown> | undefined;
    return row ? this.rowToCamera(row) : null;
  }

  public upsert(payload: Record<string, unknown>): CameraRecord {
    const cameraId = String(payload.camera_id ?? "").trim();
    const corridorId = normalizeCorridorId(String(payload.corridor_id ?? "").trim());
    if (!cameraId || !corridorId) {
      throw new Error("camera_id and corridor_id are required.");
    }
    if (!isValidIdentifier(cameraId)) {
      throw new Error("Invalid camera_id format.");
    }
    const existing = this.get(cameraId);
    const rec: CameraRecord = {
      camera_id: cameraId,
      corridor_id: corridorId,
      name: String(payload.name ?? existing?.name ?? cameraId),
      roi_polygon: Array.isArray(payload.roi_polygon)
        ? (payload.roi_polygon as number[][])
        : existing?.roi_polygon ?? [[0.05, 0.2], [0.95, 0.2], [0.95, 0.95], [0.05, 0.95]],
      lane_polygons: Array.isArray(payload.lane_polygons)
        ? (payload.lane_polygons as number[][][])
        : existing?.lane_polygons ?? [],
      homography_matrix: Array.isArray(payload.homography)
        ? (payload.homography as number[][])
        : existing?.homography_matrix ?? [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      pixels_per_meter: Number(payload.pixels_per_meter ?? existing?.pixels_per_meter ?? 12.5),
      is_homography_calibrated: Boolean(
        payload.is_homography_calibrated ?? existing?.is_homography_calibrated ?? false
      ),
      updated_at: Date.now() / 1000,
    };
    this.saveCamera(rec);
    return rec;
  }

  public calibrate(cameraId: string, srcPoints: unknown[], dstPoints: unknown[]): CameraRecord {
    const existing = this.get(cameraId);
    if (!existing) throw new Error(`Camera '${cameraId}' is not registered.`);
    const { matrix, pixels_per_meter } = solveHomography(srcPoints, dstPoints);
    const updated: CameraRecord = {
      ...existing,
      homography_matrix: matrix,
      pixels_per_meter,
      is_homography_calibrated: true,
      updated_at: Date.now() / 1000,
    };
    this.saveCamera(updated);
    return updated;
  }
}

// ---------------------------------------------------------------------------
// Real Video Probing, Keyframe Extraction & Ultralytics YOLOv11s ONNX Pipeline
// ---------------------------------------------------------------------------

export interface VideoMetadata {
  width: number;
  height: number;
  fps: number;
  duration_seconds: number;
  total_frames: number;
  codec: string;
}

export type FrameDetectionBox = DetectionBox;
export type FrameAnalysisEntry = TrackedFrameOutput;
export type { UniqueClassCounts };

export interface MultimodalAnalysisResult {
  frames: FrameAnalysisEntry[];
  tracks?: TrackSummary[];
  unique_class_counts: UniqueClassCounts;
  overall_unique_vehicles: number;
  inbound_count: number;
  outbound_count: number;
  dominant_flow_direction: string;
  scene_summary: string;
  model_used: string;
  gate_transitions_count?: number;
  median_gate_transit_sec?: number | null;
}

export interface FrameAnalyzerOptions {
  baseDir?: string;
  pixels_per_meter?: number;
  is_calibrated?: boolean;
  onFrameProgress?: (completed: number, total: number) => void;
}

export type FrameAnalyzerFn = (
  frames: Array<{ index: number; timestamp_sec: number; filePath: string }>,
  meta: VideoMetadata,
  options?: FrameAnalyzerOptions
) => Promise<MultimodalAnalysisResult>;

interface StoredVideo {
  video_id: string;
  filename: string;
  file_path: string;
  file_size_bytes: number;
  owner: string;
  uploaded_at: string;
}

interface UploadSession {
  upload_id: string;
  filename: string;
  file_size: number;
  total_chunks: number;
  chunk_size: number;
  owner: string;
  received_chunks: Set<number>;
  chunks_dir: string;
}

export interface VisionJob {
  job_id: string;
  video_id: string;
  original_filename: string;
  owner: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  progress_pct: number;
  total_frames: number;
  processed_frames: number;
  duration_seconds: number;
  fps: number;
  width: number;
  height: number;
  model_name: string;
  model_status: string;
  provenance: string;
  camera_config: Record<string, unknown> | null;
  confidence_summary: Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
  output_video_path: string | null;
  error_message: string | null;
  results: Record<string, unknown> | null;
}

async function probeVideoMetadata(filePath: string): Promise<VideoMetadata> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { timeout: 15_000 }
  );

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      nb_frames?: string;
      duration?: string;
    }>;
  };

  const videoStream = (parsed.streams ?? []).find((s) => s.codec_type === "video");
  if (!videoStream) {
    throw new Error("Uploaded file does not contain a valid video stream.");
  }

  const parseFps = (rate?: string): number => {
    if (!rate) return 25;
    const parts = rate.split("/");
    if (parts.length === 2) {
      const num = Number(parts[0]);
      const den = Number(parts[1]);
      if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return num / den;
    }
    const val = Number(rate);
    return Number.isFinite(val) && val > 0 ? val : 25;
  };

  const fps = roundTo(parseFps(videoStream.avg_frame_rate || videoStream.r_frame_rate), 2);
  const duration = roundTo(
    Math.max(
      0.5,
      Number(parsed.format?.duration ?? videoStream.duration ?? 5)
    ),
    2
  );
  const nbFramesRaw = Number(videoStream.nb_frames);
  const totalFrames =
    Number.isFinite(nbFramesRaw) && nbFramesRaw > 0
      ? Math.round(nbFramesRaw)
      : Math.max(1, Math.round(duration * fps));

  return {
    width: Number(videoStream.width ?? 1280),
    height: Number(videoStream.height ?? 720),
    fps,
    duration_seconds: duration,
    total_frames: totalFrames,
    codec: String(videoStream.codec_name ?? "h264"),
  };
}

async function extractKeyframes(
  filePath: string,
  meta: VideoMetadata,
  maxFrames = 30
): Promise<{ tempDir: string; frames: Array<{ index: number; timestamp_sec: number; filePath: string }> }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "traffic_cv_"));
  const targetCount = Math.max(2, Math.min(maxFrames, Math.ceil(meta.duration_seconds)));
  const fpsFilter = Math.max(0.2, targetCount / Math.max(meta.duration_seconds, 1));
  const outPattern = path.join(tempDir, "frame_%03d.jpg");

  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filePath,
      "-vf",
      `fps=${fpsFilter.toFixed(4)},scale='min(1280,iw)':-2`,
      "-frames:v",
      String(targetCount),
      "-q:v",
      "3",
      outPattern,
    ],
    { timeout: 60_000 }
  );

  const files = fs
    .readdirSync(tempDir)
    .filter((f) => f.endsWith(".jpg"))
    .sort();

  const frames = files.map((file, idx) => ({
    index: idx,
    timestamp_sec: roundTo(((idx + 0.5) / Math.max(files.length, 1)) * meta.duration_seconds, 2),
    filePath: path.join(tempDir, file),
  }));

  if (frames.length === 0) {
    throw new Error("FFmpeg could not extract any video frames from the input file.");
  }

  return { tempDir, frames };
}

// ---------------------------------------------------------------------------
// VisionService (SQLite-backed jobs, videos, cameras, real YOLOv11s pipeline)
// ---------------------------------------------------------------------------

export class VisionService {
  private baseDir: string;
  private uploadsDir: string;
  private chunksDir: string;
  private appDb: AppDatabase;
  private uploadSessions: Map<string, UploadSession> = new Map();
  private activeJobPromises: Map<string, Promise<void>> = new Map();
  private frameAnalyzer: FrameAnalyzerFn;
  public cameraRegistry: CameraRegistry;

  constructor(
    baseDir: string | undefined,
    appDb: AppDatabase,
    options?: { frameAnalyzer?: FrameAnalyzerFn }
  ) {
    this.baseDir = baseDir ?? process.cwd();
    this.appDb = appDb;
    const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
    const storageRoot =
      process.env.PERSISTENT_DATA_DIR?.trim() ||
      (isVercel
        ? path.join(os.tmpdir(), "smart_traffic")
        : path.join(this.baseDir, "data", "storage"));
    this.uploadsDir = path.join(storageRoot, "videos", "uploads");
    this.chunksDir = path.join(storageRoot, "videos", "chunks");
    this.frameAnalyzer = options?.frameAnalyzer ?? analyzeFramesWithYolo11;
    this.cameraRegistry = new CameraRegistry(appDb);
    this.purgeLegacyFallbackJobs();
  }

  public isYolo11Ready(): boolean {
    return isYolo11ModelReady(this.baseDir);
  }

  private purgeLegacyFallbackJobs(): void {
    try {
      this.appDb.db
        .prepare(
          "DELETE FROM vision_jobs WHERE model_name LIKE '%fallback%' OR provenance LIKE '%Fallback%' OR provenance LIKE '%OPTICAL%' OR error_message LIKE '%API_KEY_INVALID%' OR error_message LIKE '%GEMINI_API_KEY%'"
        )
        .run();
    } catch {
      // ignore if table not initialized
    }
  }

  public async checkFfmpegAvailable(): Promise<boolean> {
    try {
      await execFileAsync("ffprobe", ["-version"], { timeout: 3000 });
      await execFileAsync("ffmpeg", ["-version"], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  private saveVideo(v: StoredVideo): void {
    this.appDb.db
      .prepare(
        `INSERT INTO videos (video_id, filename, file_path, file_size_bytes, owner, uploaded_at, sample_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(video_id) DO UPDATE SET
           filename = excluded.filename,
           file_path = excluded.file_path,
           file_size_bytes = excluded.file_size_bytes,
           owner = excluded.owner,
           uploaded_at = excluded.uploaded_at,
           sample_url = excluded.sample_url`
      )
      .run(v.video_id, v.filename, v.file_path, v.file_size_bytes, v.owner, v.uploaded_at, null);
  }

  private getVideo(videoId: string): StoredVideo | null {
    const row = this.appDb.db
      .prepare("SELECT * FROM videos WHERE video_id = ?")
      .get(videoId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      video_id: String(row.video_id),
      filename: String(row.filename),
      file_path: String(row.file_path),
      file_size_bytes: Number(row.file_size_bytes),
      owner: String(row.owner),
      uploaded_at: String(row.uploaded_at),
    };
  }

  private saveJob(job: VisionJob): void {
    this.appDb.db
      .prepare(
        `INSERT INTO vision_jobs (
           job_id, video_id, original_filename, owner, status, progress_pct,
           total_frames, processed_frames, duration_seconds, fps, width, height,
           model_name, model_status, provenance, camera_config_json,
           confidence_summary_json, created_at, completed_at, output_video_path,
           error_message, results_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           status = excluded.status,
           progress_pct = excluded.progress_pct,
           total_frames = excluded.total_frames,
           processed_frames = excluded.processed_frames,
           duration_seconds = excluded.duration_seconds,
           fps = excluded.fps,
           width = excluded.width,
           height = excluded.height,
           model_name = excluded.model_name,
           model_status = excluded.model_status,
           provenance = excluded.provenance,
           camera_config_json = excluded.camera_config_json,
           confidence_summary_json = excluded.confidence_summary_json,
           completed_at = excluded.completed_at,
           output_video_path = excluded.output_video_path,
           error_message = excluded.error_message,
           results_json = excluded.results_json`
      )
      .run(
        job.job_id,
        job.video_id,
        job.original_filename,
        job.owner,
        job.status,
        job.progress_pct,
        job.total_frames,
        job.processed_frames,
        job.duration_seconds,
        job.fps,
        job.width,
        job.height,
        job.model_name,
        job.model_status,
        job.provenance,
        job.camera_config ? JSON.stringify(job.camera_config) : null,
        job.confidence_summary ? JSON.stringify(job.confidence_summary) : null,
        job.created_at,
        job.completed_at,
        job.output_video_path,
        job.error_message,
        job.results ? JSON.stringify(job.results) : null
      );
  }

  private loadJob(jobId: string): VisionJob | null {
    const row = this.appDb.db
      .prepare("SELECT * FROM vision_jobs WHERE job_id = ?")
      .get(jobId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      job_id: String(row.job_id),
      video_id: String(row.video_id),
      original_filename: String(row.original_filename),
      owner: String(row.owner),
      status: String(row.status) as VisionJob["status"],
      progress_pct: Number(row.progress_pct),
      total_frames: Number(row.total_frames),
      processed_frames: Number(row.processed_frames),
      duration_seconds: Number(row.duration_seconds),
      fps: Number(row.fps),
      width: Number(row.width),
      height: Number(row.height),
      model_name: String(row.model_name),
      model_status: String(row.model_status),
      provenance: String(row.provenance),
      camera_config: row.camera_config_json ? JSON.parse(String(row.camera_config_json)) : null,
      confidence_summary: row.confidence_summary_json ? JSON.parse(String(row.confidence_summary_json)) : null,
      created_at: String(row.created_at),
      completed_at: row.completed_at ? String(row.completed_at) : null,
      output_video_path: row.output_video_path ? String(row.output_video_path) : null,
      error_message: row.error_message ? String(row.error_message) : null,
      results: row.results_json ? JSON.parse(String(row.results_json)) : null,
    };
  }

  public getJobCount(): number {
    const row = this.appDb.db.prepare("SELECT COUNT(*) AS c FROM vision_jobs").get() as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  }

  public getStatus() {
    const ready = this.isYolo11Ready();
    const engineLabel = ready
      ? "Ultralytics YOLOv11s (ONNX) + IoU Tracker"
      : "Unavailable (YOLOv11 ONNX weights missing)";
    return {
      success: true,
      status: "success",
      message: ready
        ? "Computer vision pipeline operational (FFmpeg keyframe extraction + Ultralytics YOLOv11s ONNX + IoU Multi-Object Tracker)."
        : "YOLOv11 ONNX model weights are missing in models/yolo11/yolo11s.onnx.",
      timestamp: nowIso(),
      data: {
        engine: engineLabel,
        yolo_loaded: ready,
        yolo_model: "yolo11s.onnx",
        model_type: "Ultralytics YOLOv11s (ONNX) + IoU Multi-Object Tracker + Indo-HCM PCU",
        load_error: ready ? null : "Missing models/yolo11/yolo11s.onnx",
        total_jobs_tracked: this.getJobCount(),
        supported_formats: [".mp4", ".webm", ".avi", ".mov", ".mkv"],
        target_classes: ["car", "motorcycle", "auto_rickshaw", "bicycle", "bus", "lcv", "truck", "pedestrian"],
        model_scope:
          "Local server-side FFprobe/FFmpeg frame extraction + Ultralytics YOLOv11s ONNX object detection, multi-object IoU tracking, and Indo-HCM PCU computation.",
        evaluation_status: ready ? "operational" : "missing_weights",
      },
    };
  }

  public saveDirectUpload(buffer: Buffer, filename: string, owner = "traffic_admin") {
    if (!buffer || buffer.length === 0) {
      return { code: 400, body: { success: false, status: "error", message: "Empty upload payload.", timestamp: nowIso() } };
    }
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    const safeName = path.basename(filename || "uploaded_traffic.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");
    const videoId = `vid_${crypto.randomBytes(6).toString("hex")}`;
    const outPath = assertPathInside(this.uploadsDir, path.join(this.uploadsDir, `${videoId}_${safeName}`));
    fs.writeFileSync(outPath, buffer);
    const stored: StoredVideo = {
      video_id: videoId,
      filename: safeName,
      file_path: outPath,
      file_size_bytes: buffer.length,
      owner,
      uploaded_at: nowIso(),
    };
    this.saveVideo(stored);
    return {
      code: 200,
      body: {
        success: true,
        status: "success",
        message: "Video uploaded successfully.",
        timestamp: nowIso(),
        data: stored,
      },
    };
  }

  public initChunkedUpload(body: Record<string, unknown>, owner = "traffic_admin") {
    const filename = path.basename(String(body.filename || "traffic_sample.mp4")).replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileSize = Number(body.file_size);
    const totalChunks = Number(body.total_chunks);
    const chunkSize = Number(body.chunk_size || 8 * 1024 * 1024);
    if (!Number.isInteger(fileSize) || fileSize <= 0) {
      return { code: 400, body: { success: false, status: "error", message: "Valid positive 'file_size' required.", timestamp: nowIso() } };
    }
    if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > 2048) {
      return { code: 400, body: { success: false, status: "error", message: "Valid positive 'total_chunks' required.", timestamp: nowIso() } };
    }

    const uploadId = `upl_${crypto.randomBytes(6).toString("hex")}`;
    const sessionDir = assertPathInside(this.chunksDir, path.join(this.chunksDir, uploadId));
    fs.mkdirSync(sessionDir, { recursive: true });

    this.uploadSessions.set(uploadId, {
      upload_id: uploadId,
      filename,
      file_size: fileSize,
      total_chunks: totalChunks,
      chunk_size: chunkSize,
      owner,
      received_chunks: new Set<number>(),
      chunks_dir: sessionDir,
    });

    return {
      code: 200,
      body: {
        success: true,
        status: "success",
        message: "Chunked upload initialized.",
        timestamp: nowIso(),
        data: {
          upload_id: uploadId,
          filename,
          file_size: fileSize,
          total_chunks: totalChunks,
          chunk_size: chunkSize,
        },
      },
    };
  }

  public saveChunk(uploadId: string, chunkIndex: number, data: Buffer) {
    const session = this.uploadSessions.get(uploadId);
    if (!session) {
      return { code: 404, body: { success: false, status: "error", message: `Upload session '${uploadId}' not found.`, timestamp: nowIso() } };
    }
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.total_chunks) {
      return { code: 400, body: { success: false, status: "error", message: "Chunk index out of bounds.", timestamp: nowIso() } };
    }
    const partPath = assertPathInside(session.chunks_dir, path.join(session.chunks_dir, `chunk_${chunkIndex}.part`));
    fs.writeFileSync(partPath, data);
    session.received_chunks.add(chunkIndex);
    return {
      code: 200,
      body: {
        success: true,
        status: "success",
        message: `Chunk ${chunkIndex} stored.`,
        timestamp: nowIso(),
        data: {
          upload_id: uploadId,
          chunk_index: chunkIndex,
          received_count: session.received_chunks.size,
          total_chunks: session.total_chunks,
        },
      },
    };
  }

  public getUploadStatus(uploadId: string) {
    const session = this.uploadSessions.get(uploadId);
    if (!session) {
      return { code: 404, body: { success: false, status: "error", message: `Upload '${uploadId}' not found.`, timestamp: nowIso() } };
    }
    return {
      code: 200,
      body: {
        success: true,
        status: "success",
        timestamp: nowIso(),
        data: {
          upload_id: uploadId,
          filename: session.filename,
          total_chunks: session.total_chunks,
          received_chunks: Array.from(session.received_chunks).sort((a, b) => a - b),
          received_count: session.received_chunks.size,
        },
      },
    };
  }

  public completeChunkedUpload(body: Record<string, unknown>) {
    const uploadId = String(body.upload_id || "").trim();
    const session = this.uploadSessions.get(uploadId);
    if (!session) {
      return { code: 404, body: { success: false, status: "error", message: `Upload '${uploadId}' not found.`, timestamp: nowIso() } };
    }
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    const videoId = `vid_${crypto.randomBytes(6).toString("hex")}`;
    const outPath = assertPathInside(this.uploadsDir, path.join(this.uploadsDir, `${videoId}_${session.filename}`));
    const outFd = fs.openSync(outPath, "w");
    let totalBytes = 0;
    try {
      for (let i = 0; i < session.total_chunks; i++) {
        const partPath = assertPathInside(session.chunks_dir, path.join(session.chunks_dir, `chunk_${i}.part`));
        if (fs.existsSync(partPath)) {
          const buf = fs.readFileSync(partPath);
          fs.writeSync(outFd, buf);
          totalBytes += buf.length;
        }
      }
    } finally {
      fs.closeSync(outFd);
    }

    // Cleanup assembled chunk folder
    try {
      fs.rmSync(session.chunks_dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    this.uploadSessions.delete(uploadId);

    const stored: StoredVideo = {
      video_id: videoId,
      filename: session.filename,
      file_path: outPath,
      file_size_bytes: totalBytes,
      owner: session.owner,
      uploaded_at: nowIso(),
    };
    this.saveVideo(stored);

    return {
      code: 200,
      body: {
        success: true,
        status: "success",
        message: "Chunked video upload assembled successfully.",
        timestamp: nowIso(),
        data: stored,
      },
    };
  }

  public processVideo(body: Record<string, unknown>, owner = "traffic_admin") {
    const videoId = String(body.video_id || "").trim();
    if (!videoId || !isValidIdentifier(videoId)) {
      return { code: 400, body: { success: false, status: "error", message: "Valid 'video_id' is required.", timestamp: nowIso() } };
    }
    const stored = this.getVideo(videoId);
    if (!stored || !fs.existsSync(stored.file_path)) {
      return {
        code: 404,
        body: { success: false, status: "error", message: `Video '${videoId}' not found on server storage.`, timestamp: nowIso() },
      };
    }

    const filename = String(body.filename || stored.filename || "traffic_video.mp4");
    const cameraId = String(body.camera_id || "").trim();
    const cameraRec = cameraId ? this.cameraRegistry.get(cameraId) : null;
    const cameraConfig = cameraRec ? (cameraRec as unknown as Record<string, unknown>) : null;

    const jobId = `cv_${crypto.randomBytes(5).toString("hex")}`;
    const job: VisionJob = {
      job_id: jobId,
      video_id: videoId,
      original_filename: filename,
      owner,
      status: "QUEUED",
      progress_pct: 5.0,
      total_frames: 0,
      processed_frames: 0,
      duration_seconds: 0,
      fps: 0,
      width: 0,
      height: 0,
      model_name: YOLO11_MODEL_LABEL,
      model_status: "initializing",
      provenance: "YOLOV11_ONNX_LOCAL",
      camera_config: cameraConfig,
      confidence_summary: null,
      created_at: nowIso(),
      completed_at: null,
      output_video_path: stored.file_path,
      error_message: null,
      results: null,
    };

    this.saveJob(job);

    // Launch genuine background FFprobe + FFmpeg + Ultralytics YOLOv11s ONNX + IoU tracking analysis
    const runPromise = this.executeJobPipeline(job, stored, cameraRec).finally(() => {
      this.activeJobPromises.delete(jobId);
    });
    this.activeJobPromises.set(jobId, runPromise);

    return {
      code: 200,
      body: {
        success: true,
        status: "success",
        message: "Video analysis job queued and running.",
        timestamp: nowIso(),
        data: {
          job_id: job.job_id,
          video_id: job.video_id,
          status: job.status,
          progress_pct: job.progress_pct,
          simulation_mode: false,
          camera_id: cameraId || null,
          owner: job.owner,
        },
      },
    };
  }

  public async waitForJob(jobId: string, timeoutMs = 90_000): Promise<VisionJob | null> {
    const active = this.activeJobPromises.get(jobId);
    if (active) {
      await Promise.race([
        active,
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }
    return this.loadJob(jobId);
  }

  private async executeJobPipeline(
    job: VisionJob,
    stored: StoredVideo,
    cameraRec: CameraRecord | null
  ): Promise<void> {
    let tempDir: string | null = null;
    try {
      const tStart = performance.now();
      job.status = "PROCESSING";
      job.progress_pct = 12;
      job.model_status = "probing_video";
      this.saveJob(job);

      // 1. Real FFprobe video inspection
      const meta = await probeVideoMetadata(stored.file_path);
      job.width = meta.width;
      job.height = meta.height;
      job.fps = meta.fps;
      job.duration_seconds = meta.duration_seconds;
      job.total_frames = meta.total_frames;
      job.progress_pct = 28;
      job.model_status = "extracting_keyframes";
      this.saveJob(job);

      // 2. Real FFmpeg keyframe extraction (~1.0 FPS, up to 30 high-res keyframes)
      const extracted = await extractKeyframes(stored.file_path, meta, 30);
      tempDir = extracted.tempDir;
      job.progress_pct = 30;
      job.processed_frames = 0;
      job.model_status = "running_vision_inference";
      this.saveJob(job);

      // 3. Real local Ultralytics YOLOv11s ONNX inference + IoU Multi-Object Tracker (zero external API keys, zero dummy fallbacks)
      const isCalibrated = Boolean(cameraRec?.is_homography_calibrated);
      const analysis = await this.frameAnalyzer(extracted.frames, meta, {
        baseDir: this.baseDir,
        pixels_per_meter: cameraRec?.pixels_per_meter,
        is_calibrated: isCalibrated,
        onFrameProgress: (completed, total) => {
          const frac = total > 0 ? completed / total : 1;
          job.progress_pct = roundTo(30 + frac * 60, 1);
          job.processed_frames = Math.round(meta.total_frames * frac);
          this.saveJob(job);
        },
      });

      job.progress_pct = 92;
      job.processed_frames = meta.total_frames;
      this.saveJob(job);

      const elapsedSec = roundTo((performance.now() - tStart) / 1000, 2);
      const { resultsPayload, confidenceSummary, provenanceLabel } = this.buildResultsPayload(
        analysis,
        meta,
        { filename: stored.filename, file_size_bytes: stored.file_size_bytes },
        cameraRec,
        elapsedSec,
        { clientFramePipeline: false }
      );

      job.status = "COMPLETED";
      job.progress_pct = 100.0;
      job.model_name = analysis.model_used;
      job.model_status = "completed";
      job.provenance = provenanceLabel;
      job.confidence_summary = confidenceSummary;
      job.completed_at = nowIso();
      job.results = resultsPayload;
      this.saveJob(job);
    } catch (err) {
      job.status = "FAILED";
      job.model_status = "failed";
      job.error_message = err instanceof Error ? err.message : "Video processing failed.";
      job.completed_at = nowIso();
      this.saveJob(job);
    } finally {
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  private buildResultsPayload(
    analysis: MultimodalAnalysisResult,
    meta: { width: number; height: number; fps: number; duration_seconds: number; total_frames: number; codec: string },
    sourceInfo: { filename: string; file_size_bytes: number },
    cameraRec: CameraRecord | null,
    elapsedSec: number,
    opts?: { clientFramePipeline?: boolean }
  ): {
    resultsPayload: Record<string, unknown>;
    confidenceSummary: {
      detection_threshold: number;
      mean_confidence: number;
      min_confidence: number;
      max_confidence: number;
      total_detections: number;
    };
    provenanceLabel: string;
  } {
    const isCalibrated = Boolean(cameraRec?.is_homography_calibrated);
    const provenanceCode = opts?.clientFramePipeline ? "YOLOV11_ONNX_SERVERLESS" : "YOLOV11_ONNX_LOCAL";
    const provenanceLabel = opts?.clientFramePipeline
      ? "Ultralytics YOLOv11s (ONNX Runtime Serverless) + IoU Multi-Object Tracker"
      : "Ultralytics YOLOv11s (ONNX Runtime) + IoU Multi-Object Tracker";
    const inferenceDevice = opts?.clientFramePipeline
      ? "CPU (ONNX Runtime Serverless)"
      : "CPU (ONNX Runtime Local)";

    const frameList = analysis.frames;
    const numFrames = Math.max(frameList.length, 1);

    let speedSum = 0;
    let occSum = 0;
    let confSum = 0;
    let confFrames = 0;
    let minConf = 1.0;
    let maxConf = 0.0;
    let totalDetections = 0;
    let peakFrameVehicles = 0;
    let sumFrameVehicles = 0;
    const allIncidents: Array<{ type: string; severity: string; message: string; timestamp_sec: number }> = [];

    const sampleTelemetry: Array<Record<string, unknown>> = [];
    const frameDetections: Array<Record<string, unknown>> = [];

    for (const fr of frameList) {
      const frameVeh =
        fr.car + fr.motorcycle + fr.auto_rickshaw + fr.bus + fr.lcv + fr.truck + fr.bicycle;
      totalDetections += frameVeh + fr.pedestrian;
      sumFrameVehicles += frameVeh;
      if (frameVeh > peakFrameVehicles) peakFrameVehicles = frameVeh;

      speedSum += fr.estimated_speed_kmh;
      occSum += fr.lane_occupancy_pct;
      if (fr.mean_confidence > 0) {
        confSum += fr.mean_confidence;
        confFrames++;
        if (fr.mean_confidence < minConf) minConf = fr.mean_confidence;
        if (fr.mean_confidence > maxConf) maxConf = fr.mean_confidence;
      }

      for (const inc of fr.incidents) {
        allIncidents.push({ ...inc, timestamp_sec: fr.timestamp_sec });
      }

      const framePcu = roundTo(
        fr.car * INDO_HCM_PCU.car +
          fr.motorcycle * INDO_HCM_PCU.motorcycle +
          fr.auto_rickshaw * INDO_HCM_PCU.auto_rickshaw +
          fr.bus * INDO_HCM_PCU.bus +
          fr.lcv * INDO_HCM_PCU.lcv +
          fr.truck * INDO_HCM_PCU.truck +
          fr.bicycle * INDO_HCM_PCU.bicycle,
        2
      );

      sampleTelemetry.push({
        frame_idx: Math.round(fr.timestamp_sec * meta.fps),
        timestamp_sec: fr.timestamp_sec,
        vehicle_count: frameVeh,
        pedestrian_count: fr.pedestrian,
        pcu: framePcu,
        speed_kmh: fr.estimated_speed_kmh,
        occupancy_pct: fr.lane_occupancy_pct,
      });

      frameDetections.push({
        frame_index: fr.frame_index,
        timestamp_sec: fr.timestamp_sec,
        vehicle_count: frameVeh,
        pedestrian_count: fr.pedestrian,
        speed_kmh: fr.estimated_speed_kmh,
        occupancy_pct: fr.lane_occupancy_pct,
        class_counts: {
          car: fr.car,
          motorcycle: fr.motorcycle,
          auto_rickshaw: fr.auto_rickshaw,
          bus: fr.bus,
          lcv: fr.lcv,
          truck: fr.truck,
          bicycle: fr.bicycle,
          pedestrian: fr.pedestrian,
        },
        detections: fr.detections,
      });
    }

    const passageEvents: Array<Record<string, unknown>> = [];
    let passageSeq = 1;
    if (Array.isArray(analysis.tracks) && analysis.tracks.length > 0) {
      for (const tr of analysis.tracks) {
        if (tr.class_name === "pedestrian") continue;
        const gateName =
          tr.crossed_gate_a && tr.crossed_gate_b
            ? "Gate_A_to_Gate_B"
            : tr.crossed_gate_b
              ? "Mainline_Gate_B"
              : "Mainline_Gate_A";
        passageEvents.push({
          passage_id: `P${String(passageSeq).padStart(4, "0")}`,
          track_id: tr.track_id,
          class_name: tr.class_name,
          tripwire_name: gateName,
          direction: tr.direction,
          timestamp_sec: tr.first_seen_sec,
          speed_kmh: tr.speed_kmh,
          frame_idx: Math.round(tr.first_seen_sec * meta.fps),
        });
        passageSeq++;
      }
    } else {
      for (const fr of frameList) {
        const classesInFrame: Array<[string, number]> = [
          ["car", fr.car],
          ["motorcycle", fr.motorcycle],
          ["auto_rickshaw", fr.auto_rickshaw],
          ["bus", fr.bus],
          ["lcv", fr.lcv],
          ["truck", fr.truck],
          ["bicycle", fr.bicycle],
        ];
        for (const [clsName, cnt] of classesInFrame) {
          for (let k = 0; k < cnt; k++) {
            passageEvents.push({
              passage_id: `P${String(passageSeq).padStart(4, "0")}`,
              track_id: passageSeq,
              class_name: clsName,
              tripwire_name: "Mainline_Gate_A",
              direction: analysis.dominant_flow_direction,
              timestamp_sec: fr.timestamp_sec,
              speed_kmh: fr.estimated_speed_kmh,
              frame_idx: Math.round(fr.timestamp_sec * meta.fps),
            });
            passageSeq++;
          }
        }
      }
    }

    const uniqueClassCounts: Record<string, number> = {
      car: Math.max(0, Math.round(analysis.unique_class_counts.car)),
      motorcycle: Math.max(0, Math.round(analysis.unique_class_counts.motorcycle)),
      auto_rickshaw: Math.max(0, Math.round(analysis.unique_class_counts.auto_rickshaw)),
      bus: Math.max(0, Math.round(analysis.unique_class_counts.bus)),
      lcv: Math.max(0, Math.round(analysis.unique_class_counts.lcv)),
      truck: Math.max(0, Math.round(analysis.unique_class_counts.truck)),
      bicycle: Math.max(0, Math.round(analysis.unique_class_counts.bicycle)),
      pedestrian: Math.max(0, Math.round(analysis.unique_class_counts.pedestrian)),
    };

    const totalUnique =
      uniqueClassCounts.car +
      uniqueClassCounts.motorcycle +
      uniqueClassCounts.auto_rickshaw +
      uniqueClassCounts.bus +
      uniqueClassCounts.lcv +
      uniqueClassCounts.truck +
      uniqueClassCounts.bicycle;

    const totalPcu = roundTo(
      uniqueClassCounts.car * INDO_HCM_PCU.car +
        uniqueClassCounts.motorcycle * INDO_HCM_PCU.motorcycle +
        uniqueClassCounts.auto_rickshaw * INDO_HCM_PCU.auto_rickshaw +
        uniqueClassCounts.bus * INDO_HCM_PCU.bus +
        uniqueClassCounts.lcv * INDO_HCM_PCU.lcv +
        uniqueClassCounts.truck * INDO_HCM_PCU.truck +
        uniqueClassCounts.bicycle * INDO_HCM_PCU.bicycle,
      1
    );

    const dirSum = analysis.inbound_count + analysis.outbound_count;
    let inboundCount = analysis.inbound_count;
    let outboundCount = analysis.outbound_count;
    if (dirSum > 0 && dirSum !== totalUnique) {
      inboundCount = Math.round((analysis.inbound_count / dirSum) * totalUnique);
      outboundCount = Math.max(0, totalUnique - inboundCount);
    } else if (dirSum === 0 && totalUnique > 0) {
      inboundCount = totalUnique;
      outboundCount = 0;
    }

    const durationHours = Math.max(meta.duration_seconds / 3600, 1 / 3600);
    const pcuPerHour = Math.round(totalPcu / durationHours);
    const avgSpeed = roundTo(speedSum / numFrames, 1);
    const avgOcc = roundTo(occSum / numFrames, 1);
    const meanConf = confFrames > 0 ? roundTo(confSum / confFrames, 3) : 0;
    if (confFrames === 0) {
      minConf = 0;
      maxConf = 0;
    }
    const avgFrameVehicles = roundTo(sumFrameVehicles / numFrames, 1);

    const densityLevel =
      avgOcc >= 72 || (avgSpeed > 0 && avgSpeed < 15)
        ? "Severe"
        : avgOcc >= 50 || (avgSpeed > 0 && avgSpeed < 24)
          ? "High"
          : avgOcc >= 28 || (avgSpeed > 0 && avgSpeed < 36)
            ? "Moderate"
            : "Low";

    const losGrade =
      densityLevel === "Severe"
        ? "LOS F"
        : densityLevel === "High"
          ? "LOS D"
          : densityLevel === "Moderate"
            ? "LOS C"
            : "LOS B";

    const vpm = roundTo((totalUnique / Math.max(meta.duration_seconds, 1)) * 60, 1);
    const headwaySec = totalUnique > 0 ? roundTo(meta.duration_seconds / totalUnique, 2) : 0;
    const corridorSpanMeters = cameraRec?.is_homography_calibrated ? 50 : 40;
    const fallbackTransitDurSec = avgSpeed > 0.5 ? roundTo(corridorSpanMeters / (avgSpeed / 3.6), 1) : 0;
    const observedGateTransitions =
      analysis.gate_transitions_count != null && analysis.gate_transitions_count > 0
        ? analysis.gate_transitions_count
        : totalUnique;
    const medianTransitDurSec =
      analysis.median_gate_transit_sec != null && analysis.median_gate_transit_sec > 0
        ? analysis.median_gate_transit_sec
        : fallbackTransitDurSec;

    const confidenceSummary = {
      detection_threshold: 0.25,
      mean_confidence: meanConf,
      min_confidence: roundTo(minConf, 3),
      max_confidence: roundTo(maxConf, 3),
      total_detections: totalDetections,
    };

    const resultsPayload: Record<string, unknown> = {
      provenance: provenanceLabel,
      processing_provenance: provenanceCode,
      client_frame_pipeline: Boolean(opts?.clientFramePipeline),
      is_simulation: false,
      scene_summary: analysis.scene_summary,
      disclaimer:
        "Ultralytics YOLOv11s (ONNX) object detection with IoU multi-object tracking and Indo-HCM PCU conversion.",
      confidence_summary: confidenceSummary,
      processing_metrics: {
        detector_engine: analysis.model_used,
        inference_device: inferenceDevice,
        keyframes_analyzed: frameList.length,
        processing_time_sec: elapsedSec,
      },
      source_video: {
        filename: sourceInfo.filename,
        file_size_bytes: sourceInfo.file_size_bytes,
        resolution: `${meta.width}x${meta.height}`,
        codec: meta.codec,
        fps: meta.fps,
        effective_fps: roundTo(frameList.length / Math.max(meta.duration_seconds, 1), 2),
        frame_stride_applied: Math.max(1, Math.round(meta.total_frames / numFrames)),
        total_source_frames: meta.total_frames,
        total_frames_analyzed: frameList.length,
        video_duration_seconds: meta.duration_seconds,
      },
      total_unique_vehicles: totalUnique,
      pedestrian_count: uniqueClassCounts.pedestrian,
      peak_frame_vehicles: peakFrameVehicles,
      avg_frame_vehicles: avgFrameVehicles,
      class_counts: uniqueClassCounts,
      direction_counts: {
        inbound: inboundCount,
        outbound: outboundCount,
        dominant: analysis.dominant_flow_direction,
      },
      pcu_telemetry: {
        total_pcu: totalPcu,
        pcu_per_hour: pcuPerHour,
        hourly_flow_pcu_per_hr: pcuPerHour,
        congestion_level: densityLevel,
        los_grade: losGrade,
      },
      kinematics: {
        space_mean_speed_kmh: avgSpeed,
        calibration_status: isCalibrated ? "CALIBRATED" : "UNCALIBRATED",
        calibration_note: isCalibrated
          ? `Speed grounded via 4-point planar homography (${cameraRec?.camera_id}, ${cameraRec?.pixels_per_meter} px/m).`
          : "Speed estimated via perspective vehicle-length scaling across tracked frames; assign a calibrated camera ID for planar homography.",
      },
      traffic_density: {
        average_occupancy_pct: avgOcc,
        peak_density_level: densityLevel,
        avg_density_veh_per_km: avgSpeed > 2 ? roundTo(pcuPerHour / avgSpeed, 1) : 0,
      },
      density_metrics: {
        avg_density_veh_per_km: avgSpeed > 2 ? roundTo(pcuPerHour / avgSpeed, 1) : 0,
        peak_density_veh_per_km: avgSpeed > 2 ? roundTo((pcuPerHour / avgSpeed) * 1.25, 1) : 0,
        average_speed_kmh: avgSpeed,
      },
      route_flow: {
        transitions_count: observedGateTransitions,
        transit_frequency_vpm: vpm,
        average_headway_sec: headwaySec,
        median_transit_duration_sec: medianTransitDurSec,
      },
      incident_summary: {
        count: allIncidents.length,
        incidents: allIncidents,
      },
      incidents: allIncidents,
      sample_telemetry: sampleTelemetry,
      frame_detections: frameDetections,
      passage_events: passageEvents,
    };

    return { resultsPayload, confidenceSummary, provenanceLabel };
  }

  public async analyzeClientFrameBatch(body: Record<string, unknown>) {
    const rawFrames = Array.isArray(body.frames) ? body.frames : [];
    if (rawFrames.length === 0) {
      return {
        code: 400,
        body: { success: false, status: "error", message: "At least one extracted frame is required.", timestamp: nowIso() },
      };
    }
    if (rawFrames.length > 8) {
      return {
        code: 400,
        body: { success: false, status: "error", message: "Maximum 8 frames per batch.", timestamp: nowIso() },
      };
    }

    const width = Math.max(64, Math.round(Number(body.width) || 960));
    const height = Math.max(64, Math.round(Number(body.height) || 540));

    const parsedFrames: Array<{ frame_index: number; timestamp_sec: number; buffer: Buffer }> = [];
    for (let i = 0; i < rawFrames.length; i++) {
      const item = rawFrames[i] as Record<string, unknown> | null;
      if (!item || typeof item !== "object") continue;
      const rawB64 = String(item.image_base64 || "");
      const cleanB64 = rawB64.includes(",") ? rawB64.slice(rawB64.indexOf(",") + 1) : rawB64;
      if (!cleanB64) continue;
      const buf = Buffer.from(cleanB64, "base64");
      if (buf.length === 0) continue;
      parsedFrames.push({
        frame_index: Math.max(0, Math.round(Number(item.frame_index ?? i))),
        timestamp_sec: roundTo(Math.max(0, Number(item.timestamp_sec ?? 0)), 3),
        buffer: buf,
      });
    }

    if (parsedFrames.length === 0) {
      return {
        code: 400,
        body: { success: false, status: "error", message: "No valid image buffers in batch.", timestamp: nowIso() },
      };
    }

    try {
      const result = await detectImageBuffersWithYolo11(
        parsedFrames,
        { width, height },
        { baseDir: this.baseDir }
      );
      return {
        code: 200,
        body: {
          success: true,
          status: "success",
          timestamp: nowIso(),
          data: result,
        },
      };
    } catch (err) {
      return {
        code: 500,
        body: {
          success: false,
          status: "error",
          message: err instanceof Error ? err.message : "YOLOv11s frame inference failed.",
          timestamp: nowIso(),
        },
      };
    }
  }

  public finalizeClientFrameJob(body: Record<string, unknown>, owner = "traffic_admin") {
    const rawDetFrames = Array.isArray(body.frame_detections) ? body.frame_detections : [];
    if (rawDetFrames.length === 0) {
      return {
        code: 400,
        body: { success: false, status: "error", message: "No frame_detections provided.", timestamp: nowIso() },
      };
    }

    const tStart = performance.now();
    const width = Math.max(64, Math.round(Number(body.width) || 960));
    const height = Math.max(64, Math.round(Number(body.height) || 540));
    const fps = Math.max(1, Math.min(120, Number(body.fps) || 30));
    const durationSec = Math.max(0.5, Number(body.duration_seconds) || rawDetFrames.length);
    const totalFrames = Math.max(rawDetFrames.length, Math.round(durationSec * fps));
    const filename = path.basename(String(body.filename || "uploaded_traffic.mp4")).replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileSizeBytes = Math.max(0, Math.round(Number(body.file_size_bytes) || 0));
    const cameraId = String(body.camera_id || "").trim();
    const cameraRec = cameraId ? this.cameraRegistry.get(cameraId) : null;
    const modelUsed = String(body.model_used || "Ultralytics YOLO11S (ONNX)");

    const frameInputs: FrameDetectionsInput[] = rawDetFrames
      .map((item, idx) => {
        const rec = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        const dets = Array.isArray(rec.detections) ? (rec.detections as DetectionBox[]) : [];
        return {
          frame_index: Math.max(0, Math.round(Number(rec.frame_index ?? idx))),
          timestamp_sec: roundTo(Math.max(0, Number(rec.timestamp_sec ?? 0)), 3),
          detections: dets,
        };
      })
      .sort((a, b) => a.timestamp_sec - b.timestamp_sec);

    const analysis = trackAndAnalyzeFrames(
      frameInputs,
      { width, height, fps, duration_seconds: durationSec, total_frames: totalFrames },
      {
        model_used: modelUsed,
        pixels_per_meter: cameraRec?.pixels_per_meter,
        is_calibrated: Boolean(cameraRec?.is_homography_calibrated),
      }
    );

    const elapsedSec = roundTo(
      Math.max(Number(body.client_elapsed_sec) || 0, (performance.now() - tStart) / 1000),
      2
    );
    const meta = {
      width,
      height,
      fps,
      duration_seconds: roundTo(durationSec, 2),
      total_frames: totalFrames,
      codec: "browser-decoded",
    };

    const { resultsPayload, confidenceSummary, provenanceLabel } = this.buildResultsPayload(
      analysis,
      meta,
      { filename, file_size_bytes: fileSizeBytes },
      cameraRec,
      elapsedSec,
      { clientFramePipeline: true }
    );

    const videoId = `vid_${crypto.randomBytes(6).toString("hex")}`;
    const jobId = `cv_${crypto.randomBytes(5).toString("hex")}`;
    const job: VisionJob = {
      job_id: jobId,
      video_id: videoId,
      original_filename: filename,
      owner,
      status: "COMPLETED",
      progress_pct: 100.0,
      total_frames: totalFrames,
      processed_frames: totalFrames,
      duration_seconds: meta.duration_seconds,
      fps,
      width,
      height,
      model_name: analysis.model_used,
      model_status: "completed",
      provenance: provenanceLabel,
      camera_config: cameraRec ? (cameraRec as unknown as Record<string, unknown>) : null,
      confidence_summary: confidenceSummary,
      created_at: nowIso(),
      completed_at: nowIso(),
      output_video_path: null,
      error_message: null,
      results: resultsPayload,
    };

    this.saveJob(job);

    return {
      code: 200,
      body: {
        success: true,
        status: "success",
        message: "YOLOv11s frame analysis finalized.",
        timestamp: nowIso(),
        data: {
          job_id: jobId,
          video_id: videoId,
          results: resultsPayload,
        },
      },
    };
  }

  public getJob(jobId: string) {
    const job = this.loadJob(jobId);
    if (!job) {
      return { code: 404, body: { success: false, status: "error", message: `Job '${jobId}' not found.`, timestamp: nowIso() } };
    }
    return {
      code: 200,
      body: {
        success: true,
        status: "success",
        message: `Job status is ${job.status}`,
        timestamp: nowIso(),
        data: job,
      },
    };
  }

  public getResults(jobId: string) {
    const job = this.loadJob(jobId);
    if (!job) {
      return { code: 404, body: { success: false, status: "error", message: `Job '${jobId}' not found.`, timestamp: nowIso() } };
    }
    if (job.status === "FAILED") {
      return { code: 400, body: { success: false, status: "error", message: `Job failed: ${job.error_message}`, timestamp: nowIso() } };
    }
    if (job.status !== "COMPLETED" || !job.results) {
      return {
        code: 202,
        body: {
          success: true,
          status: "processing",
          message: `Job is currently ${job.status} (${job.progress_pct}%).`,
          timestamp: nowIso(),
          data: null,
        },
      };
    }
    return {
      code: 200,
      body: {
        success: true,
        status: "success",
        message: "Video analysis completed.",
        timestamp: nowIso(),
        data: job.results,
      },
    };
  }

  public getVideoFilePath(jobId: string): string | null {
    const job = this.loadJob(jobId);
    if (job?.output_video_path && fs.existsSync(job.output_video_path)) {
      return job.output_video_path;
    }
    return null;
  }

  public exportTelemetry(jobId: string, formatType = "csv") {
    const job = this.loadJob(jobId);
    if (!job || job.status !== "COMPLETED" || !job.results) {
      return { code: 404, contentType: "text/plain", filename: "error.txt", body: "Job results not found." };
    }
    const results = job.results;
    const passages = Array.isArray(results.passage_events)
      ? (results.passage_events as Array<Record<string, unknown>>)
      : [];

    if (formatType.toLowerCase() === "json") {
      return {
        code: 200,
        contentType: "application/json; charset=utf-8",
        filename: `telemetry_${jobId}.json`,
        body: JSON.stringify(
          {
            success: true,
            job_id: jobId,
            video_id: job.video_id,
            timestamp: nowIso(),
            data: {
              total_unique_vehicles: results.total_unique_vehicles ?? 0,
              class_counts: results.class_counts ?? {},
              pcu_telemetry: results.pcu_telemetry ?? {},
              kinematics: results.kinematics ?? {},
              passage_events: passages,
            },
          },
          null,
          2
        ),
      };
    }

    const lines = ["passage_id,track_id,class_name,tripwire_name,direction,timestamp_sec,speed_kmh,frame_idx"];
    for (const ev of passages) {
      lines.push(
        `${ev.passage_id ?? ""},${ev.track_id ?? ""},${ev.class_name ?? ""},${ev.tripwire_name ?? ""},${ev.direction ?? ""},${ev.timestamp_sec ?? ""},${ev.speed_kmh ?? ""},${ev.frame_idx ?? ""}`
      );
    }
    return {
      code: 200,
      contentType: "text/csv; charset=utf-8",
      filename: `passage_telemetry_${jobId}.csv`,
      body: lines.join("\n") + "\n",
    };
  }

  public actuateLiveGrid(
    body: Record<string, unknown>,
    actor = "traffic_admin",
    forecastOverride?: { predicted_congestion: string; probabilities?: Record<string, number> }
  ) {
    const corridorId = normalizeCorridorId(String(body.corridor_id || body.road_id || "RD_BLR_01"));
    const roadId = ROAD_REGISTRY[corridorId] ? corridorId : "RD_BLR_01";
    const roadName = getRoadName(roadId);
    const metrics = (body.vision_metrics && typeof body.vision_metrics === "object"
      ? (body.vision_metrics as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    const pcuObj = (metrics.pcu_telemetry && typeof metrics.pcu_telemetry === "object"
      ? (metrics.pcu_telemetry as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    const densObj = (metrics.traffic_density && typeof metrics.traffic_density === "object"
      ? (metrics.traffic_density as Record<string, unknown>)
      : {}) as Record<string, unknown>;

    const totalPcu = Math.max(0, Number(pcuObj.total_pcu ?? metrics.total_unique_vehicles ?? 0));
    const densityLevel = String(densObj.peak_density_level ?? densObj.level ?? "Moderate");
    const defaultExt = densityLevel === "Severe" ? 15 : densityLevel === "High" ? 10 : densityLevel === "Moderate" ? 5 : 0;
    const greenExt = Math.max(0, Math.min(20, Number(body.green_extension_sec ?? defaultExt)));
    const hourlyPcu = Math.min(
      3600,
      Math.max(250, Math.round(Number(pcuObj.hourly_flow_pcu_per_hr ?? totalPcu * 24)))
    );
    const satFlow = 3400;
    const yNs = Math.min(0.48, Math.max(0.12, hourlyPcu / satFlow));
    const yEw = Math.min(0.36, Math.max(0.1, (hourlyPcu * 0.65) / satFlow));
    const Y = Math.min(0.85, yNs + yEw);
    const L = 12;
    const optimalCycle = Math.min(150, Math.max(45, Math.round((1.5 * L + 5) / (1 - Y))));
    const effGreen = Math.max(20, optimalCycle - L);
    const nsGreen = Math.min(effGreen - 10, Math.max(12, Math.round(effGreen * (yNs / Y) + greenExt * 0.4)));
    const ewGreen = Math.max(10, effGreen - nsGreen);
    const createdAt = nowIso();

    this.appDb.db
      .prepare(
        `INSERT INTO actuation_logs (corridor_id, road_name, green_extension_sec, applied_mode, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(roadId, roadName, greenExt, "ADVISORY_SIMULATION_LOG", actor, createdAt);

    return {
      code: 200,
      body: {
        success: true,
        status: "success",
        message: `Advisory signal timing recommendation persisted for ${roadName} (+${greenExt}s green extension).`,
        is_advisory_only: true,
        data: {
          corridor_id: roadId,
          road_id: roadId,
          road_name: roadName,
          recommended_green_extension_sec: greenExt,
          applied_mode: "ADVISORY_SIMULATION_LOG",
          actor,
          next_hour_forecast: forecastOverride ?? {
            predicted_congestion: densityLevel,
          },
          webster_signal_actuation: {
            optimal_cycle_sec: optimalCycle,
            optimal_cycle_seconds: optimalCycle,
            ns_green_sec: nsGreen,
            effective_green_seconds: nsGreen,
            ew_green_sec: ewGreen,
            phase_extension_sec: greenExt,
            saturation_ratio_Y: roundTo(Y, 3),
          },
          timestamp: createdAt,
        },
        timestamp: createdAt,
      },
    };
  }
}
