# Smart Traffic Operations — Bengaluru

Real-time metropolitan traffic monitoring, congestion forecasting, route guidance, and traffic video analytics for Bengaluru's 24 primary road corridors.

## Stack

- **Runtime:** Node.js 22 (TypeScript, Express 5, built-in `node:sqlite`)
- **Forecasting:** XGBoost tree-ensemble inference (`models/xgboost/`)
- **Video Analytics:** FFmpeg frame extraction + Ultralytics YOLOv11s ONNX (`onnxruntime-node`, `sharp`) + multi-object centroid/IoU tracking
- **Frontend:** Vanilla HTML/CSS/JS served from `public/` (Google Maps / heat canvas layers)

## Prerequisites

- **Node.js** `>= 22.18`
- **FFmpeg** (`ffmpeg` and `ffprobe` on `PATH`) for video analysis

## Quick Start

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000`.

Default local credentials are `admin` / `Admin@123` (override via `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env`).

## Project Structure

```text
.
├── server.ts                  # Express entrypoint, auth middleware, and API routes
├── src/server/
│   ├── database.ts            # SQLite schema & persistence (WAL mode)
│   ├── predictor.ts           # XGBoost inference & feature attribution
│   ├── roadRegistry.ts        # Bengaluru 24-corridor metadata & geometry
│   ├── physics.ts             # Traffic flow & Level-of-Service math
│   ├── services.ts            # Events, heatmaps, routing, policy sim, live feeds
│   ├── visionService.ts       # Chunked upload, FFmpeg probing/extraction, job queue
│   ├── yolo11Engine.ts        # Local YOLOv11s ONNX inference engine
│   ├── cvTracker.ts           # Multi-object tracker & Indian PCU aggregation
│   └── core.test.ts           # Unit test suite (node:test)
├── public/
│   ├── index.html             # Operations dashboard
│   ├── login.html             # Operator sign-in page
│   ├── app.js                 # Dashboard client controller
│   ├── heat_canvas_engine.js  # Corridor congestion & heatmap renderer
│   ├── styles.css             # Application styles
│   └── guides/                # Operator visual guides & system diagrams
├── models/
│   ├── xgboost/               # Trained XGBoost trees, topology, and metrics JSON
│   └── yolo11/                # YOLOv11s ONNX weights (yolo11s.onnx)
├── data/
│   ├── seed_events.json       # Initial Bengaluru corridor events
│   └── storage/               # Runtime SQLite database & video uploads (gitignored)
├── Dockerfile                 # Production container (Node 22 + FFmpeg)
├── render.yaml                # Render deployment blueprint
└── package.json
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start development server (`tsx server.ts`) |
| `npm start` | Start production server (`node server.ts`) |
| `npm test` | Run unit tests |
| `npm run lint` | Run TypeScript type checks |
| `npm run build` | Validate production TypeScript build |

## Environment Variables

See `.env.example` for all supported variables:

- `PORT` — HTTP port in production (`3000` by default)
- `PERSISTENT_DATA_DIR` — Optional volume path for SQLite database and uploaded videos (defaults to `./data/storage`)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — Initial admin account credentials
- `SESSION_TTL_SECONDS` — Session lifetime in seconds (`43200` default)
- `GOOGLE_MAPS_API_KEY`, `GOOGLE_MAPS_BROWSER_KEY`, `GOOGLE_MAPS_MAP_ID` — Optional Google Maps integration
- `TOMTOM_API_KEY` — Optional TomTom live traffic feed
- `OPEN_METEO_URL` — Weather endpoint (defaults to Open-Meteo Bengaluru)

## Deployment

### Docker

```bash
docker build -t smart-traffic-ops .
docker run -p 3000:3000 \
  -e ADMIN_PASSWORD="your-strong-password" \
  -v traffic-data:/app/data/storage \
  smart-traffic-ops
```

### Render

Connect the repository in Render and deploy directly using `render.yaml`. Set `ADMIN_PASSWORD` (and any optional Maps/TomTom keys) in the Render dashboard.
