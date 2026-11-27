import fs from "node:fs";
import path from "node:path";
import type * as Ort from "onnxruntime-node";
import sharp from "sharp";
import { roundTo } from "./physics.ts";
import {
  trackAndAnalyzeFrames,
  type DetectionBox,
  type FrameDetectionsInput,
  type RoadUserClass,
  type TrackerAnalysisResult,
} from "./cvTracker.ts";

const YOLO11_INPUT_SIZE = 832; // Divisible by 32; optimal accuracy/speed on CPU
const CONFIDENCE_THRESHOLD = 0.25;

// Standard COCO class IDs relevant to urban road traffic
const COCO_TO_TRAFFIC_CLASS: Record<number, RoadUserClass> = {
  0: "pedestrian",
  1: "bicycle",
  2: "car",
  3: "motorcycle",
  5: "bus",
  7: "truck",
};

interface CachedSession {
  modelPath: string;
  session: Ort.InferenceSession;
}

let cachedSession: CachedSession | null = null;
let loadingPromise: Promise<Ort.InferenceSession> | null = null;
let cachedOrt: typeof Ort | null = null;

async function loadOrt(): Promise<typeof Ort> {
  if (!cachedOrt) {
    cachedOrt = await import("onnxruntime-node");
  }
  return cachedOrt;
}

