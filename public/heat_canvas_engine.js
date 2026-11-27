/**
 * app/static/heat_canvas_engine.js - Severity-Preserving Traffic Region & Corridor Map Engine
 *
 * Implements:
 * 1. Metropolitan Sector Traffic Region Choropleth (8 Bengaluru sectors):
 *    - Low Flow (Less Traffic):    Emerald Green  (#10b981)
 *    - Moderate Flow:              Warm Amber     (#f59e0b)
 *    - High Congestion:            Signal Orange  (#f97316)
 *    - Severe Bottleneck (Heavy):  Crimson Red    (#ef4444)
 * 2. Severity-preserving per-corridor heat ribbons (each corridor renders strictly in its
 *    own severity hue so overlapping Low/Green corridors never saturate into Red).
 * 3. Clean compact junction status indicators with restrained beacon highlight ONLY on
 *    genuine Severe bottlenecks (eliminates giant hollow radar rings).
 * 4. Mounts seamlessly to Google Maps (via custom google.maps.OverlayView) and the
 *    offline Bengaluru Vector Fallback Canvas.
 */

class HeatCanvasEngine {
  constructor(options = {}) {
    this.options = Object.assign({
      radius: 26,
      opacity: 0.85,
      blur: 0.75
    }, options);

    this.gMap = null;
    this.vectorCanvas = null;
    this.overlayView = null;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "heat-canvas-overlay";
    this.ctx = this.canvas.getContext("2d");

    // Dedicated top-pane canvas so sector badges ALWAYS render crisply above Google Maps polylines & circles
    this.badgeCanvas = document.createElement("canvas");
    this.badgeCanvas.className = "heat-badge-overlay";
    this.badgeCtx = this.badgeCanvas.getContext("2d");

    this.data = null;
    this.activeHorizon = 0;
    this.activeZoneFilter = "all";
    this.hoveredZone = null;
    this.activeLayers = {
      traffic: true,
      crowd: false,
      junctions: true
    };

    this.severityPalette = {
      Low:      { hex: "#10b981", rgb: "16, 185, 129",  text: "#6ee7b7", tag: "CLEAR" },
      Moderate: { hex: "#f59e0b", rgb: "245, 158, 11",  text: "#fcd34d", tag: "MODERATE" },
      High:     { hex: "#f97316", rgb: "249, 115, 22",  text: "#fdba74", tag: "HIGH" },
      Severe:   { hex: "#ef4444", rgb: "239, 68, 68",   text: "#fca5a5", tag: "SEVERE" }
    };
  }

  _getStyleForLos(los, fallbackColor) {
    const norm = String(los || "Moderate").trim().toLowerCase();
    if (norm.includes("severe")) return this.severityPalette.Severe;
    if (norm.includes("high")) return this.severityPalette.High;
    if (norm.includes("mod")) return this.severityPalette.Moderate;
    if (norm.includes("low") || norm.includes("free") || norm.includes("clear")) {
      return this.severityPalette.Low;
    }
    if (fallbackColor === "#ef4444") return this.severityPalette.Severe;
    if (fallbackColor === "#f97316") return this.severityPalette.High;
    if (fallbackColor === "#10b981") return this.severityPalette.Low;
    return this.severityPalette.Moderate;
  }

