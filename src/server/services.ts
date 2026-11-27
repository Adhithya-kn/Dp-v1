import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppDatabase } from "./database.ts";
import {
  BENGALURU_CORRIDOR_GPS,
  BENGALURU_SECTOR_REGIONS,
  CALIBRATED_ROAD_LENGTHS_KM,
  CORRIDOR_GEO_REGISTRY,
  INTER_ZONE_BRIDGES,
  ROAD_REGISTRY,
  enrichRoadInfo,
  getCorridorCoordinates,
  getCorridorLaneInfo,
  getIntersectionName,
  getRoadName,
  normalizeCorridorId,
} from "./roadRegistry.ts";
import {
  CONGESTION_RANKS,
  RANK_TO_CONGESTION,
  calculateCapacityUtilization,
  calculateScaledVolume,
  calculateSpi,
  classifySpeedLos,
  classifyTrafficSeverity,
  computePcu,
  getFruinLos,
  getHcmLos,
  getLosColor,
  greenshieldsEquilibrium,
  optimizeIntersectionSignals,
  roundTo,
} from "./physics.ts";
import type { CongestionLevel } from "./physics.ts";
import { TrafficPredictor } from "./predictor.ts";

export function nowIso(): string {
  return new Date().toISOString();
}

export function isValidIdentifier(val: string): boolean {
  return Boolean(val && /^[a-zA-Z0-9_.-]{1,120}$/.test(val));
}

export function parseTimeStr(timeStr: string): [number, number] {
  const clean = String(timeStr ?? "").trim();
  const m = clean.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) throw new Error(`Invalid time format: '${timeStr}'`);
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Time out of range: '${timeStr}'`);
  }
  return [hour, minute];
}

export function isValidIsoDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(`${dateStr}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(dateStr);
}

// ---------------------------------------------------------------------------
// SecurityManager (SQLite-backed users & sessions, salted scrypt hashing)
// ---------------------------------------------------------------------------

export interface UserRecord {
  username: string;
  password_hash: string;
  salt: string;
  hash_algo: "scrypt" | "pbkdf2";
  role: string;
  created_at: number;
  is_active: boolean;
}

export interface SessionRecord {
  token: string;
  username: string;
  role: string;
  created_at: number;
  expires_at?: number;
}

const PBKDF2_ITERATIONS = 20_000;
const SESSION_TTL_SEC = Number(process.env.SESSION_TTL_SECONDS) || 86_400;
const USERNAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

export function hashPassword(password: string, salt?: string): { hash: string; salt: string; algo: "scrypt" } {
  const actualSalt = salt || crypto.randomBytes(16).toString("hex");
  const dk = crypto.scryptSync(password, actualSalt, 64, { N: 16384, r: 8, p: 1 });
  return { hash: dk.toString("hex"), salt: actualSalt, algo: "scrypt" };
}

export function verifyPassword(
  password: string,
  passwordHash: string,
  salt: string,
  algo: string = "scrypt"
): boolean {
  try {
    let derived: Buffer;
    if (algo === "pbkdf2") {
      derived = crypto.pbkdf2Sync(
        Buffer.from(password, "utf-8"),
        Buffer.from(salt, "hex"),
        PBKDF2_ITERATIONS,
        32,
        "sha256"
      );
    } else {
      derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    }
    const stored = Buffer.from(passwordHash, "hex");
    if (derived.length !== stored.length) return false;
    return crypto.timingSafeEqual(derived, stored);
  } catch {
    return false;
  }
}

export class SecurityManager {
  private appDb: AppDatabase;
  private rateHistory: Map<string, number[]> = new Map();
  private revokedTokens: Set<string> = new Set();
  private sessionSecret: Buffer;

  constructor(_baseDir: string | undefined, appDb: AppDatabase) {
    this.appDb = appDb;
    const secretInput =
      (process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "smart-traffic-dev-session-key").trim() ||
      "smart-traffic-dev-session-key";
    this.sessionSecret = crypto.createHash("sha256").update(secretInput).digest();
    this.seedInitialUsersIfEmpty();
  }

  private signStatelessToken(username: string, role: string, createdAt: number, expiresAt: number): string {
    const payload = Buffer.from(
      JSON.stringify({
        u: username,
        r: role,
        iat: createdAt,
        exp: expiresAt,
        jti: crypto.randomBytes(12).toString("hex"),
      }),
      "utf8"
    ).toString("base64url");
    const sig = crypto.createHmac("sha256", this.sessionSecret).update(payload).digest("base64url");
    return `st1.${payload}.${sig}`;
  }

  private verifyStatelessToken(token: string): SessionRecord | null {
    if (!token.startsWith("st1.") || this.revokedTokens.has(token)) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const sig = parts[2];
    if (!payload || !sig) return null;
    try {
      const expected = crypto.createHmac("sha256", this.sessionSecret).update(payload).digest("base64url");
      const a = Buffer.from(sig, "utf8");
      const b = Buffer.from(expected, "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        u?: string;
        r?: string;
        iat?: number;
        exp?: number;
      };
      if (!decoded.u || !decoded.r || typeof decoded.exp !== "number") return null;
      if (decoded.exp < Date.now() / 1000) return null;
      return {
        token,
        username: String(decoded.u),
        role: String(decoded.r),
        created_at: Number(decoded.iat ?? Date.now() / 1000),
        expires_at: decoded.exp,
      };
    } catch {
      return null;
    }
  }

  private seedInitialUsersIfEmpty(): void {
    const row = this.appDb.db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c?: number } | undefined;
    if ((row?.c ?? 0) > 0) return;

    const adminUser = (process.env.ADMIN_USERNAME || "traffic_admin").trim() || "traffic_admin";
    const bootstrapPassword = (process.env.ADMIN_PASSWORD || "Admin@123").trim() || "Admin@123";
    const now = Date.now() / 1000;

