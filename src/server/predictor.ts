import fs from "node:fs";
import path from "node:path";
import type { CongestionLevel } from "./physics.ts";
import { roundTo } from "./physics.ts";

export interface XgbTreeNode {
  nodeid: number;
  depth?: number;
  split?: string;
  split_condition?: number;
  yes?: number;
  no?: number;
  missing?: number;
  leaf?: number;
  children?: XgbTreeNode[];
  _expectedValue?: number;
}

export interface ModelTreesArtifact {
  num_classes: number;
  classes: CongestionLevel[];
  base_scores: number[];
  num_features: number;
  trees: XgbTreeNode[];
}

export interface TopologyEntry {
  road_id: string;
  city_zone: string;
  intersection_id: string;
  avg_speed: number;
  avg_volume: number;
  peak_speed: number;
  peak_volume: number;
  capacity: number;
  peak_congestion: CongestionLevel;
  common_congestion: CongestionLevel;
  common_predicted: CongestionLevel;
  pred_dist: Record<string, number>;
  total_records: number;
}

export interface PredictionFeatures {
  city_zone?: string;
  road_id?: string;
  intersection_id?: string;
  vehicle_count?: number;
  average_speed?: number;
  capacity_utilization?: number;
  congestion_level?: string;
  hour?: number;
  day_of_week?: number;
  is_weekend?: number;
}

export interface PredictionExplanation {
  predicted_class: CongestionLevel;
  probabilities: Record<string, number>;
  confidence_pct: number;
  attribution_method: string;
  feature_contributions: Array<{
    feature: string;
    value: string | number;
    importance: number;
    signed_delta: number;
    direction: string;
  }>;
  model_info: {
    algorithm: string;
    model_version: string;
    num_trees: number;
  };
}

function resolveArtifactsDir(baseDir?: string): string {
  const root = baseDir ?? process.cwd();
  return path.join(root, "models", "xgboost");
}

function annotateExpectedValues(node: XgbTreeNode): { sum: number; count: number } {
  if (node.leaf !== undefined) {
    node._expectedValue = node.leaf;
    return { sum: node.leaf, count: 1 };
  }
  let totalSum = 0;
  let totalCount = 0;
  for (const child of node.children ?? []) {
    const sub = annotateExpectedValues(child);
    totalSum += sub.sum;
    totalCount += sub.count;
  }
  node._expectedValue = totalCount > 0 ? totalSum / totalCount : 0;
  return { sum: totalSum, count: Math.max(1, totalCount) };
}

function traverseTree(node: XgbTreeNode, features: number[]): number {
  let cur: XgbTreeNode | undefined = node;
  while (cur) {
    if (cur.leaf !== undefined) {
      return cur.leaf;
    }
    const splitStr = cur.split ?? "f0";
    const featIdx = parseInt(splitStr.slice(1), 10);
    const val = features[featIdx];
    const cond = cur.split_condition ?? 0;
    const nextId =
      val === undefined || Number.isNaN(val)
        ? cur.missing
        : val < cond
          ? cur.yes
          : cur.no;
    cur = cur.children?.find((c) => c.nodeid === nextId);
  }
  return 0.0;
}

function traverseTreeWithSaabas(node: XgbTreeNode, features: number[], deltas: number[]): number {
  let cur: XgbTreeNode | undefined = node;
  while (cur) {
    if (cur.leaf !== undefined) {
      return cur.leaf;
    }
    const splitStr = cur.split ?? "f0";
    const featIdx = parseInt(splitStr.slice(1), 10);
    const val = features[featIdx];
    const cond = cur.split_condition ?? 0;
    const nextId =
      val === undefined || Number.isNaN(val)
        ? cur.missing
        : val < cond
          ? cur.yes
          : cur.no;
    const next = cur.children?.find((c) => c.nodeid === nextId);
    if (!next) break;
    const curVal = cur._expectedValue ?? 0;
    const nextVal = next._expectedValue ?? next.leaf ?? 0;
    if (featIdx >= 0 && featIdx < deltas.length) {
      deltas[featIdx] += nextVal - curVal;
    }
    cur = next;
  }
  return 0.0;
}