  attachToGoogleMap(gMap) {
    if (!gMap || !window.google || !window.google.maps) return;
    if (this.overlayView) {
      try { this.overlayView.setMap(null); } catch (e) {}
    }
    this.gMap = gMap;

    const engine = this;
    const Overlay = function() {};
    Overlay.prototype = new window.google.maps.OverlayView();

    Overlay.prototype.onAdd = function() {
      const panes = this.getPanes();
      engine.canvas.style.position = "absolute";
      engine.canvas.style.pointerEvents = "none";
      engine.canvas.style.zIndex = "10";
      panes.overlayLayer.appendChild(engine.canvas);

      engine.badgeCanvas.style.position = "absolute";
      engine.badgeCanvas.style.pointerEvents = "none";
      engine.badgeCanvas.style.zIndex = "50";
      (panes.floatPane || panes.overlayMouseTarget || panes.overlayLayer).appendChild(engine.badgeCanvas);
    };

    Overlay.prototype.draw = function() {
      const projection = this.getProjection();
      if (!projection) return;

      const bounds = engine.gMap.getBounds();
      if (!bounds) return;

      const sw = projection.fromLatLngToDivPixel(bounds.getSouthWest());
      const ne = projection.fromLatLngToDivPixel(bounds.getNorthEast());
      if (!sw || !ne) return;

      const left = Math.min(sw.x, ne.x);
      const top = Math.min(sw.y, ne.y);
      const width = Math.max(10, Math.round(Math.abs(ne.x - sw.x)));
      const height = Math.max(10, Math.round(Math.abs(sw.y - ne.y)));

      [engine.canvas, engine.badgeCanvas].forEach((c) => {
        c.style.left = `${left}px`;
        c.style.top = `${top}px`;
        c.style.width = `${width}px`;
        c.style.height = `${height}px`;
        c.width = width;
        c.height = height;
      });

      engine._currentOrigin = { left, top };
      engine.renderHeatmap();
    };

    Overlay.prototype.onRemove = function() {
      if (engine.canvas.parentElement) {
        engine.canvas.parentElement.removeChild(engine.canvas);
      }
      if (engine.badgeCanvas.parentElement) {
        engine.badgeCanvas.parentElement.removeChild(engine.badgeCanvas);
      }
    };

    this.overlayView = new Overlay();
    this.overlayView.setMap(gMap);
  }

  attachToVectorCanvas(vectorCanvas) {
    if (!vectorCanvas) return;
    this.vectorCanvas = vectorCanvas;
    this.canvas.width = vectorCanvas.width || 900;
    this.canvas.height = vectorCanvas.height || 520;
    this._currentOrigin = { left: 0, top: 0 };
    this.renderHeatmap();
  }

  setData(payload) {
    this.data = payload;
    if (payload && typeof payload.horizon_minutes === "number") {
      this.activeHorizon = payload.horizon_minutes;
    }
    this.renderHeatmap();
  }

  setHorizon(minutes) {
    this.activeHorizon = Math.max(0, Math.min(60, Number(minutes) || 0));
    this.renderHeatmap();
  }

  setActiveZone(zone) {
    this.activeZoneFilter = zone || "all";
    this.renderHeatmap();
  }

  setHoveredZone(zone) {
    if (this.hoveredZone === zone) return;
    this.hoveredZone = zone || null;
    this.renderHeatmap();
  }

  setLayers(layerToggles) {
    this.activeLayers = Object.assign(this.activeLayers, layerToggles);
    this.renderHeatmap();
  }

  clear() {
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    if (this.badgeCtx && this.badgeCanvas) {
      this.badgeCtx.clearRect(0, 0, this.badgeCanvas.width, this.badgeCanvas.height);
    }
  }

  _drawRoundedPolygon(ctx, pts, cornerRadius = 14) {
    if (!pts || pts.length < 3) return;
    ctx.beginPath();
    const len = pts.length;
    for (let i = 0; i < len; i++) {
      const pPrev = pts[(i - 1 + len) % len];
      const pCurr = pts[i];
      const pNext = pts[(i + 1) % len];

      const v1x = pPrev.x - pCurr.x;
      const v1y = pPrev.y - pCurr.y;
      const d1 = Math.hypot(v1x, v1y) || 1;
      const v2x = pNext.x - pCurr.x;
      const v2y = pNext.y - pCurr.y;
      const d2 = Math.hypot(v2x, v2y) || 1;

      const r = Math.min(cornerRadius, d1 * 0.28, d2 * 0.28);
      const startX = pCurr.x + (v1x / d1) * r;
      const startY = pCurr.y + (v1y / d1) * r;
      const endX = pCurr.x + (v2x / d2) * r;
      const endY = pCurr.y + (v2y / d2) * r;

      if (i === 0) {
        ctx.moveTo(startX, startY);
      } else {
        ctx.lineTo(startX, startY);
      }
      ctx.quadraticCurveTo(pCurr.x, pCurr.y, endX, endY);
    }
    ctx.closePath();
  }