    const insert = this.appDb.db.prepare(
      `INSERT OR IGNORE INTO users (username, password_hash, salt, hash_algo, role, created_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    );

    const seed = (username: string, password: string, role: string) => {
      const { hash, salt, algo } = hashPassword(password);
      insert.run(username, hash, salt, algo, role, now);
    };

    seed(adminUser, bootstrapPassword, "Traffic Management");
    if (adminUser !== "admin") {
      seed("admin", bootstrapPassword, "Traffic Management");
    }
    seed("commuter", bootstrapPassword, "Road User");
  }

  public getUserCount(): number {
    const row = this.appDb.db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  }

  public login(username: string, password: string): { ok: boolean; msg: string; session: SessionRecord | null } {
    const u = String(username ?? "").trim();
    const p = String(password ?? "");
    if (!u || !p) {
      return { ok: false, msg: "Username and password are required.", session: null };
    }
    const row = this.appDb.db
      .prepare("SELECT username, password_hash, salt, hash_algo, role, created_at, is_active FROM users WHERE username = ?")
      .get(u) as Record<string, unknown> | undefined;

    if (!row || !row.is_active) {
      return { ok: false, msg: "Invalid username or password.", session: null };
    }
    if (!verifyPassword(p, String(row.password_hash), String(row.salt), String(row.hash_algo || "scrypt"))) {
      return { ok: false, msg: "Invalid username or password.", session: null };
    }

    const createdAt = Date.now() / 1000;
    const expiresAt = createdAt + SESSION_TTL_SEC;
    const token = this.signStatelessToken(String(row.username), String(row.role), createdAt, expiresAt);

    this.appDb.db
      .prepare("INSERT INTO sessions (token, username, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(token, String(row.username), String(row.role), createdAt, expiresAt);

    // Opportunistically prune expired sessions
    this.appDb.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(createdAt);

    const session: SessionRecord = {
      token,
      username: String(row.username),
      role: String(row.role),
      created_at: createdAt,
      expires_at: expiresAt,
    };
    return { ok: true, msg: "Authentication successful.", session };
  }

  public logout(token: string): boolean {
    if (!token) return false;
    this.revokedTokens.add(token);
    const res = this.appDb.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return Number(res.changes ?? 0) > 0 || token.startsWith("st1.");
  }

  public register(
    username: string,
    password: string,
    role = "Road User",
    isAdminInvoker = false
  ): { ok: boolean; msg: string } {
    const u = String(username ?? "").trim();
    const p = String(password ?? "");
    if (u.length < 3 || u.length > 32 || !USERNAME_REGEX.test(u)) {
      return { ok: false, msg: "Username must be 3-32 alphanumeric characters (._- allowed)." };
    }
    if (p.length < 6 || p.length > 128) {
      return { ok: false, msg: "Password must be 6-128 characters long." };
    }
    const existing = this.appDb.db.prepare("SELECT username FROM users WHERE username = ?").get(u);
    if (existing) {
      return { ok: false, msg: `Username '${u}' is already registered.` };
    }
    let assignedRole = String(role || "Road User").trim();
    if (!isAdminInvoker && assignedRole === "Traffic Management") {
      assignedRole = "Road User";
    }
    const { hash, salt, algo } = hashPassword(p);
    this.appDb.db
      .prepare(
        "INSERT INTO users (username, password_hash, salt, hash_algo, role, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)"
      )
      .run(u, hash, salt, algo, assignedRole, Date.now() / 1000);
    return { ok: true, msg: `Account '${u}' registered successfully.` };
  }

  public deleteUser(username: string): boolean {
    const u = String(username ?? "").trim();
    if (!u) return false;
    const res = this.appDb.db.prepare("DELETE FROM users WHERE username = ?").run(u);
    return Number(res.changes ?? 0) > 0;
  }

  public getUserByToken(token: string): SessionRecord | null {
    if (!token || this.revokedTokens.has(token)) return null;
    const row = this.appDb.db
      .prepare("SELECT token, username, role, created_at, expires_at FROM sessions WHERE token = ?")
      .get(token) as Record<string, unknown> | undefined;
    if (!row) {
      return this.verifyStatelessToken(token);
    }
    const now = Date.now() / 1000;
    if (Number(row.expires_at) < now) {
      this.appDb.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
      return null;
    }
    return {
      token: String(row.token),
      username: String(row.username),
      role: String(row.role),
      created_at: Number(row.created_at),
      expires_at: Number(row.expires_at),
    };
  }

  public checkRateLimit(bucket: string, key: string, maxReq = 30, windowSec = 60): { allowed: boolean; retryAfter: number } {
    const fullKey = `${bucket}:${key}`;
    const now = Date.now() / 1000;
    const prev = (this.rateHistory.get(fullKey) ?? []).filter((ts) => now - ts < windowSec);
    if (prev.length >= maxReq) {
      const retryAfter = Math.max(1, Math.ceil(windowSec - (now - prev[0])));
      this.rateHistory.set(fullKey, prev);
      return { allowed: false, retryAfter };
    }
    prev.push(now);
    this.rateHistory.set(fullKey, prev);
    return { allowed: true, retryAfter: 0 };
  }
}

// ---------------------------------------------------------------------------
// EventManager (SQLite-backed + Live TomTom Incidents v5 Sync)
// ---------------------------------------------------------------------------

export interface TrafficEvent {
  id: string;
  name: string;
  event_type: string;
  city_zone: string;
  location_name: string;
  affected_roads: string[];
  affected_road_names?: string[];
  start_time: string;
  end_time: string;
  date: string;
  end_date?: string;
  dataset_date?: string;
  active_dates?: string[];
  severity_boost: number;
  volume_surge_vph: number;
  capacity_constriction_pct: number;
  speed_impact_pct: number;
  is_historical: boolean;
  is_published: boolean;
  published_at?: string;
  updated_at?: string;
  description: string;
  source_name?: string;
  source_url?: string;
  verification_status?: string;
  [key: string]: unknown;
}

function parseMinutes(hhmm: string): number {
  const m = String(hhmm || "00:00").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function findNearestCorridor(lat: number, lon: number): string {
  let bestId = "RD_BLR_01";
  let bestDist = Infinity;
  for (const [rId, gps] of Object.entries(BENGALURU_CORRIDOR_GPS)) {
    const d = Math.hypot(gps.lat - lat, gps.lon - lon);
    if (d < bestDist) {
      bestDist = d;
      bestId = rId;
    }
  }
  return bestId;
}

export class EventManager {
  private appDb: AppDatabase;
  private baseDir: string;

  constructor(baseDir: string | undefined, appDb: AppDatabase) {
    this.baseDir = baseDir ?? process.cwd();
    this.appDb = appDb;
    this.seedEventsIfEmpty();
  }

  private seedEventsIfEmpty(): void {
    const row = this.appDb.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c?: number } | undefined;
    if ((row?.c ?? 0) > 0) return;

    const fixturePath = path.join(this.baseDir, "data", "seed_events.json");
    let seedList: TrafficEvent[] = [];
    try {
      if (fs.existsSync(fixturePath)) {
        const parsed = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
        if (Array.isArray(parsed)) seedList = parsed as TrafficEvent[];
      }
    } catch {
      seedList = [];
    }

    if (seedList.length === 0) {
      const today = new Date().toISOString().slice(0, 10);
      seedList = [
        {
          id: "EVT_BLR_LIVE_01",
          name: "Central Silk Board BMRCL Blue Line Pier Curing",
          event_type: "Roadwork & Maintenance",
          city_zone: "Electronic City South",
          location_name: "Central Silk Board Junction, Bengaluru",
          affected_roads: ["RD_BLR_11", "RD_BLR_06"],
          affected_road_names: ["Silk Board Junction", "Hosur Road"],
          start_time: "07:00",
          end_time: "23:00",
          date: today,
          end_date: "2026-12-31",
          active_dates: [today],
          severity_boost: 3,
          volume_surge_vph: 750,
          capacity_constriction_pct: 50,
          speed_impact_pct: 60,
          is_historical: false,
          is_published: true,
          published_at: nowIso(),
          updated_at: nowIso(),
          description: "BMRCL Blue Line interchange pier casting restricting lanes toward Hosur Road.",
          source_name: "BMRCL Project Cell",
          verification_status: "OFFICIAL_VERIFIED",
        },
      ];
    }

    for (const evt of seedList) {
      this.upsertEventRecord(evt);
    }
  }

  private upsertEventRecord(evt: TrafficEvent): void {
    const knownKeys = new Set([
      "id", "name", "event_type", "city_zone", "location_name",
      "affected_roads", "affected_road_names", "start_time", "end_time",
      "date", "end_date", "dataset_date", "active_dates", "severity_boost",
      "volume_surge_vph", "capacity_constriction_pct", "speed_impact_pct",
      "is_historical", "is_published", "published_at", "updated_at",
      "description", "source_name", "source_url", "verification_status",
    ]);
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(evt)) {
      if (!knownKeys.has(k)) extra[k] = v;
    }

    const roads = Array.isArray(evt.affected_roads) ? evt.affected_roads : [];
    const roadNames =
      Array.isArray(evt.affected_road_names) && evt.affected_road_names.length > 0
        ? evt.affected_road_names
        : roads.map(getRoadName);

    this.appDb.db
      .prepare(
        `INSERT INTO events (
           id, name, event_type, city_zone, location_name,
           affected_roads_json, affected_road_names_json,
           start_time, end_time, date, end_date, dataset_date, active_dates_json,
           severity_boost, volume_surge_vph, capacity_constriction_pct, speed_impact_pct,
           is_historical, is_published, published_at, updated_at,
           description, source_name, source_url, verification_status, extra_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           event_type = excluded.event_type,
           city_zone = excluded.city_zone,
           location_name = excluded.location_name,
           affected_roads_json = excluded.affected_roads_json,
           affected_road_names_json = excluded.affected_road_names_json,
           start_time = excluded.start_time,
           end_time = excluded.end_time,
           date = excluded.date,
           end_date = excluded.end_date,
           active_dates_json = excluded.active_dates_json,
           severity_boost = excluded.severity_boost,
           volume_surge_vph = excluded.volume_surge_vph,
           capacity_constriction_pct = excluded.capacity_constriction_pct,
           speed_impact_pct = excluded.speed_impact_pct,
           is_historical = excluded.is_historical,
           is_published = excluded.is_published,
           published_at = excluded.published_at,
           updated_at = excluded.updated_at,
           description = excluded.description,
           source_name = excluded.source_name,
           source_url = excluded.source_url,
           verification_status = excluded.verification_status,
           extra_json = excluded.extra_json`
      )
      .run(
        evt.id,
        evt.name,
        evt.event_type || "Roadwork & Maintenance",
        evt.city_zone || "Indiranagar",
        evt.location_name || "Bengaluru",
        JSON.stringify(roads),
        JSON.stringify(roadNames),
        evt.start_time || "08:00",
        evt.end_time || "22:00",
        evt.date || new Date().toISOString().slice(0, 10),
        evt.end_date ?? null,
        evt.dataset_date ?? null,
        JSON.stringify(evt.active_dates ?? []),
        Number(evt.severity_boost ?? 2),
        Number(evt.volume_surge_vph ?? 550),
        Number(evt.capacity_constriction_pct ?? 40),
        Number(evt.speed_impact_pct ?? 45),
        evt.is_historical ? 1 : 0,
        evt.is_published ? 1 : 0,
        evt.published_at ?? null,
        evt.updated_at ?? nowIso(),
        evt.description || "",
        evt.source_name ?? null,
        evt.source_url ?? null,
        evt.verification_status ?? null,
        Object.keys(extra).length > 0 ? JSON.stringify(extra) : null
      );
  }

  private rowToEvent(row: Record<string, unknown>): TrafficEvent {
    const roads: string[] = JSON.parse(String(row.affected_roads_json || "[]"));
    const roadNamesRaw: string[] = JSON.parse(String(row.affected_road_names_json || "[]"));
    const extra: Record<string, unknown> = row.extra_json ? JSON.parse(String(row.extra_json)) : {};
    return {
      ...extra,
      id: String(row.id),
      name: String(row.name),
      event_type: String(row.event_type),
      city_zone: String(row.city_zone),
      location_name: String(row.location_name),
      affected_roads: roads,
      affected_road_names: roadNamesRaw.length > 0 ? roadNamesRaw : roads.map(getRoadName),
      start_time: String(row.start_time),
      end_time: String(row.end_time),
      date: String(row.date),
      end_date: row.end_date ? String(row.end_date) : undefined,
      dataset_date: row.dataset_date ? String(row.dataset_date) : undefined,
      active_dates: JSON.parse(String(row.active_dates_json || "[]")),
      severity_boost: Number(row.severity_boost),
      volume_surge_vph: Number(row.volume_surge_vph),
      capacity_constriction_pct: Number(row.capacity_constriction_pct),
      speed_impact_pct: Number(row.speed_impact_pct),
      is_historical: Boolean(row.is_historical),
      is_published: Boolean(row.is_published),
      published_at: row.published_at ? String(row.published_at) : undefined,
      updated_at: row.updated_at ? String(row.updated_at) : undefined,
      description: String(row.description),
      source_name: row.source_name ? String(row.source_name) : undefined,
      source_url: row.source_url ? String(row.source_url) : undefined,
      verification_status: row.verification_status ? String(row.verification_status) : undefined,
    };
  }

  public getEventCount(): number {
    const row = this.appDb.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  }

  public getAllEvents(): TrafficEvent[] {
    const rows = this.appDb.db
      .prepare("SELECT * FROM events ORDER BY updated_at DESC, id ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEvent(r));
  }

  public getScheduledEvents(zone?: string | null, publishedOnly = false): TrafficEvent[] {
    let sql = "SELECT * FROM events WHERE is_historical = 0";
    const params: Array<string | number> = [];
    if (publishedOnly) {
      sql += " AND is_published = 1";
    }
    if (zone && zone.trim().toLowerCase() !== "all") {
      sql += " AND LOWER(city_zone) = LOWER(?)";
      params.push(zone.trim());
    }
    sql += " ORDER BY updated_at DESC, id ASC";
    const rows = this.appDb.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEvent(r));
  }

  public getHistoricalEvents(zone?: string | null): TrafficEvent[] {
    let sql = "SELECT * FROM events WHERE is_historical = 1";
    const params: Array<string | number> = [];
    if (zone && zone.trim().toLowerCase() !== "all") {
      sql += " AND LOWER(city_zone) = LOWER(?)";
      params.push(zone.trim());
    }
    sql += " ORDER BY date DESC, id ASC";
    const rows = this.appDb.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEvent(r));
  }

  public findActiveEvents(opts: {
    roadId?: string;
    zone?: string | null;
    date?: string | null;
    timeStr?: string | null;
    publishedOnly?: boolean;
  }): TrafficEvent[] {
    const { roadId, zone, date, timeStr, publishedOnly = true } = opts;
    const candidates = this.getScheduledEvents(zone, publishedOnly);
    return candidates.filter((e) => {
      if (roadId && !(e.affected_roads ?? []).includes(roadId)) return false;

      if (date) {
        const inActive = Array.isArray(e.active_dates) && e.active_dates.includes(date);
        const startD = e.date || "2020-01-01";
        const endD = e.end_date || "2099-12-31";
        const inRange = date >= startD && date <= endD;
        if (!inActive && !inRange) return false;
      }

      if (timeStr) {
        const curMin = parseMinutes(timeStr);
        const sMin = parseMinutes(e.start_time || "00:00");
        const eMin = parseMinutes(e.end_time || "23:59");
        if (sMin <= eMin) {
          if (curMin < sMin || curMin > eMin) return false;
        } else {
          if (curMin < sMin && curMin > eMin) return false;
        }
      }
      return true;
    });
  }

  public getLatestAlert(): TrafficEvent | null {
    const row = this.appDb.db
      .prepare("SELECT * FROM events WHERE is_historical = 0 AND is_published = 1 ORDER BY published_at DESC, updated_at DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    return row ? this.rowToEvent(row) : null;
  }

  public addEvent(payload: Record<string, unknown>): { ok: boolean; msg: string; event: TrafficEvent | null } {
    const name = String(payload.name ?? "").trim();
    if (!name) return { ok: false, msg: "Event name is required.", event: null };
    const affectedRaw = Array.isArray(payload.affected_roads)
      ? payload.affected_roads.map((r) => normalizeCorridorId(String(r)))
      : payload.road_id
        ? [normalizeCorridorId(String(payload.road_id))]
        : ["RD_BLR_01"];

    const id = String(payload.id || `EVT_USR_${Date.now().toString(36).toUpperCase()}`);
    const today = new Date().toISOString().slice(0, 10);
    const evt: TrafficEvent = {
      id,
      name,
      event_type: String(payload.event_type || "Roadwork & Maintenance"),
      city_zone: String(payload.city_zone || ROAD_REGISTRY[affectedRaw[0]]?.city_zone || "Indiranagar"),
      location_name: String(payload.location_name || `${getRoadName(affectedRaw[0])}, Bengaluru`),
      affected_roads: affectedRaw,
      affected_road_names: affectedRaw.map(getRoadName),
      start_time: String(payload.start_time || "08:00"),
      end_time: String(payload.end_time || "22:00"),
      date: String(payload.date || today),
      end_date: String(payload.end_date || "2026-12-31"),
      active_dates: [String(payload.date || today)],
      severity_boost: Number(payload.severity_boost ?? 2),
      volume_surge_vph: Number(payload.volume_surge_vph ?? 550),
      capacity_constriction_pct: Number(payload.capacity_constriction_pct ?? 40),
      speed_impact_pct: Number(payload.speed_impact_pct ?? 45),
      is_historical: false,
      is_published: Boolean(payload.is_published ?? true),
      published_at: nowIso(),
      updated_at: nowIso(),
      description: String(payload.description || "Operational traffic advisory created via Traffic Control Portal."),
      source_name: String(payload.source_name || "Traffic Management Control Room"),
      verification_status: "OFFICIAL_VERIFIED",
    };
    this.upsertEventRecord(evt);
    return { ok: true, msg: "Event created successfully.", event: evt };
  }

  public publishEvent(
    eventId: string,
    updates?: Record<string, unknown>
  ): { ok: boolean; msg: string; event: TrafficEvent | null } {
    const row = this.appDb.db.prepare("SELECT * FROM events WHERE id = ?").get(eventId) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, msg: `Event '${eventId}' not found.`, event: null };
    const evt = this.rowToEvent(row);
    evt.is_published = true;
    evt.published_at = nowIso();
    evt.updated_at = nowIso();
    if (updates) {
      if (updates.severity_boost !== undefined) evt.severity_boost = Number(updates.severity_boost);
      if (updates.description) evt.description = String(updates.description);
    }
    this.upsertEventRecord(evt);
    return { ok: true, msg: `Event '${eventId}' published.`, event: evt };
  }

  public unpublishEvent(eventId: string): { ok: boolean; msg: string } {
    const res = this.appDb.db
      .prepare("UPDATE events SET is_published = 0, updated_at = ? WHERE id = ?")
      .run(nowIso(), eventId);
    if (Number(res.changes ?? 0) === 0) {
      return { ok: false, msg: `Event '${eventId}' not found.` };
    }
    return { ok: true, msg: `Event '${eventId}' retracted.` };
  }

  public deleteEvent(eventId: string): { ok: boolean; msg: string } {
    const res = this.appDb.db.prepare("DELETE FROM events WHERE id = ?").run(eventId);
    if (Number(res.changes ?? 0) === 0) {
      return { ok: false, msg: `Event '${eventId}' not found.` };
    }
    return { ok: true, msg: `Event '${eventId}' deleted.` };
  }

  public async syncBengaluruLiveIncidents(
    zone?: string | null,
    tomtomKey?: string
  ): Promise<{ events: TrafficEvent[]; synced_from: string; imported_count: number }> {
    let imported = 0;
    let syncedFrom = "local_sqlite_registry";

    if (tomtomKey && tomtomKey.trim().length >= 12) {
      try {
        const url =
          `https://api.tomtom.com/traffic/services/5/incidentDetails` +
          `?bbox=77.45,12.80,77.80,13.10` +
          `&fields=${encodeURIComponent("{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code},startTime,endTime,from,to}}}")}` +
          `&language=en-GB&key=${encodeURIComponent(tomtomKey.trim())}`;

        const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (resp.ok) {
          const json = (await resp.json()) as {
            incidents?: Array<{
              geometry?: { type?: string; coordinates?: unknown };
              properties?: {
                id?: string;
                magnitudeOfDelay?: number;
                events?: Array<{ description?: string }>;
                from?: string;
                to?: string;
              };
            }>;
          };
          const today = new Date().toISOString().slice(0, 10);
          for (const inc of (json.incidents ?? []).slice(0, 15)) {
            const coords = inc.geometry?.coordinates;
            let lat = 12.9716;
            let lon = 77.5946;
            if (Array.isArray(coords)) {
              if (typeof coords[0] === "number" && typeof coords[1] === "number") {
                lon = coords[0];
                lat = coords[1];
              } else if (Array.isArray(coords[0]) && typeof coords[0][0] === "number") {
                lon = Number(coords[0][0]);
                lat = Number(coords[0][1]);
              }
            }
            const nearestRoad = findNearestCorridor(lat, lon);
            const reg = ROAD_REGISTRY[nearestRoad];
            const desc =
              inc.properties?.events?.map((e) => e.description).filter(Boolean).join("; ") ||
              "Live Bengaluru Traffic Incident";
            const mag = Math.max(1, Math.min(3, Number(inc.properties?.magnitudeOfDelay ?? 2)));
            const extId = `EVT_TT_${String(inc.properties?.id || crypto.randomBytes(4).toString("hex")).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20)}`;

            this.upsertEventRecord({
              id: extId,
              name: `${desc} — ${inc.properties?.from || getRoadName(nearestRoad)}`,
              event_type: mag >= 3 ? "Accident / Major Disruption" : "Live Traffic Incident",
              city_zone: reg?.city_zone || "Indiranagar",
              location_name: inc.properties?.from
                ? `${inc.properties.from}${inc.properties.to ? ` to ${inc.properties.to}` : ""}, Bengaluru`
                : `${getRoadName(nearestRoad)}, Bengaluru`,
              affected_roads: [nearestRoad],
              affected_road_names: [getRoadName(nearestRoad)],
              start_time: "00:00",
              end_time: "23:59",
              date: today,
              end_date: today,
              active_dates: [today],
              severity_boost: mag,
              volume_surge_vph: 350 + mag * 150,
              capacity_constriction_pct: 25 + mag * 10,
              speed_impact_pct: 25 + mag * 12,
              is_historical: false,
              is_published: true,
              published_at: nowIso(),
              updated_at: nowIso(),
              description: desc,
              source_name: "TomTom Live Traffic Incidents v5",
              verification_status: "LIVE_EXTERNAL_FEED",
            });
            imported++;
          }
          syncedFrom = "tomtom_live_v5";
        }
      } catch (err) {
        console.warn("[EventManager] TomTom incident sync failed, using SQLite registry:", err);
      }
    }

    return {
      events: this.getScheduledEvents(zone, true),
      synced_from: syncedFrom,
      imported_count: imported,
    };
  }
}

// ---------------------------------------------------------------------------
// RouteNavigator (24-Corridor Graph + Dijkstra + Dynamic Event Bypass)
// ---------------------------------------------------------------------------

class UrbanRoadGraph {
  public adj: Map<string, Array<[string, number]>> = new Map();
  public roadLengths: Record<string, number> = {};

  constructor(topology: Record<string, { city_zone: string }>) {
    const zoneRoads: Map<string, string[]> = new Map();
    for (const [rId, info] of Object.entries(topology)) {
      this.adj.set(rId, []);
      this.roadLengths[rId] = CALIBRATED_ROAD_LENGTHS_KM[rId] ?? 3.2;
      const list = zoneRoads.get(info.city_zone) ?? [];
      list.push(rId);
      zoneRoads.set(info.city_zone, list);
    }

    // Intra-zone mesh
    for (const roads of zoneRoads.values()) {
      for (let i = 0; i < roads.length; i++) {
        for (let j = i + 1; j < roads.length; j++) {
          const u = roads[i];
          const v = roads[j];
          const len = roundTo((this.roadLengths[u] + this.roadLengths[v]) * 0.45, 2);
          this.addEdge(u, v, len);
        }
      }
    }

    // Inter-zone bridges
    for (const [u, v, dist] of INTER_ZONE_BRIDGES) {
      if (this.adj.has(u) && this.adj.has(v)) {
        this.addEdge(u, v, dist);
      }
    }
  }

  private addEdge(u: string, v: string, len: number): void {
    const a = this.adj.get(u);
    const b = this.adj.get(v);
    if (a && !a.some(([n]) => n === v)) a.push([v, len]);
    if (b && !b.some(([n]) => n === u)) b.push([u, len]);
  }

  public dijkstraShortestPath(
    origin: string,
    destination: string,
    edgeCosts: Map<string, number>
  ): [string[], number] {
    if (origin === destination) return [[origin], 0];
    if (!this.adj.has(origin) || !this.adj.has(destination)) {
      return [[origin, destination], 15.0];
    }

    const dist = new Map<string, number>();
    const prev = new Map<string, string>();
    const visited = new Set<string>();
    for (const node of this.adj.keys()) dist.set(node, Infinity);
    dist.set(origin, 0);

    while (visited.size < this.adj.size) {
      let cur: string | null = null;
      let best = Infinity;
      for (const [node, d] of dist.entries()) {
        if (!visited.has(node) && d < best) {
          best = d;
          cur = node;
        }
      }
      if (!cur || best === Infinity) break;
      if (cur === destination) break;
      visited.add(cur);

      for (const [nbr, lenKm] of this.adj.get(cur) ?? []) {
        if (visited.has(nbr)) continue;
        const w = edgeCosts.get(`${cur}->${nbr}`) ?? (lenKm / 30.0) * 60.0;
        const alt = best + w;
        if (alt < (dist.get(nbr) ?? Infinity)) {
          dist.set(nbr, alt);
          prev.set(nbr, cur);
        }
      }
    }

    const pathNodes: string[] = [];
    let step: string | undefined = destination;
    while (step) {
      pathNodes.unshift(step);
      if (step === origin) break;
      step = prev.get(step);
    }
    if (pathNodes[0] !== origin) {
      return [[origin, destination], 18.0];
    }
    return [pathNodes, dist.get(destination) ?? 15.0];
  }
}

export class RouteNavigator {
  private predictor: TrafficPredictor;
  private eventManager: EventManager;
  private graph: UrbanRoadGraph;