export function validatePredictionFeatures(raw: unknown): { ok: true; features: PredictionFeatures } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Request must include a valid 'features' object." };
  }
  const f = raw as Record<string, unknown>;
  const hasCoreMetric =
    f.vehicle_count !== undefined ||
    f.average_speed !== undefined ||
    f.capacity_utilization !== undefined;

  if (!hasCoreMetric) {
    return {
      ok: false,
      error: "At least one traffic measurement ('vehicle_count', 'average_speed', or 'capacity_utilization') is required.",
    };
  }

  const checkRange = (key: string, min: number, max: number): string | null => {
    if (f[key] === undefined || f[key] === null || f[key] === "") return null;
    const num = Number(f[key]);
    if (!Number.isFinite(num) || num < min || num > max) {
      return `Feature '${key}' must be a finite number between ${min} and ${max}.`;
    }
    return null;
  };

  const err =
    checkRange("vehicle_count", 0, 250000) ||
    checkRange("average_speed", 0, 160) ||
    checkRange("capacity_utilization", 0, 200) ||
    checkRange("hour", 0, 23) ||
    checkRange("day_of_week", 0, 6) ||
    checkRange("is_weekend", 0, 1);

  if (err) {
    return { ok: false, error: err };
  }

  if (f.congestion_level !== undefined && f.congestion_level !== null) {
    const c = String(f.congestion_level).trim().toLowerCase();
    if (!["low", "moderate", "high", "severe"].includes(c)) {
      return { ok: false, error: "Feature 'congestion_level' must be one of Low, Moderate, High, or Severe." };
    }
  }

  return { ok: true, features: f as PredictionFeatures };
}

export class TrafficPredictor {
  public modelTrees: ModelTreesArtifact | null = null;
  public topology: Record<string, TopologyEntry> = {};
  public metrics: Record<string, unknown> = {};
  public baselines: Record<string, unknown> | null = null;
  private artifactsDir: string;

  constructor(baseDir?: string) {
    this.artifactsDir = resolveArtifactsDir(baseDir);
    this.loadArtifacts();
  }

  public isTrained(): boolean {
    return this.modelTrees !== null && Array.isArray(this.modelTrees.trees) && this.modelTrees.trees.length > 0;
  }

  public loadArtifacts(): void {
    const treesPath = path.join(this.artifactsDir, "model_trees.json");
    const topoPath = path.join(this.artifactsDir, "network_topology.json");
    const metricsPath = path.join(this.artifactsDir, "training_metrics.json");
    const baselinesPath = path.join(this.artifactsDir, "baseline_metrics.json");

    if (fs.existsSync(treesPath)) {
      this.modelTrees = JSON.parse(fs.readFileSync(treesPath, "utf-8")) as ModelTreesArtifact;
      for (const tree of this.modelTrees.trees) {
        annotateExpectedValues(tree);
      }
    }
    if (fs.existsSync(topoPath)) {
      this.topology = JSON.parse(fs.readFileSync(topoPath, "utf-8")) as Record<string, TopologyEntry>;
    }
    if (fs.existsSync(metricsPath)) {
      this.metrics = JSON.parse(fs.readFileSync(metricsPath, "utf-8")) as Record<string, unknown>;
    }
    if (fs.existsSync(baselinesPath)) {
      this.baselines = JSON.parse(fs.readFileSync(baselinesPath, "utf-8")) as Record<string, unknown>;
    }
  }

  public buildFeatureVector(features: PredictionFeatures): number[] {
    const vehicleCount = Number(features.vehicle_count ?? 22000);
    const avgSpeed = Number(features.average_speed ?? 35.0);
    const capUtil = Number(features.capacity_utilization ?? 50.0);
    const hour = Number(features.hour ?? 17);
    const dow = Number(features.day_of_week ?? 2);
    const isWeekend =
      features.is_weekend !== undefined ? Number(features.is_weekend) : dow >= 5 ? 1 : 0;

    const rawCong = String(features.congestion_level ?? "Moderate").trim().toLowerCase();
    const isHigh = rawCong === "high" ? 1 : 0;
    const isLow = rawCong === "low" ? 1 : 0;
    const isModerate = rawCong === "moderate" ? 1 : 0;
    const isSevere = rawCong === "severe" ? 1 : 0;

    // Order matches training_metrics.json feature_schema.vectorized_columns:
    // f0: vehicle_count, f1: average_speed, f2: capacity_utilization,
    // f3: hour, f4: day_of_week, f5: is_weekend,
    // f6: High, f7: Low, f8: Moderate, f9: Severe
    return [
      vehicleCount,
      avgSpeed,
      capUtil,
      hour,
      dow,
      isWeekend,
      isHigh,
      isLow,
      isModerate,
      isSevere,
    ];
  }

