export type CongestionLevel = "Low" | "Moderate" | "High" | "Severe";

export const CONGESTION_RANKS: Record<CongestionLevel, number> = {
  Low: 0,
  Moderate: 1,
  High: 2,
  Severe: 3,
};

export const RANK_TO_CONGESTION: Record<number, CongestionLevel> = {
  0: "Low",
  1: "Moderate",
  2: "High",
  3: "Severe",
};

export function roundTo(val: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

export function calculateSpi(currentSpeed: number, freeFlowSpeed: number): number {
  const ff = Math.max(freeFlowSpeed, 1.0);
  return roundTo(Math.min(100.0, Math.max(0.0, (currentSpeed / ff) * 100.0)), 1);
}

export function classifySpiLos(spi: number): CongestionLevel {
  if (spi < 30.0) return "Severe";
  if (spi < 50.0) return "High";
  if (spi < 75.0) return "Moderate";
  return "Low";
}

export function classifySpeedLos(speedKmh: number): CongestionLevel {
  if (speedKmh >= 38.0) return "Low";
  if (speedKmh >= 27.0) return "Moderate";
  if (speedKmh >= 18.0) return "High";
  return "Severe";
}

export function classifyVcLos(vcRatio: number): CongestionLevel {
  if (vcRatio < 0.45) return "Low";
  if (vcRatio < 0.70) return "Moderate";
  if (vcRatio < 0.88) return "High";
  return "Severe";
}

export const LOS_COLORS: Record<CongestionLevel, string> = {
  Low: "#10b981",
  Moderate: "#f59e0b",
  High: "#f97316",
  Severe: "#ef4444",
};

export function getLosColor(los: CongestionLevel | string): string {
  const norm = String(los || "Moderate").trim().toLowerCase();
  if (norm.includes("severe")) return LOS_COLORS.Severe;
  if (norm.includes("high")) return LOS_COLORS.High;
  if (norm.includes("mod")) return LOS_COLORS.Moderate;
  return LOS_COLORS.Low;
}

export function classifyTrafficSeverity(
  speedKmh: number,
  freeFlowSpeedKmh = 50.0
): { los: CongestionLevel; weight: number; spi: number; color: string } {
  const ff = Math.max(15.0, Number(freeFlowSpeedKmh) || 50.0);
  const spd = Math.max(2.0, Number(speedKmh) || 25.0);
  const spi = calculateSpi(spd, ff);

  // Calibrated Bengaluru urban arterial severity anchored on Speed Performance Index (SPI):
  // Using SPI (currentSpeed / freeFlowSpeed * 100) ensures narrow urban streets moving at
  // their full free-flow speed (e.g. 26/26 km/h => SPI 100%) correctly classify as Low (Green),
  // while genuine slowdowns and gridlock crawls classify as Orange (High) or Red (Severe).
  let los: CongestionLevel;
  if (spi < 48.0 || spd < 12.0) {
    los = "Severe";
  } else if (spi < 64.0 || (spd < 16.0 && spi < 74.0)) {
    los = "High";
  } else if (spi < 78.0) {
    los = "Moderate";
  } else {
    los = "Low";
  }

  // Smooth continuous severity weight [0.12, 1.0] monotonically decreasing with SPI
  const rawWeight = 1.0 - Math.min(1.0, Math.max(0.0, (spi - 20.0) / 76.0));
  const weight = roundTo(Math.min(1.0, Math.max(0.12, rawWeight)), 3);
  return { los, weight, spi, color: LOS_COLORS[los] };
}

export function calculateCapacityUtilization(currentSpeed: number, freeFlowSpeed: number): number {
  const ff = Math.max(freeFlowSpeed, 1.0);
  const ratio = Math.min(1.0, Math.max(0.0, currentSpeed / ff));
  return roundTo(Math.min(100.0, Math.max(12.0, (1.0 - ratio) * 105.0 + 18.0)), 1);
}

export function calculateScaledVolume(
  baselineAvgVolume: number,
  currentSpeed: number,
  freeFlowSpeed: number
): number {
  const ff = Math.max(freeFlowSpeed, 1.0);
  const ratio = Math.min(1.0, Math.max(0.0, currentSpeed / ff));
  return Math.round(baselineAvgVolume * (0.55 + (1.0 - ratio) * 1.15));
}

export function computePcu(
  vehicleCount: number,
  heavyCount?: number,
  motorcycleCount?: number,
  busCount?: number
): number {
  if (heavyCount !== undefined && motorcycleCount !== undefined && busCount !== undefined) {
    const cars = Math.max(0, vehicleCount - heavyCount - motorcycleCount - busCount);
    const pcu = 1.0 * cars + 2.5 * heavyCount + 0.5 * motorcycleCount + 2.0 * busCount;
    return Math.round(pcu);
  }
  return Math.round(vehicleCount * 1.15);
}

export function greenshieldsEquilibrium(
  volume: number,
  capacity: number,
  freeFlowSpeed = 80.0,
  kJam = 120.0,
  applyPcu = false
): [number, CongestionLevel] {
  const effVol = applyPcu ? computePcu(volume) : volume;
  const vc = effVol / Math.max(capacity, 1);
  const kc = kJam / 2.0;
  const ratio = Math.min(0.99, Math.max(0.0, vc));
  const k = kc * (1.0 + (vc <= 1.0 ? -1.0 : 1.0) * Math.sqrt(Math.max(0.0, 1.0 - ratio)));
  const speed = Math.max(8.0, Math.min(freeFlowSpeed, freeFlowSpeed * (1.0 - k / kJam)));
  return [roundTo(speed, 1), classifyVcLos(vc)];
}

export function getHcmLos(delaySec: number): string {
  if (delaySec <= 10.0) return "LOS A (Free Flow)";
  if (delaySec <= 20.0) return "LOS B (Reasonably Free)";
  if (delaySec <= 35.0) return "LOS C (Stable Flow)";
  if (delaySec <= 55.0) return "LOS D (Approaching Unstable)";
  if (delaySec <= 80.0) return "LOS E (Unstable / At Capacity)";
  return "LOS F (Forced / Breakdown)";
}

export function getFruinLos(densitySqm: number): string {
  if (densitySqm <= 0.35) return "LOS A (Free Flow)";
  if (densitySqm <= 0.65) return "LOS B (Normal Walking)";
  if (densitySqm <= 1.05) return "LOS C (Moderate Friction)";
  if (densitySqm <= 1.55) return "LOS D (Restricted Flow)";
  if (densitySqm <= 2.25) return "LOS E (Severe Crowding)";
  return "LOS F (Breakdown / Crush)";
}

export interface SignalOptimizationResult {
  optimal_cycle_sec: number;
  ns_green_sec: number;
  ew_green_sec: number;
  amber_sec: number;
  all_red_sec: number;
  total_lost_time_sec: number;
  critical_flow_ratio_Y: number;
  degree_of_saturation_ns: number;
  degree_of_saturation_ew: number;
  estimated_delay_sec: number;
  baseline_fixed_delay_sec: number;
  delay_saved_sec: number;
  total_delay_saved_vph: number;
  queue_vehicles_ns: number;
  queue_meters_ns: number;
  level_of_service: string;
}

export function optimizeIntersectionSignals(
  nsVolumePcu: number,
  ewVolumePcu: number,
  nsLanes = 2,
  ewLanes = 2,
  phaseExtensionSec = 0.0,
  saturationFlowPerLane = 1800.0
): SignalOptimizationResult {
  const sNs = Math.max(1, nsLanes) * saturationFlowPerLane;
  const sEw = Math.max(1, ewLanes) * saturationFlowPerLane;

  const yNs = Math.max(0.05, Math.min(0.85, nsVolumePcu / sNs));
  const yEw = Math.max(0.05, Math.min(0.85, ewVolumePcu / sEw));
  const Y = Math.min(0.90, yNs + yEw);

  const lostTimePerPhase = 4.0;
  const L = 2 * lostTimePerPhase;

  const rawC0 = (1.5 * L + 5.0) / Math.max(0.10, 1.0 - Y);
  const c0 = Math.max(45.0, Math.min(150.0, Math.round(rawC0 + phaseExtensionSec)));
  const effectiveGreenTotal = Math.max(20.0, c0 - L);

  let gNs = Math.max(10.0, Math.round((yNs / Y) * effectiveGreenTotal));
  let gEw = Math.max(10.0, Math.round(effectiveGreenTotal - gNs));
  if (gNs + gEw > effectiveGreenTotal) {
    const excess = gNs + gEw - effectiveGreenTotal;
    if (gNs >= gEw) gNs = Math.max(10.0, gNs - excess);
    else gEw = Math.max(10.0, gEw - excess);
  }

  const xNs = Math.min(1.25, nsVolumePcu / Math.max(1.0, sNs * (gNs / c0)));
  const xEw = Math.min(1.25, ewVolumePcu / Math.max(1.0, sEw * (gEw / c0)));

  const akcelikDelay = (c: number, g: number, x: number, capVph: number) => {
    const gRatio = Math.min(0.95, Math.max(0.05, g / c));
    const d1 = (0.5 * c * Math.pow(1.0 - gRatio, 2)) / Math.max(0.05, 1.0 - Math.min(1.0, x) * gRatio);
    const T = 0.25;
    const d2 = 900.0 * T * (x - 1.0 + Math.sqrt(Math.pow(x - 1.0, 2) + (4.0 * x) / Math.max(10.0, capVph * T)));
    return Math.max(3.0, Math.min(240.0, d1 + Math.max(0.0, d2)));
  };

  const capNs = sNs * (gNs / c0);
  const optDelay = akcelikDelay(c0, gNs, xNs, capNs);
  const fixedDelay = akcelikDelay(120.0, 56.0, Math.min(1.25, nsVolumePcu / Math.max(1.0, sNs * (56.0 / 120.0))), sNs * (56.0 / 120.0));
  const delaySaved = Math.max(0.0, roundTo(fixedDelay - optDelay, 1));
  const totalDelaySavedVph = Math.round((delaySaved * (nsVolumePcu + ewVolumePcu)) / 3600.0);

  const redSec = Math.max(10.0, c0 - gNs);
  const arrivalRatePerSec = nsVolumePcu / 3600.0;
  const rawQueueVeh = arrivalRatePerSec * redSec * (xNs > 0.85 ? 1.0 + (xNs - 0.85) * 2.5 : 1.0);
  const queueVeh = roundTo(Math.min(65.0, Math.max(1.0, rawQueueVeh / Math.max(1, nsLanes))), 1);
  const queueMeters = roundTo(Math.min(450.0, queueVeh * 6.5), 1);

  return {
    optimal_cycle_sec: c0,
    ns_green_sec: gNs,
    ew_green_sec: gEw,
    amber_sec: 3.0,
    all_red_sec: 1.0,
    total_lost_time_sec: L,
    critical_flow_ratio_Y: roundTo(Y, 3),
    degree_of_saturation_ns: roundTo(xNs, 2),
    degree_of_saturation_ew: roundTo(xEw, 2),
    estimated_delay_sec: roundTo(optDelay, 1),
    baseline_fixed_delay_sec: roundTo(fixedDelay, 1),
    delay_saved_sec: delaySaved,
    total_delay_saved_vph: totalDelaySavedVph,
    queue_vehicles_ns: queueVeh,
    queue_meters_ns: queueMeters,
    level_of_service: getHcmLos(optDelay),
  };
}