export function resolveYolo11ModelPath(baseDir: string): string {
  const candidates = [
    path.join(baseDir, "models", "yolo11", "yolo11s.onnx"),
    path.join(baseDir, "models", "yolo11", "yolo11n.onnx"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

export function isYolo11ModelReady(baseDir: string): boolean {
  return fs.existsSync(resolveYolo11ModelPath(baseDir));
}

async function getYolo11Session(baseDir: string): Promise<{ session: Ort.InferenceSession; modelName: string }> {
  const modelPath = resolveYolo11ModelPath(baseDir);
  if (!fs.existsSync(modelPath)) {
    throw new Error(`YOLOv11 ONNX model weights not found at ${modelPath}.`);
  }
  const modelName = path.basename(modelPath, ".onnx");

  if (cachedSession && cachedSession.modelPath === modelPath) {
    return { session: cachedSession.session, modelName };
  }
  if (!loadingPromise) {
    loadingPromise = loadOrt()
      .then((ort) =>
        ort.InferenceSession.create(modelPath, {
          executionProviders: ["cpu"],
          graphOptimizationLevel: "all",
        })
      )
      .then((session) => {
        cachedSession = { modelPath, session };
        return session;
      })
      .finally(() => {
        loadingPromise = null;
      });
  }
  const session = await loadingPromise;
  return { session, modelName };
}

/**
 * Inspects actual RGB pixel colors inside a detected vehicle bounding box
 * in the letterboxed RGB buffer to classify distinctive Indian yellow/green
 * auto-rickshaw canopies and compact boxy LCV vans without inventing boxes.
 */
function refineIndianTrafficClass(
  baseClass: RoadUserClass,
  x1Letterbox: number,
  y1Letterbox: number,
  x2Letterbox: number,
  y2Letterbox: number,
  rgbData: Buffer,
  imgSize: number
): RoadUserClass {
  if (baseClass !== "car" && baseClass !== "truck") return baseClass;

  const bw = Math.max(1, x2Letterbox - x1Letterbox);
  const bh = Math.max(1, y2Letterbox - y1Letterbox);
  const aspect = bw / bh;

  // Sample actual pixels inside the upper 60% of the detected vehicle box
  const sx1 = Math.max(0, Math.floor(x1Letterbox + bw * 0.12));
  const sx2 = Math.min(imgSize - 1, Math.ceil(x2Letterbox - bw * 0.12));
  const sy1 = Math.max(0, Math.floor(y1Letterbox + bh * 0.06));
  const sy2 = Math.min(imgSize - 1, Math.ceil(y1Letterbox + bh * 0.62));

  let totalSampled = 0;
  let autoCanopyHits = 0;
  const stepX = Math.max(1, Math.floor((sx2 - sx1) / 14));
  const stepY = Math.max(1, Math.floor((sy2 - sy1) / 10));

  for (let y = sy1; y <= sy2; y += stepY) {
    for (let x = sx1; x <= sx2; x += stepX) {
      const idx = (y * imgSize + x) * 3;
      const r = rgbData[idx];
      const g = rgbData[idx + 1];
      const b = rgbData[idx + 2];
      totalSampled++;

      // Iconic Indian auto-rickshaw yellow/amber roof or bright green body
      const isAutoYellow = r >= 165 && g >= 120 && b <= 95 && r - b >= 75;
      const isAutoGreen = g >= 95 && g - r >= 18 && g - b >= 22 && r <= 135;
      if (isAutoYellow || isAutoGreen) {
        autoCanopyHits++;
      }
    }
  }

  const canopyRatio = totalSampled > 0 ? autoCanopyHits / totalSampled : 0;

  // Compact three-wheeler proportion + yellow/green auto-rickshaw canopy pixels
  if (canopyRatio >= 0.16 && aspect >= 0.45 && aspect <= 1.55 && bw < imgSize * 0.34) {
    return "auto_rickshaw";
  }

  // Distinguish light commercial vehicles (vans / tempos / pickups) from heavy trucks by footprint
  if (baseClass === "truck") {
    const normArea = (bw * bh) / (imgSize * imgSize);
    if (normArea < 0.085 && aspect >= 0.7 && aspect <= 1.85) {
      return "lcv";
    }
  }

  return baseClass;
}

async function detectFrameWithYolo11(
  session: Ort.InferenceSession,
  frameInput: string | Buffer,
  origWidth: number,
  origHeight: number
): Promise<DetectionBox[]> {
  const size = YOLO11_INPUT_SIZE;
  const imgMeta = await sharp(frameInput).metadata();
  const imgW = imgMeta.width && imgMeta.width > 0 ? imgMeta.width : origWidth;
  const imgH = imgMeta.height && imgMeta.height > 0 ? imgMeta.height : origHeight;

  const scale = Math.min(size / imgW, size / imgH);
  const resizedW = Math.round(imgW * scale);
  const resizedH = Math.round(imgH * scale);
  const padX = Math.floor((size - resizedW) / 2);
  const padY = Math.floor((size - resizedH) / 2);

  const { data } = await sharp(frameInput)
    .resize(size, size, {
      fit: "contain",
      background: { r: 114, g: 114, b: 114, alpha: 1 },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const area = size * size;
  const floatData = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    const base = i * 3;
    floatData[i] = data[base] / 255.0;
    floatData[area + i] = data[base + 1] / 255.0;
    floatData[2 * area + i] = data[base + 2] / 255.0;
  }

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const ort = await loadOrt();
  const tensor = new ort.Tensor("float32", floatData, [1, 3, size, size]);
  const outputs = await session.run({ [inputName]: tensor });
  const out = outputs[outputName];
  const arr = out.data as Float32Array;
  const dims = out.dims;

  const detections: DetectionBox[] = [];

  if (dims.length === 3 && dims[2] === 6) {
    // End-to-end NMS YOLOv11 output: [1, 300, 6] => [x1, y1, x2, y2, score, classId]
    const numRows = dims[1];
    for (let i = 0; i < numRows; i++) {
      const off = i * 6;
      const score = arr[off + 4];
      if (score < CONFIDENCE_THRESHOLD) continue;
      const clsId = Math.round(arr[off + 5]);
      const mapped = COCO_TO_TRAFFIC_CLASS[clsId];
      if (!mapped) continue;

      const lx1 = arr[off];
      const ly1 = arr[off + 1];
      const lx2 = arr[off + 2];
      const ly2 = arr[off + 3];

      // Un-project from letterbox 832x832 back to exact frame [0..1000]
      const ox1 = (lx1 - padX) / scale;
      const oy1 = (ly1 - padY) / scale;
      const ox2 = (lx2 - padX) / scale;
      const oy2 = (ly2 - padY) / scale;

      const xmin = Math.max(0, Math.min(995, Math.round((ox1 / imgW) * 1000)));
      const ymin = Math.max(0, Math.min(995, Math.round((oy1 / imgH) * 1000)));
      const xmax = Math.max(xmin + 5, Math.min(1000, Math.round((ox2 / imgW) * 1000)));
      const ymax = Math.max(ymin + 5, Math.min(1000, Math.round((oy2 / imgH) * 1000)));

      // Skip degenerate tiny noise boxes
      if (xmax - xmin < 10 || ymax - ymin < 10) continue;

      const refinedClass = refineIndianTrafficClass(mapped, lx1, ly1, lx2, ly2, data, size);
      detections.push({
        class_name: refinedClass,
        confidence: roundTo(Math.min(0.99, score), 3),
        box_2d: [ymin, xmin, ymax, xmax],
      });
    }
  } else if (dims.length === 3 && dims[1] === 84) {
    // Standard raw Ultralytics YOLOv11 output: [1, 84, 8400] => [cx, cy, w, h, 80 class scores]
    const numBoxes = dims[2];
    const targetIds = Object.keys(COCO_TO_TRAFFIC_CLASS).map(Number);
    for (let i = 0; i < numBoxes; i++) {
      let bestCls = -1;
      let bestScore = CONFIDENCE_THRESHOLD;
      for (const cid of targetIds) {
        const s = arr[(4 + cid) * numBoxes + i];
        if (s > bestScore) {
          bestScore = s;
          bestCls = cid;
        }
      }
      if (bestCls < 0) continue;
      const mapped = COCO_TO_TRAFFIC_CLASS[bestCls];
      const cx = arr[0 * numBoxes + i];
      const cy = arr[1 * numBoxes + i];
      const w = arr[2 * numBoxes + i];
      const h = arr[3 * numBoxes + i];
      const lx1 = cx - w / 2;
      const ly1 = cy - h / 2;
      const lx2 = cx + w / 2;
      const ly2 = cy + h / 2;

      const ox1 = (lx1 - padX) / scale;
      const oy1 = (ly1 - padY) / scale;
      const ox2 = (lx2 - padX) / scale;
      const oy2 = (ly2 - padY) / scale;

      const xmin = Math.max(0, Math.min(995, Math.round((ox1 / imgW) * 1000)));
      const ymin = Math.max(0, Math.min(995, Math.round((oy1 / imgH) * 1000)));
      const xmax = Math.max(xmin + 5, Math.min(1000, Math.round((ox2 / imgW) * 1000)));
      const ymax = Math.max(ymin + 5, Math.min(1000, Math.round((oy2 / imgH) * 1000)));
      if (xmax - xmin < 10 || ymax - ymin < 10) continue;

      const refinedClass = refineIndianTrafficClass(mapped, lx1, ly1, lx2, ly2, data, size);
      detections.push({
        class_name: refinedClass,
        confidence: roundTo(Math.min(0.99, bestScore), 3),
        box_2d: [ymin, xmin, ymax, xmax],
      });
    }
  } else {
    throw new Error(`Unsupported YOLOv11 ONNX output tensor dimensions: [${dims.join(", ")}]`);
  }

  return detections;
}

export async function analyzeFramesWithYolo11(
  frames: Array<{ index: number; timestamp_sec: number; filePath: string }>,
  meta: { width: number; height: number; fps: number; duration_seconds: number; total_frames: number },
  options?: {
    baseDir?: string;
    pixels_per_meter?: number;
    is_calibrated?: boolean;
    onFrameProgress?: (completed: number, total: number) => void;
  }
): Promise<TrackerAnalysisResult> {
  const baseDir = options?.baseDir ?? process.cwd();
  const { session, modelName } = await getYolo11Session(baseDir);

  const frameInputs: FrameDetectionsInput[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const detections = await detectFrameWithYolo11(session, f.filePath, meta.width, meta.height);
    frameInputs.push({
      frame_index: f.index,
      timestamp_sec: f.timestamp_sec,
      detections,
    });
    if (options?.onFrameProgress) {
      options.onFrameProgress(i + 1, frames.length);
    }
  }

  return trackAndAnalyzeFrames(frameInputs, meta, {
    model_used: `Ultralytics ${modelName.toUpperCase()} (ONNX)`,
    pixels_per_meter: options?.pixels_per_meter,
    is_calibrated: options?.is_calibrated,
  });
}

export async function detectImageBuffersWithYolo11(
  frames: Array<{ frame_index: number; timestamp_sec: number; buffer: Buffer }>,
  meta: { width: number; height: number },
  options?: { baseDir?: string }
): Promise<{ model_used: string; frames: FrameDetectionsInput[] }> {
  const baseDir = options?.baseDir ?? process.cwd();
  const { session, modelName } = await getYolo11Session(baseDir);

  const outFrames: FrameDetectionsInput[] = [];
  for (const f of frames) {
    const detections = await detectFrameWithYolo11(session, f.buffer, meta.width, meta.height);
    outFrames.push({
      frame_index: f.frame_index,
      timestamp_sec: f.timestamp_sec,
      detections,
    });
  }

  return {
    model_used: `Ultralytics ${modelName.toUpperCase()} (ONNX)`,
    frames: outFrames,
  };
}