  constructor(predictor: TrafficPredictor, eventManager: EventManager) {
    this.predictor = predictor;
    this.eventManager = eventManager;
    this.graph = new UrbanRoadGraph(predictor.topology);
  }

  public getAvailableRoads(zone?: string | null) {
    const list: Array<Record<string, unknown>> = [];
    for (const [rId, info] of Object.entries(this.predictor.topology)) {
      if (zone && info.city_zone.toLowerCase() !== zone.toLowerCase()) continue;
      list.push(enrichRoadInfo({ ...info, road_id: rId }));
    }
    list.sort((a, b) => String(a.road_id).localeCompare(String(b.road_id)));
    return list;
  }

  private getTemporalProfile(hour: number) {
    if (hour >= 7 && hour <= 10) return { spdFactor: 0.72, volFactor: 1.45, cong: "High", isOffPeak: false };
    if (hour >= 17 && hour <= 20) return { spdFactor: 0.65, volFactor: 1.6, cong: "Severe", isOffPeak: false };
    if (hour >= 11 && hour <= 16) return { spdFactor: 0.92, volFactor: 1.05, cong: "Moderate", isOffPeak: false };
    return { spdFactor: 1.18, volFactor: 0.45, cong: "Low", isOffPeak: true };
  }

  public evaluateRoute(
    originRoadRaw: string,
    destRoadRaw: string,
    dateStr: string,
    timeStr: string,
    publishedOnly = true
  ) {
    const topo = this.predictor.topology;
    const allIds = Object.keys(topo);
    const originNorm = normalizeCorridorId(originRoadRaw);
    const destNorm = normalizeCorridorId(destRoadRaw);
    const originRoad = topo[originNorm] ? originNorm : allIds[0];
    const destRoad = topo[destNorm] ? destNorm : allIds[Math.min(3, allIds.length - 1)];

    const [hour] = parseTimeStr(timeStr);
    const parsedDate = new Date(`${dateStr}T${timeStr.slice(0, 5)}:00Z`);
    const jsDay = Number.isNaN(parsedDate.getTime()) ? 3 : parsedDate.getUTCDay();
    const dow = (jsDay + 6) % 7; // Python weekday: Mon=0..Sun=6
    const isWeekend = dow >= 5 ? 1 : 0;

    const profile = this.getTemporalProfile(hour);
    const zone = topo[originRoad]?.city_zone ?? "Indiranagar";

    const roadSpeeds: Record<string, number> = {};
    const roadVolumes: Record<string, number> = {};
    const roadEvents: Record<string, TrafficEvent[]> = {};

    for (const [rId, info] of Object.entries(topo)) {
      const evts = this.eventManager.findActiveEvents({
        roadId: rId,
        date: dateStr,
        timeStr,
        publishedOnly,
      });
      roadEvents[rId] = evts;
      const baseSpd = info.avg_speed * profile.spdFactor;
      const baseVol = Math.round(info.avg_volume * profile.volFactor);
      const speedPenalty = Math.max(0, ...evts.map((e) => Number(e.speed_impact_pct ?? 0))) / 100.0;
      const volSurge = evts.reduce((acc, e) => acc + Number(e.volume_surge_vph ?? 0), 0);
      roadSpeeds[rId] = Math.max(8.0, Math.min(80.0, baseSpd * (1.0 - speedPenalty)));
      roadVolumes[rId] = baseVol + volSurge;
    }

    const linkTimesNominal = new Map<string, number>();
    for (const [u, edges] of this.graph.adj.entries()) {
      for (const [v, lenKm] of edges) {
        const spd = roadSpeeds[v] ?? 30.0;
        linkTimesNominal.set(`${u}->${v}`, (lenKm / Math.max(spd, 8.0)) * 60.0);
      }
    }

    const [primaryRoute] = this.graph.dijkstraShortestPath(originRoad, destRoad, linkTimesNominal);

    const buildFeatures = (route: string[]) =>
      route.map((rId) => {
        const info = topo[rId];
        const vol = roadVolumes[rId] ?? info.avg_volume;
        const spd = roadSpeeds[rId] ?? info.avg_speed;
        const cap = Math.max(info.capacity || 45000, 1);
        return {
          city_zone: info.city_zone,
          road_id: rId,
          intersection_id: info.intersection_id,
          vehicle_count: vol,
          average_speed: spd,
          capacity_utilization: roundTo(Math.min(100, (vol / cap) * 100), 1),
          congestion_level: profile.cong,
          hour,
          day_of_week: dow,
          is_weekend: isWeekend,
        };
      });

    const primaryPredsBatch = this.predictor.predictBatch(buildFeatures(primaryRoute));
    const primaryPreds: CongestionLevel[] = [];
    const primaryDelays: number[] = [];
    const corridorEvents: TrafficEvent[] = [];

    for (let i = 0; i < primaryRoute.length; i++) {
      const rId = primaryRoute[i];
      const evts = roadEvents[rId] ?? [];
      corridorEvents.push(...evts);
      let predC = primaryPredsBatch[i][0];
      if (profile.isOffPeak && evts.length === 0) {
        predC = "Low";
      } else if (evts.length > 0) {
        const boost = Math.max(...evts.map((e) => Number(e.severity_boost ?? 1)));
        const curRank = CONGESTION_RANKS[predC] ?? 1;
        predC = RANK_TO_CONGESTION[Math.min(3, Math.max(curRank, 1 + boost))];
      }
      primaryPreds.push(predC);
      const lenKm = this.graph.roadLengths[rId] ?? 2.5;
      const spd = roadSpeeds[rId] ?? 25.0;
      const evtDelay = evts.reduce((acc, e) => acc + Number(e.severity_boost ?? 1) * 8.0, 0);
      primaryDelays.push((lenKm / Math.max(spd, 8.0)) * 60.0 + evtDelay);
    }

    const primaryTotalTime = primaryDelays.reduce((a, b) => a + b, 0);
    const maxRank = Math.max(...primaryPreds.map((p) => CONGESTION_RANKS[p] ?? 0));
    const primaryCongestion = RANK_TO_CONGESTION[maxRank] ?? "Moderate";

    const uniqueEventsMap = new Map<string, TrafficEvent>();
    for (const e of corridorEvents) uniqueEventsMap.set(e.id, e);
    const eventsList = Array.from(uniqueEventsMap.values());

    const primaryVolume = roadVolumes[originRoad] ?? 22000;
    const totalPrimaryLen = primaryRoute.reduce((acc, r) => acc + (this.graph.roadLengths[r] ?? 2.5), 0);
    const primarySpeed =
      primaryTotalTime > 0 ? roundTo(totalPrimaryLen / (primaryTotalTime / 60.0), 1) : roundTo(roadSpeeds[originRoad] ?? 30, 1);

    let isRerouted = false;
    let recommendedRoute = [...primaryRoute];
    let recommendedCongestion: CongestionLevel = primaryCongestion;
    let timeSaved = 0.0;
    let alternateVolume = primaryVolume;
    let alternateSpeed = primarySpeed;
    let bypassTotalTime = primaryTotalTime;

    if (primaryCongestion === "High" || primaryCongestion === "Severe" || eventsList.length > 0) {
      const bottleneckRoads = new Set<string>();
      primaryRoute.forEach((r, idx) => {
        if (primaryPreds[idx] === "High" || primaryPreds[idx] === "Severe") bottleneckRoads.add(r);
      });
      eventsList.forEach((e) => (e.affected_roads ?? []).forEach((r) => bottleneckRoads.add(r)));

      const penalized = new Map(linkTimesNominal);
      for (let k = 0; k < primaryRoute.length - 1; k++) {
        const u = primaryRoute[k];
        const v = primaryRoute[k + 1];
        if (bottleneckRoads.has(u) || bottleneckRoads.has(v)) {
          penalized.set(`${u}->${v}`, (penalized.get(`${u}->${v}`) ?? 5.0) + 30.0);
          penalized.set(`${v}->${u}`, (penalized.get(`${v}->${u}`) ?? 5.0) + 30.0);
        }
      }

      const [bypassRoute] = this.graph.dijkstraShortestPath(originRoad, destRoad, penalized);
      if (bypassRoute.join(",") !== primaryRoute.join(",") && bypassRoute.length >= 2) {
        const bypassBatch = this.predictor.predictBatch(buildFeatures(bypassRoute));
        const bypassDelays = bypassRoute.map((rId) => {
          const lenKm = this.graph.roadLengths[rId] ?? 2.5;
          const spd = roadSpeeds[rId] ?? 30.0;
          return (lenKm / Math.max(spd, 8.0)) * 60.0;
        });
        bypassTotalTime = bypassDelays.reduce((a, b) => a + b, 0);
        const savedMin = roundTo(primaryTotalTime - bypassTotalTime, 1);

        if (savedMin > 0.5) {
          isRerouted = true;
          recommendedRoute = bypassRoute;
          timeSaved = savedMin;
          const totalBypLen = bypassRoute.reduce((acc, r) => acc + (this.graph.roadLengths[r] ?? 2.5), 0);
          alternateSpeed = bypassTotalTime > 0 ? roundTo(totalBypLen / (bypassTotalTime / 60.0), 1) : 35.0;
          alternateVolume = roadVolumes[bypassRoute[0]] ?? primaryVolume;
          if (alternateSpeed >= 38.0) recommendedCongestion = "Low";
          else if (alternateSpeed >= 27.0) recommendedCongestion = "Moderate";
          else if (alternateSpeed >= 18.0) recommendedCongestion = "High";
          else {
            const recRank = Math.min(2, Math.max(...bypassBatch.map(([p]) => CONGESTION_RANKS[p] ?? 0)));
            recommendedCongestion = RANK_TO_CONGESTION[recRank];
          }
        }
      }
    }

    const origName = getRoadName(originRoad);
    const destName = getRoadName(destRoad);
    const primaryNames = primaryRoute.map(getRoadName);
    const recommendedNames = recommendedRoute.map(getRoadName);

    let narrative: string;
    if (isRerouted) {
      const eventDesc =
        eventsList.length > 0
          ? eventsList.map((e) => e.name).join(", ")
          : "Arterial saturation & bottleneck delay";
      const bypassMid = recommendedRoute.length > 2 ? recommendedRoute[1] : recommendedRoute[recommendedRoute.length - 1];
      const bypassMidName = getRoadName(bypassMid);
      narrative =
        `Bottleneck Detected on Primary Route (${origName} → ${destName}, ${primaryCongestion}): ${eventDesc}. ` +
        `Entering volume: ${primaryVolume.toLocaleString()} veh/hr at space-mean ${primarySpeed} km/h (Duration: ${roundTo(primaryTotalTime, 1)} min). ` +
        `Altered Dynamic Bypass Active via ${bypassMidName} [${bypassMid}] (${recommendedCongestion} Congestion). ` +
        `Bypass operates at ${alternateVolume.toLocaleString()} veh/hr at ${alternateSpeed} km/h (Duration: ${roundTo(bypassTotalTime, 1)} min). ` +
        `Physical travel time saved: ${timeSaved} minutes (estimated simulated benefit).`;
    } else {
      timeSaved = 0.0;
      narrative =
        `Primary Route is Optimal (${origName} → ${destName}: ${primaryCongestion} Congestion, ` +
        `${primaryVolume.toLocaleString()} veh/hr at space-mean ${primarySpeed} km/h, est. duration ${roundTo(primaryTotalTime, 1)} min). ` +
        `No faster alternate bypass exists on the network.`;
    }

    const primaryPolylines: [number, number][] = [];
    const primaryLaneGuidance = primaryRoute.map((rId, idx) => {
      primaryPolylines.push(...getCorridorCoordinates(rId));
      const laneMeta = getCorridorLaneInfo(rId);
      const predLos = primaryPreds[idx] ?? primaryCongestion;
      const laneRec =
        predLos === "High" || predLos === "Severe"
          ? "Assign through express lane (Lane 2+); avoid curbside merge delays"
          : "All lanes nominal free flow; maintain lane discipline";
      return {
        road_id: rId,
        road_name: getRoadName(rId),
        lanes: laneMeta.lanes,
        lane_breakdown: laneMeta.lane_breakdown,
        congestion: predLos,
        recommended_lane: laneRec,
        speed_kmh: roundTo(roadSpeeds[rId] ?? 35.0, 1),
        speed_limit_kmh: laneMeta.speed_limit_kmh,
      };
    });

    const recommendedPolylines: [number, number][] = [];
    const recommendedLaneGuidance = recommendedRoute.map((rId, idx) => {
      recommendedPolylines.push(...getCorridorCoordinates(rId));
      const laneMeta = getCorridorLaneInfo(rId);
      const recLos = isRerouted ? recommendedCongestion : (primaryPreds[idx] ?? primaryCongestion);
      const laneBreakdown = laneMeta.lane_breakdown;
      const laneRec = isRerouted
        ? `Optimal bypass lane: proceed via ${laneBreakdown[laneBreakdown.length > 1 ? 1 : 0] ?? "Lane 2"}`
        : "Follow primary route lanes";
      return {
        road_id: rId,
        road_name: getRoadName(rId),
        lanes: laneMeta.lanes,
        lane_breakdown: laneBreakdown,
        congestion: recLos,
        recommended_lane: laneRec,
        speed_kmh: roundTo(roadSpeeds[rId] ?? (isRerouted ? alternateSpeed : 35.0), 1),
        speed_limit_kmh: laneMeta.speed_limit_kmh,
      };
    });

    const recTotalTime = isRerouted ? bypassTotalTime : primaryTotalTime;

    return {
      origin_road: originRoad,
      destination_road: destRoad,
      date: dateStr,
      time: timeStr,
      departure_date: dateStr,
      departure_time: timeStr,
      city_zone: zone,
      primary_route: primaryRoute,
      primary_congestion: primaryCongestion,
      primary_travel_time_minutes: roundTo(primaryTotalTime, 1),
      recommended_travel_time_minutes: roundTo(recTotalTime, 1),
      is_historical_model_estimate: true,
      is_rerouted: isRerouted,
      recommended_route: recommendedRoute,
      recommended_congestion: recommendedCongestion,
      time_saved_minutes: timeSaved,
      estimated_time_saved_minutes: timeSaved,
      active_events: eventsList,
      recommendation_narrative: narrative,
      expected_vehicle_count: primaryVolume,
      corridor_speed_kmh: primarySpeed,
      alternate_vehicle_count: alternateVolume,
      alternate_speed_kmh: alternateSpeed,
      origin_road_name: origName,
      destination_road_name: destName,
      primary_route_names: primaryNames,
      recommended_route_names: recommendedNames,
      primary_lane_guidance: primaryLaneGuidance,
      recommended_lane_guidance: recommendedLaneGuidance,
      primary_polylines: primaryPolylines,
      recommended_polylines: recommendedPolylines,
    };
  }
}

// ---------------------------------------------------------------------------
// PolicySimulator (Greenshields Equilibrium + XGBoost Counterfactuals)
// ---------------------------------------------------------------------------

export class PolicySimulator {
  private predictor: TrafficPredictor;

  constructor(predictor: TrafficPredictor) {
    this.predictor = predictor;
  }