  _drawRegionChoropleth(ctx, w, h) {
    const regions = Array.isArray(this.data?.region_layer) ? this.data.region_layer : [];
    if (regions.length === 0) return;

    const zoom = this.gMap && typeof this.gMap.getZoom === "function" ? this.gMap.getZoom() : 12;
    const labelQueue = [];

    regions.forEach((reg) => {
      if (!Array.isArray(reg.polygon) || reg.polygon.length < 3) return;
      const screenPts = reg.polygon
        .map((pair) => this._projectLatLng(pair[0], pair[1]))
        .filter(Boolean);
      if (screenPts.length < 3) return;

      const centerPt = reg.center
        ? this._projectLatLng(reg.center.lat, reg.center.lng)
        : null;
      if (!centerPt) return;

      // Skip polygons completely outside viewport
      const inView = screenPts.some(
        (p) => p.x >= -120 && p.x <= w + 120 && p.y >= -120 && p.y <= h + 120
      );
      if (!inView) return;

      const style = this._getStyleForLos(reg.congestion_level, reg.color);
      const isZoneFiltered = this.activeZoneFilter !== "all";
      const isSelected = !isZoneFiltered || this.activeZoneFilter === reg.city_zone;
      const isHovered = this.hoveredZone === reg.city_zone;

      // Compute approximate screen radius for soft interior gradient
      let maxR = 45;
      screenPts.forEach((p) => {
        const d = Math.hypot(p.x - centerPt.x, p.y - centerPt.y);
        if (d > maxR) maxR = d;
      });

      const fillCenterAlpha = isSelected
        ? (isHovered ? 0.34 : (reg.congestion_level === "Severe" ? 0.30 : reg.congestion_level === "High" ? 0.25 : 0.22))
        : 0.06;
      const fillEdgeAlpha = isSelected
        ? (isHovered ? 0.19 : (reg.congestion_level === "Severe" ? 0.16 : 0.12))
        : 0.025;
      const strokeAlpha = isSelected
        ? (isHovered ? 0.98 : 0.80)
        : 0.20;

      ctx.save();
      this._drawRoundedPolygon(ctx, screenPts, Math.min(20, maxR * 0.22));

      // Smooth radial region shading strictly in the sector's true severity hue
      const grad = ctx.createRadialGradient(
        centerPt.x, centerPt.y, maxR * 0.08,
        centerPt.x, centerPt.y, maxR * 1.05
      );
      grad.addColorStop(0, `rgba(${style.rgb}, ${fillCenterAlpha})`);
      grad.addColorStop(1, `rgba(${style.rgb}, ${fillEdgeAlpha})`);
      ctx.fillStyle = grad;
      ctx.fill();

      // Subtle outer luminous halo + crisp dashed/solid region perimeter
      ctx.lineWidth = isSelected ? (isHovered ? 3.2 : 2.1) : 1.1;
      ctx.strokeStyle = `rgba(${style.rgb}, ${strokeAlpha})`;
      if (!isSelected) {
        ctx.setLineDash([5, 5]);
      } else if (isZoneFiltered) {
        ctx.shadowColor = `rgba(${style.rgb}, 0.65)`;
        ctx.shadowBlur = 10;
      }
      ctx.stroke();
      ctx.restore();

      // Anchor compact sector badge cleanly near top edge of its region polygon
      // so it never obscures central road intersections or hides behind the top-left HUD.
      let minY = Infinity;
      let maxY = -Infinity;
      screenPts.forEach((p) => {
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      });
      let badgeX = centerPt.x;
      let badgeY = Math.min(centerPt.y, minY + Math.max(18, (maxY - minY) * 0.22));
      if (badgeX < 520 && badgeY < 86) {
        badgeY = Math.min(maxY - 16, Math.max(centerPt.y, 88));
      }
      if (badgeX >= 48 && badgeX <= w - 48 && badgeY >= 24 && badgeY <= h - 22) {
        labelQueue.push({
          x: badgeX,
          y: badgeY,
          reg,
          style,
          isSelected,
          isHovered,
          zoom
        });
      }
    });

    this._pendingRegionLabels = labelQueue;
  }