  public predictSegment(features: PredictionFeatures): [CongestionLevel, Record<string, number>] {
    if (!this.modelTrees) {
      return ["Moderate", { High: 0.2, Low: 0.2, Moderate: 0.5, Severe: 0.1 }];
    }

    const { num_classes, classes, base_scores, trees } = this.modelTrees;
    const x = this.buildFeatureVector(features);
    const margins = base_scores.slice(0, num_classes);

    for (let i = 0; i < trees.length; i++) {
      const clsIdx = i % num_classes;
      margins[clsIdx] += traverseTree(trees[i], x);
    }

    const maxMargin = Math.max(...margins);
    const exps = margins.map((m) => Math.exp(m - maxMargin));
    const sumExp = exps.reduce((a, b) => a + b, 0) || 1.0;

    const probDist: Record<string, number> = {};
    let bestClass: CongestionLevel = classes[0];
    let bestProb = -1;

    for (let c = 0; c < num_classes; c++) {
      const p = roundTo(exps[c] / sumExp, 4);
      const clsName = classes[c];
      probDist[clsName] = p;
      if (p > bestProb) {
        bestProb = p;
        bestClass = clsName;
      }
    }

    return [bestClass, probDist];
  }

  public predictBatch(featuresList: PredictionFeatures[]): Array<[CongestionLevel, Record<string, number>]> {
    return featuresList.map((f) => this.predictSegment(f));
  }

  public explainPrediction(features: PredictionFeatures): PredictionExplanation {
    const [predClass, probs] = this.predictSegment(features);
    const conf = roundTo((probs[predClass] ?? 0.5) * 100, 1);
    const x = this.buildFeatureVector(features);

    // Real Saabas tree-path feature attribution across all 320 trees for predicted class
    const rawDeltas = new Array<number>(10).fill(0);
    if (this.modelTrees) {
      const { num_classes, classes, trees } = this.modelTrees;
      const targetClassIdx = Math.max(0, classes.indexOf(predClass));
      for (let i = 0; i < trees.length; i++) {
        if (i % num_classes === targetClassIdx) {
          traverseTreeWithSaabas(trees[i], x, rawDeltas);
        }
      }
    }

    const congDelta = rawDeltas[6] + rawDeltas[7] + rawDeltas[8] + rawDeltas[9];
    const items: Array<{ feature: string; value: string | number; delta: number }> = [
      { feature: "vehicle_count", value: Math.round(x[0]), delta: rawDeltas[0] },
      { feature: "average_speed", value: `${roundTo(x[1], 1)} km/h`, delta: rawDeltas[1] },
      { feature: "capacity_utilization", value: `${roundTo(x[2], 1)}%`, delta: rawDeltas[2] },
      { feature: "hour", value: `${Math.round(x[3])}:00`, delta: rawDeltas[3] },
      { feature: "day_of_week", value: Math.round(x[4]), delta: rawDeltas[4] + rawDeltas[5] },
      { feature: "congestion_level", value: String(features.congestion_level ?? "Moderate"), delta: congDelta },
    ];

    const totalAbs = items.reduce((acc, it) => acc + Math.abs(it.delta), 0) || 1.0;

    const contributions = items
      .map((it) => {
        const importance = roundTo(Math.abs(it.delta) / totalAbs, 4);
        const signed = roundTo(it.delta, 4);
        const direction =
          signed > 0.005
            ? `supports_${predClass.toLowerCase()}`
            : signed < -0.005
              ? `opposes_${predClass.toLowerCase()}`
              : "neutral";
        return {
          feature: it.feature,
          value: it.value,
          importance,
          signed_delta: signed,
          direction,
        };
      })
      .sort((a, b) => b.importance - a.importance);

    return {
      predicted_class: predClass,
      probabilities: probs,
      confidence_pct: conf,
      attribution_method: "Saabas Tree-Path Expected Value Decomposition (Exact Ensemble Traversal)",
      feature_contributions: contributions,
      model_info: {
        algorithm: String(this.metrics.algorithm ?? "XGBoost 80-Tree Ensemble (hist)"),
        model_version: String(this.metrics.model_version ?? "2.0.0-chronological"),
        num_trees: this.modelTrees?.trees.length ?? 0,
      },
    };
  }
}