  public simulateZonePolicy(
    zone?: string | null,
    alphaDemandRaw = 0.2,
    betaSpeedRaw = 0.1,
    hour = 17,
    dayOfWeek = 3
  ) {
    const alphaDemand = Math.max(0.0, Math.min(0.5, Number(alphaDemandRaw) || 0));
    const betaSpeed = Math.max(0.0, Math.min(0.3, Number(betaSpeedRaw) || 0));
    const zoneFilter = zone && zone.toLowerCase() !== "all" ? zone.toLowerCase() : null;

    const targetRoads = Object.entries(this.predictor.topology).filter(
      ([, info]) => !zoneFilter || info.city_zone.toLowerCase() === zoneFilter
    );

    const beforeCounts: Record<CongestionLevel, number> = { Low: 0, Moderate: 0, High: 0, Severe: 0 };
    const afterCounts: Record<CongestionLevel, number> = { Low: 0, Moderate: 0, High: 0, Severe: 0 };
    const segmentDetails: Array<Record<string, unknown>> = [];

    let deEscalated = 0;
    let stable = 0;
    let worsened = 0;

    const featsBefore: Array<Record<string, unknown>> = [];
    const featsAfter: Array<Record<string, unknown>> = [];
    const metas: Array<{
      roadId: string;
      cityZone: string;
      intersectionId: string;
      simVol: number;
      simSpeed: number;
      simLos: CongestionLevel;
      baseLos: CongestionLevel;
    }> = [];

    for (const [rId, info] of targetRoads) {
      const baseVol = info.avg_volume;
      const baseSpeed = info.avg_speed;
      const baseCap = info.capacity || Math.round((info.peak_volume || baseVol) * 1.1);
      const freeSpeed = Math.min(90.0, Math.max(50.0, info.avg_speed * 1.3));
      const [, baseLos] = greenshieldsEquilibrium(baseVol, baseCap, freeSpeed);
      const peakLos = info.peak_congestion || baseLos;
      const losBefore: CongestionLevel = [17, 18, 19].includes(hour) ? peakLos : (info.common_congestion || baseLos);

      const fBefore = {
        city_zone: info.city_zone,
        road_id: rId,
        intersection_id: info.intersection_id,
        vehicle_count: baseVol,
        average_speed: baseSpeed,
        capacity_utilization: roundTo((baseVol / Math.max(baseCap, 1)) * 100, 1),
        congestion_level: losBefore,
        hour,
        day_of_week: dayOfWeek,
        is_weekend: dayOfWeek >= 5 ? 1 : 0,
      };

      const simVol = Math.round(baseVol * (1.0 - alphaDemand));
      const effectiveCap = Math.round(baseCap * (1.0 + 0.5 * betaSpeed));
      const [eqSpeed, simLos] = greenshieldsEquilibrium(simVol, effectiveCap, freeSpeed);

      const fAfter = {
        ...fBefore,
        vehicle_count: simVol,
        average_speed: eqSpeed,
        capacity_utilization: roundTo((simVol / Math.max(effectiveCap, 1)) * 100, 1),
        congestion_level: simLos,
      };

      featsBefore.push(fBefore);
      featsAfter.push(fAfter);
      metas.push({
        roadId: rId,
        cityZone: info.city_zone,
        intersectionId: info.intersection_id,
        simVol,
        simSpeed: eqSpeed,
        simLos,
        baseLos: losBefore,
      });
    }

    const predsBefore = this.predictor.predictBatch(featsBefore);
    const predsAfter = this.predictor.predictBatch(featsAfter);

    for (let i = 0; i < targetRoads.length; i++) {
      const predBMl = predsBefore[i][0];
      const predAMl = predsAfter[i][0];
      const meta = metas[i];

      const predBefore: CongestionLevel =
        meta.baseLos === "High" || meta.baseLos === "Severe" ? meta.baseLos : predBMl;
      let predAfter: CongestionLevel;
      if (alphaDemand === 0.0 && betaSpeed === 0.0) {
        predAfter = predBefore;
      } else {
        const simRank = CONGESTION_RANKS[meta.simLos] ?? 1;
        const mlRank = CONGESTION_RANKS[predAMl] ?? 1;
        const finalRank = Math.min(CONGESTION_RANKS[predBefore] ?? 3, Math.min(simRank, mlRank));
        predAfter = RANK_TO_CONGESTION[finalRank];
      }

      beforeCounts[predBefore] += 1;
      afterCounts[predAfter] += 1;

      const rB = CONGESTION_RANKS[predBefore] ?? 1;
      const rA = CONGESTION_RANKS[predAfter] ?? 1;
      let status = "Stable";
      if (rA < rB) {
        deEscalated += 1;
        status = "Improved";
      } else if (rA === rB) {
        stable += 1;
      } else {
        worsened += 1;
        status = "Degraded";
      }

      segmentDetails.push({
        road_id: meta.roadId,
        road_name: getRoadName(meta.roadId),
        city_zone: meta.cityZone,
        intersection_id: meta.intersectionId,
        pred_before: predBefore,
        pred_after: predAfter,
        status,
        simulated_volume: meta.simVol,
        simulated_speed: meta.simSpeed,
        demand_reduction_pct: roundTo(alphaDemand * 100, 1),
        speed_gain_pct: roundTo(betaSpeed * 100, 1),
      });
    }

    const total = targetRoads.length;
    const improvementRatePct = total > 0 ? roundTo((deEscalated / total) * 100, 2) : 0.0;

    return {
      zone: zone && zone.toLowerCase() !== "all" ? zone : "All Metropolitan Zones",
      provenance: "Simulation",
      is_simulated: true,
      disclaimer:
        "Congestion reductions and policy outcomes are simulated counterfactual estimates based on macroscopic Greenshields continuity and do not represent field-measured guarantees.",
      baseline_assumptions: {
        macroscopic_model: "Greenshields continuity q = k * v(k)",
        jam_density_k_jam_veh_per_km: 120.0,
        pcu_modal_weights: { car: 1.0, truck_heavy: 2.5, two_wheeler: 0.5, bus: 2.0 },
        demand_reduction_mechanism: "Perimeter corridor diversion (alpha)",
        capacity_enhancement_mechanism: "Adaptive signal coordination and green split optimization (beta)",
        reproducibility: "Deterministic macroscopic simulation given (zone, alpha, beta, hour, day_of_week)",
      },
      scenario_inputs: {
        zone: zone ?? null,
        alpha_demand_reduction: alphaDemand,
        beta_speed_gain: betaSpeed,
        hour,
        day_of_week: dayOfWeek,
      },
      total_segments_evaluated: total,
      policy_parameters: {
        alpha_demand_reduction: alphaDemand,
        beta_speed_gain: betaSpeed,
      },
      summary: {
        improved_segments: deEscalated,
        improved_pct: improvementRatePct,
        stable_segments: stable,
        worsened_segments: worsened,
      },
      distribution_before: beforeCounts,
      distribution_after: afterCounts,
      segment_sample: segmentDetails.slice(0, 25),
    };
  }
}

// ---------------------------------------------------------------------------
// JunctionService (Webster Signal Optimization & Approach Dynamics)
// ---------------------------------------------------------------------------

export class JunctionService {
  private predictor: TrafficPredictor;
  private eventManager: EventManager;

  constructor(predictor: TrafficPredictor, eventManager: EventManager) {
    this.predictor = predictor;
    this.eventManager = eventManager;
  }

  private getScheduleProfile(hour: number) {
    if (hour >= 7 && hour < 10) return { name: "Morning Inflow Commute Peak", tier: "Peak", flow_multiplier: 1.25 };
    if (hour >= 10 && hour < 12) return { name: "Midday Arterial Flow", tier: "Steady", flow_multiplier: 0.85 };
    if (hour >= 12 && hour < 14) return { name: "Afternoon Commercial Peak", tier: "Moderate", flow_multiplier: 1.05 };
    if (hour >= 14 && hour < 16) return { name: "Inter-District Transit Corridor", tier: "Steady", flow_multiplier: 0.9 };
    if (hour >= 16 && hour < 20) return { name: "Evening Commute Rush Hour", tier: "Critical Peak", flow_multiplier: 1.35 };
    if (hour >= 20 && hour < 23) return { name: "Late Evening Redistribution", tier: "Moderate", flow_multiplier: 0.65 };
    return { name: "Night Arterial Free Flow", tier: "Off-Peak", flow_multiplier: 0.25 };
  }