  _drawRegionBadges(ctx) {
    const labels = this._pendingRegionLabels || [];
    if (labels.length === 0) return;

    const w = this.badgeCanvas ? this.badgeCanvas.width : this.canvas.width;
    const h = this.badgeCanvas ? this.badgeCanvas.height : this.canvas.height;
    const sevRank = { Severe: 3, High: 2, Moderate: 1, Low: 0 };

    // Prioritize higher-severity sectors so Red/Orange labels always claim their prime position first
    const ordered = labels.slice().sort((a, b) => {
      const diff = (sevRank[b.reg.congestion_level] || 0) - (sevRank[a.reg.congestion_level] || 0);
      return diff !== 0 ? diff : a.y - b.y;
    });

    const placedBoxes = [];
    // Reserve top-left Tactical HUD footprint so badges never tuck behind it
    const hudRect = { x1: 0, y1: 0, x2: 520, y2: 86 };
    const overlaps = (box, other) =>
      !(box.x2 < other.x1 || box.x1 > other.x2 || box.y2 < other.y1 || box.y1 > other.y2);

    ordered.forEach(({ x, y, reg, style, isSelected, isHovered, zoom }) => {
      if (!isSelected && this.activeZoneFilter !== "all") return;
      const title = String(reg.short_label || reg.city_zone || "").toUpperCase();
      const speedText = `${Math.round(Number(reg.avg_speed_kmh) || 0)} km/h`;
      const compact = zoom <= 11.2;
      const showDetail = zoom >= 10.5;
      const fontSize = compact ? 9.5 : 10;

      ctx.save();
      ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
      const titleW = ctx.measureText(title).width;
      ctx.font = `700 ${fontSize}px 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace`;
      const spdW = showDetail ? ctx.measureText(speedText).width : 0;

      const dotPad = compact ? 11 : 13;
      const gap = showDetail ? (compact ? 6 : 8) : 0;
      const padX = compact ? 8 : 10;
      const pillW = Math.round(padX * 2 + dotPad + titleW + gap + spdW);
      const pillH = compact ? 20 : 22;

      // Test candidate offsets around anchor to eliminate pill-on-pill collisions
      const candidates = [
        [0, 0], [0, -24], [0, 24], [-42, 0], [42, 0],
        [-34, -22], [34, -22], [-34, 24], [34, 24],
        [0, -44], [0, 44], [-68, -16], [68, 16]
      ];
      let chosenX = Math.round(x - pillW / 2);
      let chosenY = Math.round(y - pillH / 2);
      for (const [dx, dy] of candidates) {
        const cx = Math.max(10, Math.min(w - pillW - 10, Math.round(x + dx - pillW / 2)));
        const cy = Math.max(10, Math.min(h - pillH - 26, Math.round(y + dy - pillH / 2)));
        const box = { x1: cx - 3, y1: cy - 3, x2: cx + pillW + 3, y2: cy + pillH + 3 };
        if (overlaps(box, hudRect)) continue;
        if (!placedBoxes.some((b) => overlaps(box, b))) {
          chosenX = cx;
          chosenY = cy;
          placedBoxes.push(box);
          break;
        }
      }
      if (placedBoxes.length === 0 || !placedBoxes.some((b) => b.x1 === chosenX - 3 && b.y1 === chosenY - 3)) {
        placedBoxes.push({ x1: chosenX - 3, y1: chosenY - 3, x2: chosenX + pillW + 3, y2: chosenY + pillH + 3 });
      }

      const rx = chosenX;
      const ry = chosenY;

      // Dark translucent glass pill with crisp severity-colored border
      ctx.beginPath();
      this._roundRectPath(ctx, rx, ry, pillW, pillH, pillH / 2);
      ctx.fillStyle = isHovered ? "rgba(7, 11, 20, 0.96)" : "rgba(7, 11, 20, 0.88)";
      ctx.fill();
      ctx.lineWidth = isHovered ? 1.8 : 1.25;
      ctx.strokeStyle = `rgba(${style.rgb}, ${isHovered ? 1.0 : 0.88})`;
      ctx.stroke();

      // Colored traffic severity indicator dot
      const dotX = rx + padX + 3;
      const dotY = ry + pillH / 2;
      ctx.beginPath();
      ctx.arc(dotX, dotY, compact ? 3.5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = style.hex;
      ctx.fill();

      // Sector label
      ctx.fillStyle = "#f8fafc";
      ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.fillText(title, dotX + (compact ? 8 : 9), dotY + 0.5);

      // Live regional average speed
      if (showDetail) {
        ctx.fillStyle = style.text;
        ctx.font = `700 ${fontSize}px 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace`;
        ctx.fillText(speedText, dotX + (compact ? 8 : 9) + titleW + gap, dotY + 0.5);
      }

      ctx.restore();
    });
  }

  _roundRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  _drawSeverityCorridorRibbons(ctx, w, h) {
    const corridors = Array.isArray(this.data?.traffic_layer) ? this.data.traffic_layer : [];
    if (corridors.length === 0) return;

    // Sort Low -> Moderate -> High -> Severe so congested bottlenecks always read clearly on top
    const order = { Low: 0, Moderate: 1, High: 2, Severe: 3 };
    const sorted = corridors.slice().sort(
      (a, b) => (order[a.predicted_los] || 0) - (order[b.predicted_los] || 0)
    );

    sorted.forEach((corridor) => {
      const segs = corridor.sub_segments || [];
      if (segs.length < 2) return;

      const pts = segs
        .map((pt) => this._projectLatLng(pt.lat, pt.lng))
        .filter(Boolean);
      if (pts.length < 2) return;

      const inView = pts.some(
        (p) => p.x >= -60 && p.x <= w + 60 && p.y >= -60 && p.y <= h + 60
      );
      if (!inView) return;

      const style = this._getStyleForLos(corridor.predicted_los, corridor.color);
      const isSelected =
        this.activeZoneFilter === "all" || corridor.city_zone === this.activeZoneFilter;
      const isSevere = corridor.predicted_los === "Severe";
      const isHigh = corridor.predicted_los === "High";

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Pass 1: Soft severity-preserving ambient heat halo (NEVER hue-shifts green to red)
      ctx.beginPath();
      pts.forEach((p, idx) => {
        if (idx === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.strokeStyle = `rgba(${style.rgb}, ${isSelected ? (isSevere ? 0.34 : isHigh ? 0.26 : 0.20) : 0.05})`;
      ctx.lineWidth = isSelected ? (isSevere ? 24 : isHigh ? 20 : 16) : 8;
      ctx.stroke();

      // Pass 2: Focused mid-glow ribbon along the corridor centerline
      ctx.strokeStyle = `rgba(${style.rgb}, ${isSelected ? (isSevere ? 0.62 : 0.44) : 0.12})`;
      ctx.lineWidth = isSelected ? (isSevere ? 10 : 8) : 3.5;
      ctx.stroke();

      ctx.restore();
    });
  }

  _drawCrowdLayer(ctx, w, h) {
    const hubs = Array.isArray(this.data?.crowd_layer) ? this.data.crowd_layer : [];
    if (hubs.length === 0) return;

    hubs.forEach((hub) => {
      const pt = this._projectLatLng(hub.lat, hub.lng);
      if (!pt || pt.x < -60 || pt.x > w + 60 || pt.y < -60 || pt.y > h + 60) return;

      const rad = Math.round(28 + (hub.weight || 0.5) * 26);
      const grad = ctx.createRadialGradient(pt.x, pt.y, 2, pt.x, pt.y, rad);
      grad.addColorStop(0, "rgba(168, 85, 247, 0.50)");
      grad.addColorStop(0.55, "rgba(6, 182, 212, 0.26)");
      grad.addColorStop(1, "rgba(6, 182, 212, 0.0)");

      ctx.save();
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  _drawJunctionIndicators(ctx, w, h) {
    const junctions = Array.isArray(this.data?.junction_layer) ? this.data.junction_layer : [];
    if (junctions.length === 0) return;

    junctions.forEach((j) => {
      const pt = this._projectLatLng(j.lat, j.lng);
      if (!pt || pt.x < -30 || pt.x > w + 30 || pt.y < -30 || pt.y > h + 30) return;

      const isSelected =
        this.activeZoneFilter === "all" || !j.city_zone || j.city_zone === this.activeZoneFilter;
      const style = this._getStyleForLos(j.predicted_los, j.alert_color);
      const isSevere = j.predicted_los === "Severe" || j.is_jam_hotspot === true;

      ctx.save();
      ctx.globalAlpha = isSelected ? 1.0 : 0.22;

      // Subtle beacon halo ONLY for genuine Severe bottlenecks (no distracting giant target rings)
      if (isSevere && isSelected) {
        const glow = ctx.createRadialGradient(pt.x, pt.y, 3, pt.x, pt.y, 18);
        glow.addColorStop(0, "rgba(239, 68, 68, 0.55)");
        glow.addColorStop(1, "rgba(239, 68, 68, 0.0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 18, 0, Math.PI * 2);
        ctx.fill();
      }

      // Crisp junction node dot
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isSevere ? 5.5 : 4.2, 0, Math.PI * 2);
      ctx.fillStyle = style.hex;
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = "#070b12";
      ctx.stroke();

      ctx.restore();
    });
  }

  renderHeatmap() {
    if (!this.canvas || !this.ctx || !this.data) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w <= 0 || h <= 0) return;

    this.clear();
    this._pendingRegionLabels = [];

    // 1. Traffic Regions (Green -> Amber -> Orange -> Red choropleth) + Corridor Ribbons
    if (this.activeLayers.traffic) {
      this._drawRegionChoropleth(this.ctx, w, h);
      this._drawSeverityCorridorRibbons(this.ctx, w, h);
    }

    // 2. Optional Pedestrian VRU Crowd Layer
    if (this.activeLayers.crowd) {
      this._drawCrowdLayer(this.ctx, w, h);
    }

    // 3. Compact Junction Indicators (strictly gated by activeLayers.junctions)
    if (this.activeLayers.junctions) {
      this._drawJunctionIndicators(this.ctx, w, h);
    }

    // 4. Floating Sector Speed Badges on top pane (above Google Maps polylines & junction nodes)
    if (this.activeLayers.traffic) {
      const targetBadgeCtx = (this.gMap && this.badgeCanvas && this.badgeCanvas.parentElement)
        ? this.badgeCtx
        : this.ctx;
      this._drawRegionBadges(targetBadgeCtx);
    }
  }

  _projectLatLng(lat, lng) {
    if (this.gMap && this.overlayView && window.google && window.google.maps) {
      const projection = this.overlayView.getProjection();
      if (!projection) return null;
      const divPt = projection.fromLatLngToDivPixel(new window.google.maps.LatLng(lat, lng));
      if (!divPt || !this._currentOrigin) return null;
      return {
        x: divPt.x - this._currentOrigin.left,
        y: divPt.y - this._currentOrigin.top
      };
    } else if (this.vectorCanvas) {
      const minLat = 12.82, maxLat = 13.08;
      const minLng = 77.50, maxLng = 77.78;
      const x = ((lng - minLng) / (maxLng - minLng)) * (this.canvas.width * 0.86) + (this.canvas.width * 0.07);
      const y = this.canvas.height - (((lat - minLat) / (maxLat - minLat)) * (this.canvas.height * 0.86) + (this.canvas.height * 0.07));
      return { x, y };
    }
    return null;
  }
}

window.HeatCanvasEngine = HeatCanvasEngine;
