import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface AppDatabaseOptions {
  baseDir?: string;
  dbPath?: string;
}

export class AppDatabase {
  public readonly db: DatabaseSync;
  public readonly dbPath: string;

  constructor(opts?: AppDatabaseOptions) {
    const baseDir = opts?.baseDir ?? process.cwd();
    if (opts?.dbPath) {
      this.dbPath = opts.dbPath;
    } else {
      const storageDir =
        process.env.PERSISTENT_DATA_DIR?.trim() ||
        path.join(baseDir, "data", "storage");
      fs.mkdirSync(storageDir, { recursive: true });
      this.dbPath = path.join(storageDir, "smart_traffic.db");
    }

    if (this.dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        hash_algo TEXT NOT NULL DEFAULT 'scrypt',
        role TEXT NOT NULL,
        created_at REAL NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at REAL NOT NULL,
        expires_at REAL NOT NULL,
        FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        event_type TEXT NOT NULL,
        city_zone TEXT NOT NULL,
        location_name TEXT NOT NULL,
        affected_roads_json TEXT NOT NULL,
        affected_road_names_json TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        date TEXT NOT NULL,
        end_date TEXT,
        dataset_date TEXT,
        active_dates_json TEXT,
        severity_boost INTEGER NOT NULL,
        volume_surge_vph INTEGER NOT NULL,
        capacity_constriction_pct REAL NOT NULL,
        speed_impact_pct REAL NOT NULL,
        is_historical INTEGER NOT NULL DEFAULT 0,
        is_published INTEGER NOT NULL DEFAULT 1,
        published_at TEXT,
        updated_at TEXT,
        description TEXT NOT NULL,
        source_name TEXT,
        source_url TEXT,
        verification_status TEXT,
        extra_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_zone ON events(city_zone);
      CREATE INDEX IF NOT EXISTS idx_events_hist_pub ON events(is_historical, is_published);

      CREATE TABLE IF NOT EXISTS cameras (
        camera_id TEXT PRIMARY KEY,
        corridor_id TEXT NOT NULL,
        name TEXT NOT NULL,
        roi_polygon_json TEXT NOT NULL,
        lane_polygons_json TEXT NOT NULL,
        homography_matrix_json TEXT NOT NULL,
        pixels_per_meter REAL NOT NULL,
        is_homography_calibrated INTEGER NOT NULL DEFAULT 0,
        updated_at REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS videos (
        video_id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL,
        owner TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        sample_url TEXT
      );

      CREATE TABLE IF NOT EXISTS vision_jobs (
        job_id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        owner TEXT NOT NULL,
        status TEXT NOT NULL,
        progress_pct REAL NOT NULL,
        total_frames INTEGER NOT NULL,
        processed_frames INTEGER NOT NULL,
        duration_seconds REAL NOT NULL,
        fps REAL NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        model_name TEXT NOT NULL,
        model_status TEXT NOT NULL,
        provenance TEXT NOT NULL,
        camera_config_json TEXT,
        confidence_summary_json TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        output_video_path TEXT,
        error_message TEXT,
        results_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_vision_jobs_created ON vision_jobs(created_at);

      CREATE TABLE IF NOT EXISTS telemetry_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        corridor_id TEXT NOT NULL,
        current_speed REAL NOT NULL,
        free_flow_speed REAL NOT NULL,
        vehicle_count INTEGER NOT NULL,
        congestion_level TEXT NOT NULL,
        predicted_future_congestion TEXT NOT NULL,
        source TEXT NOT NULL,
        is_live INTEGER NOT NULL,
        weather_condition TEXT,
        temperature_c REAL,
        observed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_corridor_time ON telemetry_snapshots(corridor_id, observed_at);

      CREATE TABLE IF NOT EXISTS ingested_measurements (
        corridor_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        ingested_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS actuation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        corridor_id TEXT NOT NULL,
        road_name TEXT NOT NULL,
        green_extension_sec REAL NOT NULL,
        applied_mode TEXT NOT NULL,
        actor TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  public isHealthy(): boolean {
    try {
      const row = this.db.prepare("SELECT 1 AS ok").get() as { ok?: number } | undefined;
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  public getTableCounts(): Record<string, number> {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c?: number } | undefined;
      return Number(row?.c ?? 0);
    };
    return {
      users: count("users"),
      sessions: count("sessions"),
      events: count("events"),
      cameras: count("cameras"),
      videos: count("videos"),
      vision_jobs: count("vision_jobs"),
      telemetry_snapshots: count("telemetry_snapshots"),
      actuation_logs: count("actuation_logs"),
    };
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // ignore if already closed
    }
  }
}