  public getJunctionTelemetry(opts: {
    roadId: string;
    hour?: number;
    minute?: number;
    isRerouted?: boolean;
    alternateRoadId?: string | null;
    dateStr?: string;
  }) {
    const hour = Math.max(0, Math.min(23, Math.trunc(opts.hour ?? 17)));
    const minute = Math.max(0, Math.min(59, Math.trunc(opts.minute ?? 0)));
    const topo = this.predictor.topology;
    const normId = normalizeCorridorId(opts.roadId);
    const roadId = topo[normId] ? normId : Object.keys(topo)[0];
    const roadInfo = topo[roadId];

    const intersectionId = roadInfo.intersection_id || `INT_${roadId.replace("RD_", "")}`;
    const zone = roadInfo.city_zone || "Indiranagar";
    const roadName = getRoadName(roadId);
    const intersectionName = getIntersectionName(intersectionId);

    const sched = this.getScheduleProfile(hour);
    const baseVol = [17, 18, 19].includes(hour) ? roadInfo.peak_volume : roadInfo.avg_volume;
    const directionalVol = baseVol > 5000 ? Math.round(baseVol * 0.045) : Math.round(baseVol * 0.55);
    const volEffective = Math.round(directionalVol * sched.flow_multiplier);
    const baseSpeed = [17, 18, 19].includes(hour) ? roadInfo.peak_speed : roadInfo.avg_speed;
    const speedEffective = roundTo(Math.max(15.0, baseSpeed / sched.flow_multiplier), 1);

    const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const events = this.eventManager.findActiveEvents({
      roadId,
      date: opts.dateStr || undefined,
      timeStr,
    });
    const hasEvent = events.length > 0;
    const phaseBoost = hasEvent ? 10.0 : 0.0;

    const pcuVol = computePcu(volEffective);
    const ewPcuVol = Math.max(180, Math.trunc(pcuVol * 0.55));
    const signals = optimizeIntersectionSignals(pcuVol, ewPcuVol, 2, 2, phaseBoost);

    const isRerouted = Boolean(opts.isRerouted);
    const intentStraight = isRerouted ? 18 : 92;
    const intentBypassTurn = isRerouted ? 82 : 8;
    const bypassCorridor = isRerouted ? opts.alternateRoadId || "Designated Perimeter Bypass" : null;
    const junctionMode = isRerouted ? "BYPASS_DIVERSION" : "STANDARD_MAINLINE";
    const routeStatusText = isRerouted
      ? `Diverting volume to ${bypassCorridor} to bypass ${roadId} queue`
      : "Standard arterial progression";

    const approaches = [
      {
        approach_direction: "Northbound Mainline",
        lanes: 2,
        volume_vph: Math.round(volEffective * 0.55),
        pcu_vph: Math.round(pcuVol * 0.55),
        saturation_flow_vph: 3600,
        degree_of_saturation: signals.degree_of_saturation_ns,
        queue_length_meters: signals.queue_meters_ns,
        queue_vehicles: signals.queue_vehicles_ns,
        effective_green_sec: signals.ns_green_sec,
        control_delay_sec: signals.estimated_delay_sec,
        level_of_service: signals.level_of_service,
      },
      {
        approach_direction: "Southbound Departure",
        lanes: 2,
        volume_vph: Math.round(volEffective * 0.45),
        pcu_vph: Math.round(pcuVol * 0.45),
        saturation_flow_vph: 3600,
        degree_of_saturation: roundTo(signals.degree_of_saturation_ns * 0.85, 2),
        queue_length_meters: roundTo(signals.queue_meters_ns * 0.8, 1),
        queue_vehicles: roundTo(signals.queue_vehicles_ns * 0.8, 1),
        effective_green_sec: signals.ns_green_sec,
        control_delay_sec: roundTo(signals.estimated_delay_sec * 0.85, 1),
        level_of_service: signals.level_of_service,
      },
      {
        approach_direction: "Eastbound Crossflow",
        lanes: 2,
        volume_vph: Math.round(ewPcuVol * 0.5),
        pcu_vph: Math.round(ewPcuVol * 0.5),
        saturation_flow_vph: 3600,
        degree_of_saturation: signals.degree_of_saturation_ew,
        queue_length_meters: roundTo(signals.queue_meters_ns * 0.5, 1),
        queue_vehicles: roundTo(signals.queue_vehicles_ns * 0.5, 1),
        effective_green_sec: signals.ew_green_sec,
        control_delay_sec: roundTo(signals.estimated_delay_sec * 0.7, 1),
        level_of_service: getHcmLos(signals.estimated_delay_sec * 0.7),
      },
      {
        approach_direction: "Westbound Crossflow",
        lanes: 2,
        volume_vph: Math.round(ewPcuVol * 0.5),
        pcu_vph: Math.round(ewPcuVol * 0.5),
        saturation_flow_vph: 3600,
        degree_of_saturation: signals.degree_of_saturation_ew,
        queue_length_meters: roundTo(signals.queue_meters_ns * 0.5, 1),
        queue_vehicles: roundTo(signals.queue_vehicles_ns * 0.5, 1),
        effective_green_sec: signals.ew_green_sec,
        control_delay_sec: roundTo(signals.estimated_delay_sec * 0.7, 1),
        level_of_service: getHcmLos(signals.estimated_delay_sec * 0.7),
      },
    ];

    const trackedVehicles = [
      { id: "CAR 47", status: isRerouted ? "Diverted via Bypass" : "Mainline Progression", speed_kmh: speedEffective, is_diverted: isRerouted, is_simulated: true },
      { id: "CAR 89", status: "Inbound Northbound", speed_kmh: roundTo(speedEffective * 0.9, 1), is_diverted: false, is_simulated: true },
      { id: "CAR 12", status: "Queue Clearance", speed_kmh: roundTo(speedEffective * 0.5, 1), is_diverted: false, is_simulated: true },
      { id: "CAR 35", status: "At Stop Line", speed_kmh: 0.0, is_diverted: false, is_simulated: true },
      { id: "CAR 94", status: "Bypass Turning", speed_kmh: speedEffective, is_diverted: true, is_simulated: true },
    ];

    return {
      intersection_id: intersectionId,
      intersection_name: intersectionName,
      road_id: roadId,
      road_name: roadName,
      city_zone: zone,
      provenance: "Simulation",
      is_simulated: true,
      is_recommendation_only: true,
      data_provenance: "Junction Signal Control Simulation Engine",
      disclaimer:
        "Junction telemetry and signal timings are simulated model outputs for advisory analysis. Actual traffic signal actuation requires authorized integration with municipal traffic-control infrastructure.",
      telemetry_mode: "SIMULATED_JUNCTION_OBSERVER",
      schedule: sched,
      hourly_volume_vph: volEffective,
      pcu_volume_vph: pcuVol,
      historical_speed_kmh: speedEffective,
      congestion_level: roadInfo.common_predicted || "Moderate",
      signals: {
        cycle_seconds: signals.optimal_cycle_sec,
        optimal_cycle_sec: signals.optimal_cycle_sec,
        ns_green_seconds: signals.ns_green_sec,
        ns_green_sec: signals.ns_green_sec,
        ew_green_seconds: signals.ew_green_sec,
        ew_green_sec: signals.ew_green_sec,
        amber_seconds: signals.amber_sec,
        all_red_seconds: signals.all_red_sec,
        level_of_service: signals.level_of_service,
        delay_saved_sec: signals.delay_saved_sec,
        total_delay_saved_vph: signals.total_delay_saved_vph,
      },
      event_impact: {
        has_event: hasEvent,
        event_name: hasEvent ? events[0].name : null,
        severity_boost: hasEvent ? events[0].severity_boost : 0,
        lane_restriction: hasEvent ? events[0].description : "All lanes open",
      },
      junction_mode: junctionMode,
      is_rerouted: isRerouted,
      bypass_corridor: bypassCorridor,
      intent_split: {
        straight_pct: intentStraight,
        bypass_turn_pct: intentBypassTurn,
      },
      route_status_text: routeStatusText,
      approaches,
      primary_vehicle: trackedVehicles[0],
      tracked_vehicles: trackedVehicles,
      pcu_modal_split: {
        passenger_cars_pct: 65,
        two_wheelers_pct: 18,
        buses_transit_pct: 10,
        heavy_commercial_pct: 7,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// HeatmapService (Tri-Pillar Spatio-Temporal Heatmap Engine)
// ---------------------------------------------------------------------------

export class HeatmapService {
  private predictor: TrafficPredictor;
  private junctionService: JunctionService;
  private eventManager: EventManager;

  constructor(predictor: TrafficPredictor, junctionService: JunctionService, eventManager: EventManager) {
    this.predictor = predictor;
    this.junctionService = junctionService;
    this.eventManager = eventManager;
  }

  private interpolatePolyline(coords: [number, number][], subDivisions = 3): [number, number][] {
    if (coords.length < 2) return coords;
    const out: [number, number][] = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const p1 = coords[i];
      const p2 = coords[i + 1];
      out.push(p1);
      for (let step = 1; step < subDivisions; step++) {
        const ratio = step / subDivisions;
        out.push([
          roundTo(p1[0] + (p2[0] - p1[0]) * ratio, 6),
          roundTo(p1[1] + (p2[1] - p1[1]) * ratio, 6),
        ]);
      }
    }
    out.push(coords[coords.length - 1]);
    return out;
  }

  private calculatePredictionWeight(
    currentLos: CongestionLevel,
    probDist: Record<string, number>,
    horizonMinutes: number
  ): { weight: number; projLos: CongestionLevel; interpProbs: Record<string, number> } {
    const losBaseProbs: Record<CongestionLevel, Record<CongestionLevel, number>> = {
      Low: { Low: 0.85, Moderate: 0.12, High: 0.02, Severe: 0.01 },
      Moderate: { Low: 0.15, Moderate: 0.7, High: 0.12, Severe: 0.03 },
      High: { Low: 0.03, Moderate: 0.17, High: 0.65, Severe: 0.15 },
      Severe: { Low: 0.01, Moderate: 0.04, High: 0.2, Severe: 0.75 },
    };
    const t0 = losBaseProbs[currentLos] ?? losBaseProbs.Moderate;
    const tau = Math.max(0.0, Math.min(1.0, horizonMinutes / 60.0));
    const classes: CongestionLevel[] = ["Low", "Moderate", "High", "Severe"];
    const interpProbs: Record<string, number> = {};
    let sum = 0;
    for (const cls of classes) {
      const p0 = t0[cls];
      const p60 = probDist[cls] ?? p0;
      const val = (1 - tau) * p0 + tau * p60;
      interpProbs[cls] = val;
      sum += val;
    }
    let projLos: CongestionLevel = "Moderate";
    let bestP = -1;
    for (const cls of classes) {
      interpProbs[cls] = roundTo(interpProbs[cls] / (sum || 1), 4);
      if (interpProbs[cls] > bestP) {
        bestP = interpProbs[cls];
        projLos = cls;
      }
    }
    const rawW =
      1.0 * interpProbs.Severe +
      0.75 * interpProbs.High +
      0.45 * interpProbs.Moderate +
      0.15 * interpProbs.Low;
    const weight = roundTo(Math.max(0.15, Math.min(1.0, rawW)), 3);
    return { weight, projLos, interpProbs };
  }

  private computeTrafficLayer(
    horizonMinutes: number,
    nowDt: Date,
    liveTelemetry?: CorridorTelemetryItem[]
  ) {
    const hour = nowDt.getHours();
    const dow = (nowDt.getDay() + 6) % 7;
    const isWeekend = dow >= 5 ? 1 : 0;
    const isPeak = [8, 9, 17, 18, 19].includes(hour);
    const liveMap = new Map<string, CorridorTelemetryItem>(
      (liveTelemetry ?? []).map((item) => [item.road_id, item])
    );

    return Object.entries(ROAD_REGISTRY).map(([rId, info]) => {
      const geo = CORRIDOR_GEO_REGISTRY[rId];
      let coords = getCorridorCoordinates(rId);
      if (coords.length < 2) {
        const gps = BENGALURU_CORRIDOR_GPS[rId] ?? { lat: 12.9716, lon: 77.5946 };
        coords = [[gps.lat, gps.lon], [gps.lat + 0.005, gps.lon + 0.005]];
      }
      const lanes = geo?.lanes ?? 4;
      const speedLimit = geo?.speed_limit_kmh ?? 50.0;
      const topo = this.predictor.topology[rId];
      const live = liveMap.get(rId);
      const freeFlowSpd = live?.free_flow_speed ?? BENGALURU_CORRIDOR_GPS[rId]?.free_flow ?? speedLimit;

      let baseVol = live?.vehicle_count ?? (topo ? (isPeak ? topo.peak_volume : topo.avg_volume) : 22000);
      let baseSpd = live?.current_speed ?? (topo ? (isPeak ? topo.peak_speed : topo.avg_speed) : 34.0);
      const sevAtT0 = classifyTrafficSeverity(baseSpd, freeFlowSpd);
      let currentLos: CongestionLevel = live
        ? sevAtT0.los
        : (topo?.common_congestion ?? sevAtT0.los);

      const activeEvents = this.eventManager.findActiveEvents({ roadId: rId });
      // Live TomTom GPS probe speeds at T0 already reflect active on-road slowdowns;
      // only apply synthetic event slowdown for non-live baselines or future horizons.
      if (activeEvents.length > 0 && (!live?.is_live || horizonMinutes > 0)) {
        baseVol = Math.round(baseVol * 1.2);
        baseSpd = Math.max(8.0, roundTo(baseSpd * 0.78, 1));
        const eventSev = classifyTrafficSeverity(baseSpd, freeFlowSpd);
        currentLos =
          CONGESTION_RANKS[eventSev.los] > CONGESTION_RANKS[currentLos]
            ? eventSev.los
            : currentLos;
      }

      const capUtil =
        live?.capacity_utilization ??
        roundTo(Math.min(100.0, (baseVol / Math.max(1000.0, lanes * 900.0)) * 100.0), 1);

      let probDist: Record<string, number>;
      if (live?.prediction_probabilities && Object.keys(live.prediction_probabilities).length > 0 && activeEvents.length === 0) {
        probDist = live.prediction_probabilities;
      } else {
        const [, predictedProbs] = this.predictor.predictSegment({
          city_zone: info.city_zone,
          road_id: rId,
          intersection_id: info.intersection_id,
          vehicle_count: baseVol,
          average_speed: baseSpd,
          capacity_utilization: capUtil,
          congestion_level: currentLos,
          hour,
          day_of_week: dow,
          is_weekend: isWeekend,
        });
        probDist = predictedProbs;
      }

      const { weight: predWeight, projLos, interpProbs } = this.calculatePredictionWeight(
        currentLos,
        probDist,
        horizonMinutes
      );

      // At live T0, preserve continuous speed-calibrated severity weight so green/amber/orange/red
      // faithfully mirrors live speeds; smoothly blend toward XGBoost projection as horizon increases.
      const tau = Math.max(0.0, Math.min(1.0, horizonMinutes / 60.0));
      const t0Severity = classifyTrafficSeverity(baseSpd, freeFlowSpd);
      const effectiveLos: CongestionLevel = horizonMinutes === 0 ? currentLos : projLos;
      const weight = roundTo(
        Math.max(0.12, Math.min(1.0, (1 - tau) * t0Severity.weight + tau * predWeight)),
        3
      );
      const color = getLosColor(effectiveLos);
      const spi = calculateSpi(baseSpd, freeFlowSpd);
      const clampedSpd = Math.max(5.0, baseSpd);
      const densityKPerLane = roundTo(Math.min(150.0, baseVol / clampedSpd / Math.max(1, lanes)), 1);
      const totalDensityK = roundTo(densityKPerLane * lanes, 1);

      const interpolatedPts = this.interpolatePolyline(coords, 3);
      const subSegments = interpolatedPts.map((pt, idx) => ({
        segment_idx: idx,
        lat: pt[0],
        lng: pt[1],
        weight,
        density_k: densityKPerLane,
        total_density_k: totalDensityK,
        predicted_los: effectiveLos,
        color,
        prob_dist: interpProbs,
        speed_kmh: roundTo(baseSpd, 1),
        free_flow_speed_kmh: roundTo(freeFlowSpd, 1),
        speed_limit_kmh: speedLimit,
        spi,
      }));

      return {
        road_id: rId,
        road_name: getRoadName(rId),
        city_zone: info.city_zone,
        lanes,
        sub_segments: subSegments,
        primary_weight: weight,
        predicted_los: effectiveLos,
        color,
        speed_kmh: roundTo(baseSpd, 1),
        free_flow_speed_kmh: roundTo(freeFlowSpd, 1),
        spi,
        is_live: Boolean(live?.is_live),
        source: live?.source ?? "Empirical Baseline",
      };
    });
  }

  private computeRegionLayer(
    trafficSegments: ReturnType<HeatmapService["computeTrafficLayer"]>
  ) {
    const byZone = new Map<string, ReturnType<HeatmapService["computeTrafficLayer"]>>();
    for (const seg of trafficSegments) {
      const list = byZone.get(seg.city_zone) ?? [];
      list.push(seg);
      byZone.set(seg.city_zone, list);
    }

    return BENGALURU_SECTOR_REGIONS.map((reg) => {
      const members = byZone.get(reg.city_zone) ?? [];
      const count = members.length || 1;
      const avgSpeed = roundTo(
        members.reduce((acc, m) => acc + m.speed_kmh, 0) / count,
        1
      );
      const avgFreeFlow = roundTo(
        members.reduce((acc, m) => acc + m.free_flow_speed_kmh, 0) / count,
        1
      );
      const avgWeight = roundTo(
        members.reduce((acc, m) => acc + m.primary_weight, 0) / count,
        3
      );
      const maxWeight = roundTo(
        members.reduce((acc, m) => Math.max(acc, m.primary_weight), 0),
        3
      );
      const counts = { Low: 0, Moderate: 0, High: 0, Severe: 0 };
      let liveCount = 0;
      for (const m of members) {
        counts[m.predicted_los] = (counts[m.predicted_los] ?? 0) + 1;
        if (m.is_live) liveCount++;
      }

      // Compute region-level severity directly from member SPI & congestion mix:
      // More traffic / low SPI => Red/Orange; Less traffic / high SPI => Green.
      const avgSpi = roundTo(
        members.reduce((acc, m) => acc + m.spi, 0) / count,
        1
      );
      const baseSev = classifyTrafficSeverity(avgSpeed, avgFreeFlow);
      let regionLos: CongestionLevel = baseSev.los;
      if (counts.Severe >= 2 || (counts.Severe >= 1 && avgSpi < 56.0)) {
        regionLos = "Severe";
      } else if (counts.Severe >= 1 && regionLos === "Low") {
        regionLos = "Moderate";
      } else if (counts.High + counts.Severe >= 2 && avgSpi < 68.0) {
        regionLos = "High";
      } else if (avgSpi >= 78.0 && counts.Severe === 0 && counts.High === 0) {
        regionLos = "Low";
      } else if (counts.Low >= 2 && counts.Severe === 0 && avgSpi >= 74.0) {
        regionLos = "Low";
      }

      const sortedWorst = members
        .slice()
        .sort((a, b) => b.primary_weight - a.primary_weight || a.speed_kmh - b.speed_kmh);
      const worst = sortedWorst[0];

      return {
        region_id: reg.region_id,
        city_zone: reg.city_zone,
        short_label: reg.short_label,
        center: reg.center,
        polygon: reg.polygon,
        avg_speed_kmh: avgSpeed,
        free_flow_speed_kmh: avgFreeFlow,
        spi: calculateSpi(avgSpeed, avgFreeFlow),
        severity_score: avgWeight,
        peak_severity_score: maxWeight,
        congestion_level: regionLos,
        color: getLosColor(regionLos),
        corridor_count: members.length,
        corridor_ids: members.map((m) => m.road_id),
        status_counts: counts,
        is_live: liveCount > 0,
        worst_corridor: worst
          ? {
              road_id: worst.road_id,
              road_name: worst.road_name,
              speed_kmh: worst.speed_kmh,
              predicted_los: worst.predicted_los,
            }
          : null,
      };
    });
  }

  private computeCrowdLayer(hour: number) {
    const hubs = [
      { hub_id: "HUB_BLR_01", name: "Majestic KSRTC & Metro Central Interchange", city_zone: "Central Spine", lat: 12.9774, lng: 77.5708, base: 2400, area: 750.0, road: "RD_BLR_02", spd: 22.0 },
      { hub_id: "HUB_BLR_02", name: "Silk Board Bus Bay & Hosur Road Junction", city_zone: "South Corridor", lat: 12.9174, lng: 77.6235, base: 1950, area: 600.0, road: "RD_BLR_11", spd: 35.0 },
      { hub_id: "HUB_BLR_03", name: "Indiranagar 100ft Road / CMH Metro Crosswalk", city_zone: "East Corridor", lat: 12.9784, lng: 77.6408, base: 1350, area: 500.0, road: "RD_BLR_01", spd: 28.0 },
      { hub_id: "HUB_BLR_04", name: "Brigade Road & MG Road Retail Promenade", city_zone: "Commercial Core", lat: 12.9730, lng: 77.6075, base: 2800, area: 850.0, road: "RD_BLR_18", spd: 18.0 },
      { hub_id: "HUB_BLR_05", name: "Electronic City Phase 1 Transit Toll Plaza", city_zone: "Tech Park Spine", lat: 12.8399, lng: 77.6770, base: 1600, area: 700.0, road: "RD_BLR_20", spd: 45.0 },
      { hub_id: "HUB_BLR_06", name: "Hebbal Flyover & Ring Road Interchange Base", city_zone: "North Corridor", lat: 13.0358, lng: 77.5970, base: 1200, area: 550.0, road: "RD_BLR_03", spd: 48.0 },
    ];
    const mult =
      (hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 20)
        ? 1.35
        : hour >= 12 && hour <= 15
          ? 1.05
          : hour >= 21 && hour <= 23
            ? 0.65
            : 0.25;

    return hubs.map((h) => {
      const pedsHr = Math.trunc(h.base * mult);
      const instantPeds = Math.round((pedsHr / 3600.0) * 30.0);
      const pedDensitySqm = roundTo(instantPeds / h.area, 2);
      const vruIndex = roundTo(Math.min(1.0, Math.max(0.05, (pedDensitySqm / 2.0) * 0.6 + Math.pow(h.spd / 50.0, 2) * 0.4)), 3);
      return {
        hub_id: h.hub_id,
        name: h.name,
        city_zone: h.city_zone,
        lat: h.lat,
        lng: h.lng,
        connected_road_id: h.road,
        pedestrians_per_hour: pedsHr,
        active_pedestrian_cluster: instantPeds,
        ped_density_sqm: pedDensitySqm,
        fruin_los: getFruinLos(pedDensitySqm),
        vru_conflict_index: vruIndex,
        weight: vruIndex,
      };
    });
  }

  private computeJunctionLayer(
    hour: number,
    minute: number,
    horizonMinutes: number,
    trafficSegments?: ReturnType<HeatmapService["computeTrafficLayer"]>
  ) {
    const trafficById = new Map<
      string,
      { primary_weight: number; predicted_los: CongestionLevel; speed_kmh: number; color: string }
    >();
    for (const seg of trafficSegments ?? []) {
      trafficById.set(seg.road_id, {
        primary_weight: seg.primary_weight,
        predicted_los: seg.predicted_los,
        speed_kmh: seg.speed_kmh,
        color: seg.color,
      });
    }

    return Object.entries(ROAD_REGISTRY).map(([rId, info]) => {
      const gps = BENGALURU_CORRIDOR_GPS[rId] ?? { lat: 12.9716, lon: 77.5946 };
      const intId = info.intersection_id || `INT_${rId.replace("RD_", "")}`;
      const intName = getIntersectionName(intId) || info.intersection_name || rId;
      const corTraffic = trafficById.get(rId);
      const primaryWeight = corTraffic?.primary_weight ?? 0.45;
      const predLos = corTraffic?.predicted_los;
      const speedKmh = corTraffic?.speed_kmh ?? 30.0;

      const jTel = this.junctionService.getJunctionTelemetry({ roadId: rId, hour, minute });
      const nb = jTel.approaches[0];
      const sig = jTel.signals;

      let qMeters = nb?.queue_length_meters ?? 45.0;
      let qVeh = nb?.queue_vehicles ?? 6.0;
      let delaySec = nb?.control_delay_sec ?? 24.0;
      let hcmLos = nb?.level_of_service ?? "LOS C (Stable Flow)";
      let satDeg = nb?.degree_of_saturation ?? 0.65;

      const cleanLos: CongestionLevel =
        predLos ??
        (hcmLos.includes("LOS E") || hcmLos.includes("LOS F")
          ? "Severe"
          : hcmLos.includes("LOS D")
            ? "High"
            : hcmLos.includes("LOS C")
              ? "Moderate"
              : "Low");

      let alertLevel = "FREE_FLOW";
      let isJamHotspot = false;
      let spillback = "Minimal";
      let alertColor = "#10b981";
      let alertTitle = "FREE FLOW";
      let alertBadge = "CLEAR";

      if (cleanLos === "Severe") {
        alertLevel = "JAM_ALERT";
        isJamHotspot = true;
        hcmLos = "LOS F (Severe Jam)";
        qMeters = Math.min(450.0, Math.max(qMeters, roundTo(180.0 + primaryWeight * 110.0, 1)));
        qVeh = Math.min(65.0, roundTo(qMeters / 6.0, 1));
        delaySec = Math.max(delaySec, roundTo(65.0 + primaryWeight * 50.0, 1));
        satDeg = Math.max(satDeg, roundTo(Math.min(1.2, 0.95 + primaryWeight * 0.2), 2));
        spillback = "Critical Spillback";
        alertColor = "#ef4444";
        alertTitle = "SEVERE TRAFFIC JAM";
        alertBadge = "JAM ALERT";
      } else if (cleanLos === "High") {
        alertLevel = "HIGH_CONGESTION";
        isJamHotspot = false;
        hcmLos = "LOS E (High Congestion)";
        qMeters = Math.min(450.0, Math.max(qMeters, roundTo(95.0 + primaryWeight * 65.0, 1)));
        qVeh = Math.min(65.0, roundTo(qMeters / 6.0, 1));
        delaySec = Math.max(delaySec, roundTo(45.0 + primaryWeight * 25.0, 1));
        satDeg = Math.max(satDeg, roundTo(Math.min(0.94, 0.82 + primaryWeight * 0.12), 2));
        spillback = "High Spillback Risk";
        alertColor = "#f97316";
        alertTitle = "HEAVY CONGESTION";
        alertBadge = "HEAVY FLOW";
      } else if (cleanLos === "Moderate") {
        alertLevel = "MODERATE";
        hcmLos = "LOS C (Moderate Flow)";
        qMeters = Math.min(qMeters, 75.0);
        qVeh = Math.min(65.0, roundTo(qMeters / 6.0, 1));
        spillback = "Moderate";
        alertColor = "#f59e0b";
        alertTitle = "MODERATE TRAFFIC";
        alertBadge = "MODERATE";
      } else {
        hcmLos = "LOS A (Free Flow)";
        qMeters = Math.min(qMeters, 25.0);
        qVeh = Math.min(65.0, roundTo(qMeters / 6.0, 1));
      }

      return {
        junction_id: intId,
        name: intName,
        road_id: rId,
        city_zone: info.city_zone,
        lat: gps.lat,
        lng: gps.lon,
        speed_kmh: speedKmh,
        queue_meters: roundTo(qMeters, 1),
        queue_vehicles: roundTo(qVeh, 1),
        control_delay_sec: roundTo(delaySec, 1),
        hcm_los: hcmLos,
        degree_of_saturation: roundTo(satDeg, 2),
        webster_cycle_sec: roundTo(sig.optimal_cycle_sec, 1),
        green_split_ns_sec: roundTo(sig.ns_green_sec, 1),
        green_split_ew_sec: roundTo(sig.ew_green_sec, 1),
        spillback_risk: spillback,
        weight: roundTo(Math.min(1.0, Math.max(0.15, primaryWeight)), 3),
        alert_level: alertLevel,
        is_jam_hotspot: isJamHotspot,
        alert_color: alertColor,
        alert_title: alertTitle,
        alert_badge: alertBadge,
        predicted_los: cleanLos,
        predicted_horizon_min: horizonMinutes,
      };
    });
  }

  public getTriPillarHeatmap(
    horizonMinutes = 0,
    channel = "all",
    liveTelemetry?: CorridorTelemetryItem[]
  ) {
    const nowDt = new Date();
    const hMin = Math.max(0, Math.min(60, Math.trunc(horizonMinutes)));
    const ch = String(channel || "all").toLowerCase().trim();
    const liveCount = (liveTelemetry ?? []).filter((t) => t.is_live).length;

    const result: Record<string, unknown> = {
      success: true,
      status: "success",
      horizon_minutes: hMin,
      timestamp: nowIso(),
      provenance: {
        source: liveCount > 0 ? "live_tomtom_tri_pillar_engine" : "multi_channel_tri_pillar_engine",
        is_live: liveCount > 0,
        live_corridor_count: liveCount,
        traffic_model: "XGBoost 80-Tree Ensemble (hist)",
        pedestrian_model: "Fruin Walkway LOS & VRU Conflict Formulation",
        junction_model: "Webster Optimal Cycle & Akcelik Delay Formulation (IRC:93)",
      },
    };

    let trafficLayer: ReturnType<HeatmapService["computeTrafficLayer"]> | undefined;
    if (ch === "all" || ch === "traffic" || ch === "junctions" || ch === "junction" || ch === "regions") {
      trafficLayer = this.computeTrafficLayer(hMin, nowDt, liveTelemetry);
      if (ch === "all" || ch === "traffic") {
        result.traffic_layer = trafficLayer;
      }
      if (ch === "all" || ch === "traffic" || ch === "regions") {
        result.region_layer = this.computeRegionLayer(trafficLayer);
      }
      const counts = { Low: 0, Moderate: 0, High: 0, Severe: 0 };
      let spdSum = 0;
      for (const seg of trafficLayer) {
        counts[seg.predicted_los] = (counts[seg.predicted_los] ?? 0) + 1;
        spdSum += seg.speed_kmh;
      }
      result.summary = {
        low_count: counts.Low,
        moderate_count: counts.Moderate,
        high_count: counts.High,
        severe_count: counts.Severe,
        total_corridors: trafficLayer.length,
        live_corridor_count: liveCount,
        avg_city_speed_kmh: roundTo(spdSum / Math.max(1, trafficLayer.length), 1),
      };
    }
    if (ch === "all" || ch === "crowd") {
      result.crowd_layer = this.computeCrowdLayer(nowDt.getHours());
    }
    if (ch === "all" || ch === "junctions" || ch === "junction") {
      result.junction_layer = this.computeJunctionLayer(nowDt.getHours(), nowDt.getMinutes(), hMin, trafficLayer);
    }

    return result;
  }

  public getLegacyPointsProjection(liveTelemetry?: CorridorTelemetryItem[]) {
    const tri = this.getTriPillarHeatmap(0, "traffic", liveTelemetry);
    const trafficLayer = (tri.traffic_layer ?? []) as ReturnType<HeatmapService["computeTrafficLayer"]>;
    const points: Array<Record<string, unknown>> = [];
    for (const cor of trafficLayer) {
      for (const seg of cor.sub_segments) {
        const flow = Math.round(seg.density_k * seg.speed_kmh);
        points.push({
          lat: seg.lat,
          lng: seg.lng,
          weight: seg.weight,
          intensity: seg.weight,
          density: seg.density_k,
          density_k: seg.density_k,
          congestion: seg.predicted_los,
          color: seg.color,
          road_id: cor.road_id,
          corridor_id: cor.road_id,
          road_name: cor.road_name,
          speed: seg.speed_kmh,
          speed_kmh: seg.speed_kmh,
          flow,
          vehicle_count: flow,
          capacity_utilization: roundTo(seg.weight * 100.0, 1),
          is_clamped_physical: true,
        });
      }
    }
    return {
      success: true,
      status: "success",
      point_count: points.length,
      max_weight: 1.0,
      points,
      region_layer: tri.region_layer ?? [],
      timestamp: nowIso(),
    };
  }
}

// ---------------------------------------------------------------------------
// LiveTrafficDataBridge + Real Open-Meteo Weather + TomTom Flow + Google Routes v2 + ApiManager
// ---------------------------------------------------------------------------

export interface CorridorTelemetryItem {
  road_id: string;
  road_name: string;
  city_zone: string;
  intersection_name: string;
  lat: number;
  lon: number;
  current_speed: number;
  free_flow_speed: number;
  spi: number;
  congestion_level: CongestionLevel;
  predicted_future_congestion: CongestionLevel;
  prediction_probabilities: Record<string, number>;
  vehicle_count: number;
  capacity_utilization: number;
  confidence: number;
  is_road_closed: boolean;
  is_live: boolean;
  is_cached: boolean;
  is_stale: boolean;
  is_historical_fallback: boolean;
  has_valid_live_observation: boolean;
  provenance: string;
  source: string;
  observation_time: string;
  retrieval_time: string;
  weather_condition: string;
  temperature_c: number;
  precipitation_mm: number;
  lanes: number;
  coordinates: [number, number][];
}

function mapWmoWeatherCode(code: number): string {
  if (code === 0) return "Clear";
  if (code >= 1 && code <= 3) return "Partly Cloudy";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 80 && code <= 82) return "Rain Showers";
  if (code >= 95 && code <= 99) return "Thunderstorm";
  return "Cloudy";
}

function decodeEncodedPolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let b: number;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([roundTo(lat / 1e5, 6), roundTo(lng / 1e5, 6)]);
  }
  return points;
}

export interface WeatherState {
  condition: string;
  temperature: number;
  temperature_c: number;
  precipitation_mm: number;
  wind_speed_kmh: number;
  weather_code: number;
  is_live: boolean;
  source: string;
  fetched_at: string;
}

export type ProviderConnectionState =
  | "CONNECTED"
  | "CONFIGURED"
  | "NOT_CONFIGURED"
  | "INVALID_CREDENTIALS"
  | "API_DISABLED_OR_RESTRICTED"
  | "CONFIGURED_UNREACHABLE";

interface ProviderRuntimeMeta {
  connection_state: ProviderConnectionState;
  currently_reachable: boolean;
  last_latency_ms: number | null;
  key_source: string;
}

export class ApiManager {
  public tomtomKey: string;
  public googleMapsKey: string;
  public weatherBaseUrl: string;
  private appDb: AppDatabase;
  private tomtomMeta: ProviderRuntimeMeta;
  private googleMapsMeta: ProviderRuntimeMeta;
  private weatherMeta: ProviderRuntimeMeta;

  constructor(appDb: AppDatabase) {
    this.appDb = appDb;
    const savedTomTom = this.readConfig("tomtom_api_key").trim();
    const savedGmaps = this.readConfig("google_maps_api_key").trim();
    const savedWeather = this.readConfig("weather_base_url").trim();

    const envTomTom = (process.env.TOMTOM_API_KEY || "").trim();
    const envGmaps = (process.env.GOOGLE_MAPS_BROWSER_KEY || process.env.GOOGLE_MAPS_API_KEY || "").trim();
    const envWeather = (process.env.OPEN_METEO_URL || "").trim();

    this.tomtomKey = envTomTom || savedTomTom;
    this.googleMapsKey = envGmaps || savedGmaps;
    this.weatherBaseUrl = envWeather || savedWeather || "https://api.open-meteo.com/v1/forecast";

    this.tomtomMeta = {
      connection_state: this.tomtomKey.length >= 12 ? "CONFIGURED" : "NOT_CONFIGURED",
      currently_reachable: false,
      last_latency_ms: null,
      key_source: envTomTom ? "Server (.env)" : savedTomTom ? "Admin Override (DB)" : "Unconfigured",
    };
    this.googleMapsMeta = {
      connection_state: this.googleMapsKey.length >= 12 ? "CONFIGURED" : "NOT_CONFIGURED",
      currently_reachable: false,
      last_latency_ms: null,
      key_source: envGmaps ? "Server (.env)" : savedGmaps ? "Admin Override (DB)" : "Unconfigured",
    };
    this.weatherMeta = {
      connection_state: "CONFIGURED",
      currently_reachable: false,
      last_latency_ms: null,
      key_source: envWeather ? "Server (.env)" : savedWeather ? "Admin Override (DB)" : "Default (Open-Meteo)",
    };
  }

  private readConfig(key: string): string {
    try {
      const row = this.appDb.db
        .prepare("SELECT value FROM provider_config WHERE key = ?")
        .get(key) as { value?: string } | undefined;
      return row?.value ?? "";
    } catch {
      return "";
    }
  }

  private writeConfig(key: string, value: string): void {
    this.appDb.db
      .prepare(
        `INSERT INTO provider_config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, nowIso());
  }

  public maskKey(key: string): string {
    if (!key || key.length < 6) return "";
    return `****${key.slice(-4)}`;
  }

  public getProviders() {
    return {
      tomtom: {
        name: "TomTom Traffic Flow & Incidents API",
        configured: this.tomtomKey.length >= 12,
        masked_key: this.maskKey(this.tomtomKey),
        status: this.tomtomKey.length >= 12 ? "configured" : "baseline_fallback",
        ...this.tomtomMeta,
      },
      google_maps: {
        name: "Google Maps & Routes API v2",
        configured: this.googleMapsKey.length >= 12,
        masked_key: this.maskKey(this.googleMapsKey),
        status: this.googleMapsKey.length >= 12 ? "configured" : "canvas_fallback",
        ...this.googleMapsMeta,
      },
      weather: {
        name: "Open-Meteo Bengaluru Weather API",
        configured: true,
        base_url: this.weatherBaseUrl,
        status: "live_ready",
        ...this.weatherMeta,
      },
    };
  }

  public getProvidersList() {
    const p = this.getProviders();
    return [p.google_maps, p.tomtom, p.weather];
  }

  public getStatus() {
    return {
      tomtom_configured: this.tomtomKey.length >= 12,
      google_maps_configured: this.googleMapsKey.length >= 12,
      weather_configured: true,
      mode: this.tomtomKey.length >= 12 ? "LIVE_EXTERNAL_API" : "EMPIRICAL_BASELINE_WITH_LIVE_WEATHER",
      providers: this.getProviders(),
    };
  }

  public getHealthReport() {
    return {
      overall_status: "healthy",
      checked_at: nowIso(),
      providers: this.getProviders(),
    };
  }

  public updateTomTomKey(key: string) {
    this.tomtomKey = String(key || "").trim();
    this.writeConfig("tomtom_api_key", this.tomtomKey);
    const configured = this.tomtomKey.length >= 12;
    this.tomtomMeta = {
      connection_state: configured ? "CONFIGURED" : "NOT_CONFIGURED",
      currently_reachable: false,
      last_latency_ms: null,
      key_source: configured ? "Admin Override (DB)" : "Unconfigured",
    };
    return { ok: true, msg: "TomTom API configuration persisted.", data: this.getProviders().tomtom };
  }

  public updateGoogleMapsKey(key: string) {
    this.googleMapsKey = String(key || "").trim();
    this.writeConfig("google_maps_api_key", this.googleMapsKey);
    const configured = this.googleMapsKey.length >= 12;
    this.googleMapsMeta = {
      connection_state: configured ? "CONFIGURED" : "NOT_CONFIGURED",
      currently_reachable: false,
      last_latency_ms: null,
      key_source: configured ? "Admin Override (DB)" : "Unconfigured",
    };
    return { ok: true, msg: "Google Maps configuration persisted.", data: this.getProviders().google_maps };
  }

  public updateWeatherConfig(baseUrl?: string) {
    if (baseUrl) {
      const trimmed = String(baseUrl).trim();
      if (!trimmed.startsWith("https://")) {
        return { ok: false, msg: "Weather base URL must use HTTPS.", data: this.getProviders().weather };
      }
      this.weatherBaseUrl = trimmed;
      this.writeConfig("weather_base_url", this.weatherBaseUrl);
      this.weatherMeta.key_source = "Admin Override (DB)";
    }
    return { ok: true, msg: "Weather configuration persisted.", data: this.getProviders().weather };
  }

  public async probeWeather(): Promise<{
    ok: boolean;
    latency_ms: number;
    http_status: number | null;
    message: string;
    weather?: WeatherState;
  }> {
    const t0 = performance.now();
    try {
      const url = `${this.weatherBaseUrl}?latitude=12.9716&longitude=77.5946&current=temperature_2m,precipitation,weather_code,wind_speed_10m&timezone=Asia/Kolkata`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const latencyMs = Math.round(performance.now() - t0);
      if (!resp.ok) {
        this.weatherMeta.currently_reachable = false;
        this.weatherMeta.last_latency_ms = latencyMs;
        this.weatherMeta.connection_state = "CONFIGURED_UNREACHABLE";
        return {
          ok: false,
          latency_ms: latencyMs,
          http_status: resp.status,
          message: `Open-Meteo returned HTTP ${resp.status}.`,
        };
      }
      const data = (await resp.json()) as {
        current?: {
          temperature_2m?: number;
          precipitation?: number;
          weather_code?: number;
          wind_speed_10m?: number;
        };
      };
      const cur = data.current;
      const code = Number(cur?.weather_code ?? 0);
      const temp = roundTo(Number(cur?.temperature_2m ?? 26.5), 1);
      const precip = roundTo(Number(cur?.precipitation ?? 0), 2);
      const wind = roundTo(Number(cur?.wind_speed_10m ?? 0), 1);
      const weather: WeatherState = {
        condition: mapWmoWeatherCode(code),
        temperature: temp,
        temperature_c: temp,
        precipitation_mm: precip,
        wind_speed_kmh: wind,
        weather_code: code,
        is_live: true,
        source: "Open-Meteo Live API",
        fetched_at: nowIso(),
      };
      this.weatherMeta.currently_reachable = true;
      this.weatherMeta.last_latency_ms = latencyMs;
      this.weatherMeta.connection_state = "CONNECTED";
      return {
        ok: true,
        latency_ms: latencyMs,
        http_status: resp.status,
        message: `Open-Meteo Bengaluru live: ${weather.condition}, ${weather.temperature_c}°C (${latencyMs}ms).`,
        weather,
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - t0);
      this.weatherMeta.currently_reachable = false;
      this.weatherMeta.last_latency_ms = latencyMs;
      this.weatherMeta.connection_state = "CONFIGURED_UNREACHABLE";
      return {
        ok: false,
        latency_ms: latencyMs,
        http_status: null,
        message: `Open-Meteo unreachable: ${err instanceof Error ? err.message : "network error"}`,
      };
    }
  }

  public async probeTomTom(): Promise<{
    ok: boolean;
    configured: boolean;
    latency_ms: number;
    http_status: number | null;
    message: string;
    sample_speed_kmh?: number;
  }> {
    if (this.tomtomKey.length < 12) {
      this.tomtomMeta.currently_reachable = false;
      this.tomtomMeta.last_latency_ms = null;
      this.tomtomMeta.connection_state = "NOT_CONFIGURED";
      return {
        ok: false,
        configured: false,
        latency_ms: 0,
        http_status: null,
        message: "TomTom API key not configured; running calibrated Bengaluru baseline.",
      };
    }
    const t0 = performance.now();
    try {
      const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=12.9784,77.6408&key=${encodeURIComponent(this.tomtomKey)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const latencyMs = Math.round(performance.now() - t0);
      if (!resp.ok) {
        this.tomtomMeta.currently_reachable = false;
        this.tomtomMeta.last_latency_ms = latencyMs;
        this.tomtomMeta.connection_state =
          resp.status === 401 || resp.status === 403 ? "INVALID_CREDENTIALS" : "CONFIGURED_UNREACHABLE";
        return {
          ok: false,
          configured: true,
          latency_ms: latencyMs,
          http_status: resp.status,
          message: `TomTom Flow API rejected request with HTTP ${resp.status}.`,
        };
      }
      const data = (await resp.json()) as { flowSegmentData?: { currentSpeed?: number } };
      const spd = data.flowSegmentData?.currentSpeed;
      this.tomtomMeta.currently_reachable = true;
      this.tomtomMeta.last_latency_ms = latencyMs;
      this.tomtomMeta.connection_state = "CONNECTED";
      return {
        ok: true,
        configured: true,
        latency_ms: latencyMs,
        http_status: resp.status,
        sample_speed_kmh: typeof spd === "number" ? spd : undefined,
        message: `TomTom Flow API live (Indiranagar speed: ${spd ?? "--"} km/h, ${latencyMs}ms).`,
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - t0);
      this.tomtomMeta.currently_reachable = false;
      this.tomtomMeta.last_latency_ms = latencyMs;
      this.tomtomMeta.connection_state = "CONFIGURED_UNREACHABLE";
      return {
        ok: false,
        configured: true,
        latency_ms: latencyMs,
        http_status: null,
        message: `TomTom probe error: ${err instanceof Error ? err.message : "network error"}`,
      };
    }
  }

  public async probeGoogleMaps(): Promise<{
    ok: boolean;
    configured: boolean;
    latency_ms: number;
    http_status: number | null;
    message: string;
  }> {
    if (this.googleMapsKey.length < 12) {
      this.googleMapsMeta.currently_reachable = false;
      this.googleMapsMeta.last_latency_ms = null;
      this.googleMapsMeta.connection_state = "NOT_CONFIGURED";
      return {
        ok: false,
        configured: false,
        latency_ms: 0,
        http_status: null,
        message: "Google Maps API key not configured; interactive vector canvas active.",
      };
    }
    const t0 = performance.now();
    try {
      const resp = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.googleMapsKey,
          "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
        },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: 12.9784, longitude: 77.6408 } } },
          destination: { location: { latLng: { latitude: 12.9756, longitude: 77.6066 } } },
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_AWARE",
        }),
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Math.round(performance.now() - t0);
      if (!resp.ok) {
        this.googleMapsMeta.currently_reachable = false;
        this.googleMapsMeta.last_latency_ms = latencyMs;
        this.googleMapsMeta.connection_state =
          resp.status === 401
            ? "INVALID_CREDENTIALS"
            : resp.status === 403
              ? "API_DISABLED_OR_RESTRICTED"
              : "CONFIGURED_UNREACHABLE";
        return {
          ok: false,
          configured: true,
          latency_ms: latencyMs,
          http_status: resp.status,
          message: `Google Routes API returned HTTP ${resp.status}.`,
        };
      }
      this.googleMapsMeta.currently_reachable = true;
      this.googleMapsMeta.last_latency_ms = latencyMs;
      this.googleMapsMeta.connection_state = "CONNECTED";
      return {
        ok: true,
        configured: true,
        latency_ms: latencyMs,
        http_status: resp.status,
        message: `Google Routes API v2 reachable (${latencyMs}ms).`,
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - t0);
      this.googleMapsMeta.currently_reachable = false;
      this.googleMapsMeta.last_latency_ms = latencyMs;
      this.googleMapsMeta.connection_state = "CONFIGURED_UNREACHABLE";
      return {
        ok: false,
        configured: true,
        latency_ms: latencyMs,
        http_status: null,
        message: `Google Maps probe error: ${err instanceof Error ? err.message : "network error"}`,
      };
    }
  }
}

export class LiveTrafficDataBridge {
  public predictor: TrafficPredictor;
  public apiManager: ApiManager;
  private navigator: RouteNavigator;
  private appDb: AppDatabase;
  private telemetryCache: Map<string, CorridorTelemetryItem> = new Map();
  private cacheTimeMs = 0;
  private cacheTtlMs = 45_000;
  private weatherCache: WeatherState = {
    condition: "Clear",
    temperature: 26.5,
    temperature_c: 26.5,
    precipitation_mm: 0.0,
    wind_speed_kmh: 0.0,
    weather_code: 0,
    is_live: false,
    source: "Pending Open-Meteo Sync",
    fetched_at: nowIso(),
  };
  private weatherFetchedMs = 0;
  private weatherTtlMs = 300_000;
  private lastAttemptedIso: string | null = null;
  private lastSuccessIso: string | null = null;
  private lastLiveTomTomCount = 0;

  constructor(
    predictor: TrafficPredictor,
    apiManager: ApiManager,
    navigator: RouteNavigator,
    appDb: AppDatabase
  ) {
    this.predictor = predictor;
    this.apiManager = apiManager;
    this.navigator = navigator;
    this.appDb = appDb;
  }

  public async refreshLiveWeather(force = false): Promise<WeatherState> {
    const nowMs = Date.now();
    if (!force && this.weatherCache.is_live && nowMs - this.weatherFetchedMs < this.weatherTtlMs) {
      return this.weatherCache;
    }
    const probe = await this.apiManager.probeWeather();
    if (probe.ok && probe.weather) {
      this.weatherCache = probe.weather;
      this.weatherFetchedMs = nowMs;
      this.lastSuccessIso = probe.weather.fetched_at;
    } else if (!this.weatherCache.is_live) {
      this.weatherCache = {
        ...this.weatherCache,
        source: "Offline Seasonal Fallback",
        fetched_at: nowIso(),
      };
    }
    return this.weatherCache;
  }

  private loadIngestedMeasurements(): Map<string, Record<string, unknown>> {
    const out = new Map<string, Record<string, unknown>>();
    const rows = this.appDb.db
      .prepare("SELECT corridor_id, payload_json FROM ingested_measurements")
      .all() as Array<{ corridor_id: string; payload_json: string }>;
    for (const r of rows) {
      try {
        out.set(r.corridor_id, JSON.parse(r.payload_json));
      } catch {
        // skip corrupt row
      }
    }
    return out;
  }

  private persistTelemetrySnapshots(items: CorridorTelemetryItem[]): void {
    try {
      const insert = this.appDb.db.prepare(
        `INSERT INTO telemetry_snapshots (
           corridor_id, current_speed, free_flow_speed, vehicle_count,
           congestion_level, predicted_future_congestion, source, is_live,
           weather_condition, temperature_c, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const c of items) {
        insert.run(
          c.road_id,
          c.current_speed,
          c.free_flow_speed,
          c.vehicle_count,
          c.congestion_level,
          c.predicted_future_congestion,
          c.source,
          c.is_live ? 1 : 0,
          c.weather_condition,
          c.temperature_c,
          c.observation_time
        );
      }
      // Keep recent 2,400 snapshots (~100 full-network cycles)
      this.appDb.db
        .prepare("DELETE FROM telemetry_snapshots WHERE id NOT IN (SELECT id FROM telemetry_snapshots ORDER BY id DESC LIMIT 2400)")
        .run();
    } catch {
      // non-fatal snapshot persistence error
    }
  }

  public getLiveStatus() {
    const isTomTom = this.apiManager.tomtomKey.length >= 12;
    const isLiveApi = this.lastLiveTomTomCount > 0;
    const istDate = new Date(Date.now() + 5.5 * 3600 * 1000);
    const hh = String(istDate.getUTCHours()).padStart(2, "0");
    const mm = String(istDate.getUTCMinutes()).padStart(2, "0");
    const ss = String(istDate.getUTCSeconds()).padStart(2, "0");
    const lastSyncIst = `${hh}:${mm}:${ss} IST`;

    const statusCode = isLiveApi
      ? "LIVE_TOMTOM_FLOW"
      : this.weatherCache.is_live
        ? "BASELINE_WITH_LIVE_WEATHER"
        : "BASELINE_SNAPSHOT";
    const statusLabel = isLiveApi
      ? `Live TomTom Telemetry (${this.lastLiveTomTomCount}/24 Corridors)`
      : this.weatherCache.is_live
        ? "Calibrated Baseline + Open-Meteo Live Weather"
        : "Calibrated Bengaluru Baseline (XGBoost 80-Tree)";

    return {
      success: true,
      status: "success",
      live_api_configured: isTomTom,
      tomtom_configured: isTomTom,
      is_live_api: isLiveApi,
      status_code: statusCode,
      status_label: statusLabel,
      provider: isLiveApi
        ? "TomTom Traffic Flow v4 + Open-Meteo Live"
        : this.weatherCache.is_live
          ? "Open-Meteo Live Weather + Bengaluru Topology"
          : "Empirical Bengaluru Topology",
      provenance: isLiveApi ? "TomTom Live API" : "Empirical Bengaluru Baseline",
      mode: isLiveApi ? "LIVE_EXTERNAL_API" : "EMPIRICAL_BASELINE",
      weather: this.weatherCache,
      monitored_corridors: Object.keys(BENGALURU_CORRIDOR_GPS).length,
      corridors_monitored: Object.keys(BENGALURU_CORRIDOR_GPS).length,
      last_sync: lastSyncIst,
      last_attempted_request: this.lastAttemptedIso,
      last_successful_retrieval: this.lastSuccessIso,
      cache_ttl_sec: Math.round(this.cacheTtlMs / 1000),
      cache_age_sec: this.cacheTimeMs ? Math.round((Date.now() - this.cacheTimeMs) / 1000) : 0,
      timestamp: nowIso(),
    };
  }

  private async fetchTomTomCorridorFlow(lat: number, lon: number): Promise<{
    currentSpeed: number;
    freeFlowSpeed: number;
    confidence: number;
    roadClosure: boolean;
  } | null> {
    if (this.apiManager.tomtomKey.length < 12) return null;
    try {
      const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${lat},${lon}&key=${encodeURIComponent(this.apiManager.tomtomKey)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!resp.ok) return null;
      const json = (await resp.json()) as {
        flowSegmentData?: {
          currentSpeed?: number;
          freeFlowSpeed?: number;
          confidence?: number;
          roadClosure?: boolean;
        };
      };
      const seg = json.flowSegmentData;
      if (!seg || typeof seg.currentSpeed !== "number") return null;
      return {
        currentSpeed: seg.currentSpeed,
        freeFlowSpeed: typeof seg.freeFlowSpeed === "number" ? seg.freeFlowSpeed : 48,
        confidence: typeof seg.confidence === "number" ? seg.confidence : 0.9,
        roadClosure: Boolean(seg.roadClosure),
      };
    } catch {
      return null;
    }
  }

  public async refreshCorridorTelemetry(opts?: { roadIds?: string[]; forceRefresh?: boolean }): Promise<CorridorTelemetryItem[]> {
    const force = Boolean(opts?.forceRefresh);
    const roadIds = opts?.roadIds;
    const nowMs = Date.now();

    if (!force && this.telemetryCache.size > 0 && nowMs - this.cacheTimeMs < this.cacheTtlMs) {
      const items = Array.from(this.telemetryCache.values()).map((c) => ({
        ...c,
        is_cached: true,
        provenance: c.is_live ? "Cached API response" : c.provenance,
      }));
      return roadIds ? items.filter((c) => roadIds.includes(c.road_id)) : items;
    }

    this.lastAttemptedIso = nowIso();
    await this.refreshLiveWeather(force);

    // Fetch live TomTom Flow speeds in bounded parallel batches if API key is configured
    const liveFlowMap = new Map<
      string,
      { currentSpeed: number; freeFlowSpeed: number; confidence: number; roadClosure: boolean }
    >();
    if (this.apiManager.tomtomKey.length >= 12) {
      const entries = Object.entries(BENGALURU_CORRIDOR_GPS);
      const batchSize = 6;
      for (let i = 0; i < entries.length; i += batchSize) {
        const chunk = entries.slice(i, i + batchSize);
        const settled = await Promise.all(
          chunk.map(async ([rId, gps]) => {
            const flow = await this.fetchTomTomCorridorFlow(gps.lat, gps.lon);
            return [rId, flow] as const;
          })
        );
        for (const [rId, flow] of settled) {
          if (flow) liveFlowMap.set(rId, flow);
        }
      }
    }

    this.lastLiveTomTomCount = liveFlowMap.size;
    if (liveFlowMap.size > 0) {
      this.lastSuccessIso = nowIso();
    }

    const items = this.computeTelemetryItems(liveFlowMap, nowMs);
    this.persistTelemetrySnapshots(items);
    return roadIds ? items.filter((c) => roadIds.includes(c.road_id)) : items;
  }

  public getCorridorTelemetry(opts?: { roadIds?: string[]; forceRefresh?: boolean }): CorridorTelemetryItem[] {
    const force = Boolean(opts?.forceRefresh);
    const roadIds = opts?.roadIds;
    const nowMs = Date.now();

    if (!force && this.telemetryCache.size > 0 && nowMs - this.cacheTimeMs < this.cacheTtlMs) {
      const items = Array.from(this.telemetryCache.values()).map((c) => ({
        ...c,
        is_cached: true,
        provenance: c.is_live ? "Cached API response" : c.provenance,
      }));
      return roadIds ? items.filter((c) => roadIds.includes(c.road_id)) : items;
    }

    const items = this.computeTelemetryItems(new Map(), nowMs);
    return roadIds ? items.filter((c) => roadIds.includes(c.road_id)) : items;
  }

  private computeTelemetryItems(
    liveFlowMap: Map<string, { currentSpeed: number; freeFlowSpeed: number; confidence: number; roadClosure: boolean }>,
    nowMs: number
  ): CorridorTelemetryItem[] {
    const istDate = new Date(nowMs + 5.5 * 3600 * 1000);
    const hour = istDate.getUTCHours();
    const dow = (istDate.getUTCDay() + 6) % 7;
    const isWeekend = dow >= 5 ? 1 : 0;
    const isPeak = [8, 9, 10, 17, 18, 19, 20].includes(hour) && isWeekend === 0;
    const weatherSlowdown = this.weatherCache.precipitation_mm >= 1.0 ? 0.88 : 1.0;
    const diurnalFactor = (isPeak ? 0.72 : 0.94) * weatherSlowdown;
    const observedIso = nowIso();
    const ingestedMap = this.loadIngestedMeasurements();

    const results: CorridorTelemetryItem[] = [];
    for (const [rId, gps] of Object.entries(BENGALURU_CORRIDOR_GPS)) {
      const reg = ROAD_REGISTRY[rId];
      const topo = this.predictor.topology[rId];
      const laneInfo = getCorridorLaneInfo(rId);
      const liveFlow = liveFlowMap.get(rId);
      const ingested = ingestedMap.get(rId);

      const ffSpeed = liveFlow?.freeFlowSpeed ?? gps.free_flow;
      const baseSpd = topo?.avg_speed ?? 38.0;
      const baseVol = topo?.avg_volume ?? 24000;

      const ingestedSpeed =
        ingested && typeof ingested.average_speed === "number"
          ? ingested.average_speed
          : ingested && typeof ingested.current_speed === "number"
            ? ingested.current_speed
            : ingested && typeof ingested.speed_kmh === "number"
              ? ingested.speed_kmh
              : null;

      const curSpeed =
        ingestedSpeed !== null
          ? roundTo(ingestedSpeed, 1)
          : liveFlow
            ? roundTo(liveFlow.currentSpeed, 1)
            : roundTo(baseSpd * diurnalFactor, 1);

      const sevInfo = classifyTrafficSeverity(curSpeed, ffSpeed);
      const spi = sevInfo.spi;
      const congestionLevel: CongestionLevel = sevInfo.los;

      const capUtil = calculateCapacityUtilization(curSpeed, ffSpeed);
      const vehicleCount =
        ingested && typeof ingested.vehicle_count === "number"
          ? Math.round(ingested.vehicle_count)
          : calculateScaledVolume(baseVol, curSpeed, ffSpeed);

      const [predFuture, predProbs] = this.predictor.predictSegment({
        city_zone: reg?.city_zone ?? gps.zone,
        road_id: rId,
        intersection_id: reg?.intersection_id ?? `INT_${rId}`,
        vehicle_count: vehicleCount,
        average_speed: curSpeed,
        capacity_utilization: capUtil,
        congestion_level: congestionLevel,
        hour,
        day_of_week: dow,
        is_weekend: isWeekend,
      });

      const isLive = Boolean(liveFlow);
      const provenance = ingested
        ? "Ingested Sensor Measurement"
        : isLive
          ? "TomTom Live API"
          : "Empirical Bengaluru Baseline";
      const source = ingested
        ? "Live Traffic Measurement"
        : isLive
          ? "TomTom Traffic Flow v4"
          : "Empirical Bengaluru Baseline";

      const item: CorridorTelemetryItem = {
        road_id: rId,
        road_name: reg?.bangalore_name ?? gps.name,
        city_zone: reg?.city_zone ?? gps.zone,
        intersection_name: reg?.intersection_name ?? `INT_${rId}`,
        lat: gps.lat,
        lon: gps.lon,
        current_speed: curSpeed,
        free_flow_speed: ffSpeed,
        spi,
        congestion_level: congestionLevel,
        predicted_future_congestion: predFuture,
        prediction_probabilities: predProbs,
        vehicle_count: vehicleCount,
        capacity_utilization: capUtil,
        confidence: liveFlow?.confidence ?? 0.9,
        is_road_closed: Boolean(liveFlow?.roadClosure),
        is_live: isLive,
        is_cached: false,
        is_stale: false,
        is_historical_fallback: !isLive && !ingested,
        has_valid_live_observation: isLive || Boolean(ingested),
        provenance,
        source,
        observation_time: observedIso,
        retrieval_time: observedIso,
        weather_condition: this.weatherCache.condition,
        temperature_c: this.weatherCache.temperature_c,
        precipitation_mm: this.weatherCache.precipitation_mm,
        lanes: laneInfo.lanes,
        coordinates: laneInfo.coordinates,
      };
      this.telemetryCache.set(rId, item);
      results.push(item);
    }

    this.cacheTimeMs = nowMs;
    return results;
  }

  public getCorridorState(corridorId: string) {
    const norm = normalizeCorridorId(corridorId);
    const list = this.getCorridorTelemetry({ roadIds: [norm] });
    return list[0] ?? null;
  }

  public injectTrafficMeasurement(payload: Record<string, unknown>) {
    const corridorId = normalizeCorridorId(String(payload.corridor_id || payload.road_id || ""));
    if (!corridorId || !ROAD_REGISTRY[corridorId]) {
      throw new Error(`Invalid or unregistered corridor_id: '${corridorId}'`);
    }
    const ingestedAt = nowIso();
    const record = {
      ...payload,
      corridor_id: corridorId,
      ingested_at: ingestedAt,
    };
    this.appDb.db
      .prepare(
        `INSERT INTO ingested_measurements (corridor_id, payload_json, ingested_at) VALUES (?, ?, ?)
         ON CONFLICT(corridor_id) DO UPDATE SET payload_json = excluded.payload_json, ingested_at = excluded.ingested_at`
      )
      .run(corridorId, JSON.stringify(record), ingestedAt);
    this.cacheTimeMs = 0; // bust cache
    return this.getCorridorState(corridorId);
  }

  public evaluateLiveRoute(
    originRoad: string,
    destinationRoad: string,
    date?: string,
    timeStr?: string,
    publishedOnly = true
  ) {
    const now = new Date();
    const d = date && isValidIsoDate(date) ? date : now.toISOString().slice(0, 10);
    const t = timeStr || `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    return this.navigator.evaluateRoute(originRoad, destinationRoad, d, t, publishedOnly);
  }

  public async evaluateLiveRouteAsync(
    originRoad: string,
    destinationRoad: string,
    date?: string,
    timeStr?: string,
    publishedOnly = true
  ) {
    const baseEval = this.evaluateLiveRoute(originRoad, destinationRoad, date, timeStr, publishedOnly);
    if (this.apiManager.googleMapsKey.length < 12) {
      return baseEval;
    }

    const origGps = BENGALURU_CORRIDOR_GPS[baseEval.origin_road];
    const destGps = BENGALURU_CORRIDOR_GPS[baseEval.destination_road];
    if (!origGps || !destGps) return baseEval;

    try {
      const resp = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiManager.googleMapsKey,
          "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
        },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: origGps.lat, longitude: origGps.lon } } },
          destination: { location: { latLng: { latitude: destGps.lat, longitude: destGps.lon } } },
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_AWARE",
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (resp.ok) {
        const json = (await resp.json()) as {
          routes?: Array<{
            duration?: string;
            distanceMeters?: number;
            polyline?: { encodedPolyline?: string };
          }>;
        };
        const first = json.routes?.[0];
        if (first?.polyline?.encodedPolyline) {
          const decoded = decodeEncodedPolyline(first.polyline.encodedPolyline);
          const durSec = parseInt(String(first.duration || "0").replace("s", ""), 10);
          if (decoded.length >= 2) {
            baseEval.primary_polylines = decoded;
          }
          if (durSec > 0) {
            baseEval.primary_travel_time_minutes = roundTo(durSec / 60, 1);
            baseEval.is_historical_model_estimate = false;
          }
        }
      }
    } catch {
      // keep graph-evaluated polylines on network timeout
    }

    return baseEval;
  }
}

const BANGALORE_CORRIDOR_DETOURS: Record<string, string> = {
  RD_BLR_01: "CMH Road or Old Airport Road",
  RD_BLR_02: "Cubbon Road or Kasturba Road",
  RD_BLR_03: "Thanisandra Main Road or NH-44 Service Lanes",
  RD_BLR_04: "Old Madras Road or Swami Vivekananda Road",
  RD_BLR_05: "Outer Ring Road (ORR) via Nagavara",
  RD_BLR_06: "Hosur Elevated Tollway or Bannerghatta Road",
  RD_BLR_07: "Hoodi Junction or Varthur Road",
  RD_BLR_08: "South End Circle or Kanakapura Road",
  RD_BLR_09: "HAL Old Airport Road or Kundalahalli Gate",
  RD_BLR_10: "Haralur Road or Harlur-Kudlu Link",
  RD_BLR_11: "HSR Layout 14th Main or Madiwala Underpass",
  RD_BLR_12: "Koramangala 80 Feet Road or Inner Ring Road",
  RD_BLR_13: "RV Road or 9th Main Road",
  RD_BLR_14: "MG Road or Residency Road",
  RD_BLR_15: "Whitefield Main Road or Borewell Road",
  RD_BLR_16: "Kanakapura Road or 24th Main Road",
  RD_BLR_17: "100 Feet Road or Intermediate Ring Road",
  RD_BLR_18: "MG Road or Richmond Road",
  RD_BLR_19: "Hennur Bagalur Road or Bellary Road",
  RD_BLR_20: "Electronic City Elevated Tollway or Bettadasanapura Link",
  RD_BLR_21: "HAL Airport Road or Panathur Main Road",
  RD_BLR_22: "Banashankari Ring Road or 9th Cross Road",
  RD_BLR_23: "Koramangala 100 Feet Road or Sarjapur Link",
  RD_BLR_24: "Sampige Road or CV Raman Road",
};

export function generateActionDirective(
  roadId: string,
  zone: string,
  predCongestion: string,
  hasEvent: boolean,
  eventName = "",
  volumeVph?: number,
  lanes?: number
) {
  const congClean = String(predCongestion || "Moderate").trim();
  const congLower = congClean.toLowerCase();
  const roadName = getRoadName(roadId);
  const detour = BANGALORE_CORRIDOR_DETOURS[roadId] ?? "Adjacent Parallel Arterials";
  const intersection = ROAD_REGISTRY[roadId]?.intersection_name ?? `${roadName} Intersection`;
  const laneMeta = getCorridorLaneInfo(roadId);
  const effectiveLanes = Math.max(2, Math.round((lanes ?? laneMeta.lanes) / 2));

  let code = "DIR-LOW-04";
  let priorityLevel = "ROUTINE_MONITORING";
  let datasetAction = "Continue regular traffic monitoring";
  let fieldOps = "Routine automated surveillance active.";
  let signalOps = "Energy-conserving actuated cycle active.";
  let advisoryOps = "Free-flow corridor passage.";
  let action = `ROUTINE MONITORING: ${fieldOps} ${signalOps} ${advisoryOps}`;
  let vms = `SMOOTH TRAFFIC ON ${roadName} [${roadId}]. ALL CLEAR.`;
  let extSec = 0.0;
  let cycleMode = "ENERGY_SAVING";
  let estVol = volumeVph !== undefined ? volumeVph : 177;

  if (congLower === "severe") {
    code = "DIR-SEV-01";
    priorityLevel = "URGENT_PRIORITY_1";
    datasetAction = "Priority review: investigate incidents, coordinate signals, evaluate alternative routes and improve public transport options";
    fieldOps = `Deploy BTP Traffic Warden at ${intersection}. Enforce heavy commercial vehicle (HTV) restriction.`;
    signalOps = "Activate dynamic Webster phase extension (+15s green). Coordinated green-wave progression.";
    advisoryOps = `Broadcast diversion to ${detour}. Expect 25-35 min corridor delay.`;
    action = `PRIORITY DISPATCH: ${fieldOps} ${signalOps} ${advisoryOps}`;
    vms = `ALERT: SEVERE DELAYS ON ${roadName} [${roadId}]. DIVERT VIA ${detour.toUpperCase()}.`;
    extSec = 15.0;
    cycleMode = "DYNAMIC_COORDINATED";
    estVol = volumeVph !== undefined ? volumeVph : 1885;
  } else if (congLower === "high") {
    code = "DIR-HIGH-02";
    priorityLevel = "ELEVATED_PRIORITY_2";
    datasetAction = "Review signal timing, peak-hour demand management and alternative routes";
    fieldOps = `Station roving motorcycle patrol along ${roadName}. Clear kerbside bottlenecks.`;
    signalOps = "Adjust split-adaptive signal timing (+8s green extension to primary mainline).";
    advisoryOps = `Recommend ${detour} for arterial traffic diversion. Expect 15-20 min delay.`;
    action = `ELEVATED CONTROL: ${fieldOps} ${signalOps} ${advisoryOps}`;
    vms = `CAUTION: HEAVY TRAFFIC ON ${roadName} [${roadId}]. EXPECT 15-20 MIN DELAYS. ALT: ${detour.toUpperCase()}.`;
    extSec = 8.0;
    cycleMode = "SPLIT_ADAPTIVE";
    estVol = volumeVph !== undefined ? volumeVph : 1359;
  } else if (congLower === "moderate" || congLower === "medium") {
    code = "DIR-MOD-03";
    priorityLevel = "STANDARD_PRIORITY_3";
    datasetAction = "Monitor traffic and review signal coordination";
    fieldOps = "Automated AI camera surveillance active; automated queue monitoring.";
    signalOps = "Maintain standard coordinated signal offset (zero phase bias).";
    advisoryOps = "Standard corridor flow; no diversions required.";
    action = `COORDINATED MONITORING: ${fieldOps} ${signalOps} ${advisoryOps}`;
    vms = `NORMAL FLOW WITH MODERATE DENSITY ON ${roadName} [${roadId}].`;
    extSec = 0.0;
    cycleMode = "STANDARD_OFFSET";
    estVol = volumeVph !== undefined ? volumeVph : 703;
  }

  // Convert daily corridor volume to directional hourly PCU if raw daily total passed
  const directionalHourlyPcu = estVol > 5000 ? Math.round(estVol * 0.048) : Math.round(estVol);

  if (hasEvent && eventName) {
    action += ` [ACTIVE EVENT NOTICE: ${eventName} - Coordinate crowd management with city police.]`;
    vms += ` [EVENT: ${eventName.toUpperCase()}]`;
  }

  const webster = optimizeIntersectionSignals(
    directionalHourlyPcu,
    Math.round(directionalHourlyPcu * 0.65),
    effectiveLanes,
    Math.max(1, effectiveLanes - 1),
    extSec
  );

  return {
    directive_code: code,
    priority_level: priorityLevel,
    priority: {
      level: priorityLevel,
      rank: priorityLevel.includes("1") ? 1 : priorityLevel.includes("2") ? 2 : priorityLevel.includes("3") ? 3 : 4,
      urgency: priorityLevel.includes("1") ? "Immediate" : priorityLevel.includes("2") ? "Elevated" : priorityLevel.includes("3") ? "Standard" : "Routine",
    },
    road_id: roadId,
    road_name: roadName,
    city_zone: zone,
    congestion_state: congClean,
    predicted_congestion: congClean,
    dataset_standard_action: datasetAction,
    operational_action: action,
    directive: action,
    recommended_action: action,
    vms_broadcast_message: vms,
    has_active_event: hasEvent,
    event_name: hasEvent ? eventName || null : null,
    is_simulated: true,
    is_recommendation_only: true,
    provenance: "Simulation",
    signal_actuation_parameters: {
      phase_extension_sec: Math.trunc(extSec),
      cycle_offset: cycleMode,
      optimal_cycle_sec: webster.optimal_cycle_sec,
      ns_green_sec: webster.ns_green_sec,
      ew_green_sec: webster.ew_green_sec,
      estimated_delay_saved_sec: webster.delay_saved_sec,
      saturation_index: webster.critical_flow_ratio_Y,
      directional_hourly_pcu: directionalHourlyPcu,
      approach_lanes: effectiveLanes,
    },
    tactical_breakdown: {
      field_operations: fieldOps,
      signal_control: signalOps,
      traveler_advisory: advisoryOps,
      recommended_detour: detour,
    },
    generated_at: nowIso(),
  };
}
