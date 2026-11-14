/**
 * minimap.js — Tactical HUD minimap/radar for a Three.js FPS game.
 * Draws a top-down 2D overlay onto a separate canvas (no Three.js).
 *
 * Exports: createMinimap(THREE) -> { mount(container), update(player, bots, bomb, sites), setVisible(bool), resize(w,h) }
 * Map footprint: 40 wide x 64 deep  (halfW=20, halfL=32).
 */

export function createMinimap(THREE) {
  // --- Configuration -----------------------------------------------------------
  const cfg = {
    mapW: 40, // world units (halfW = 20)
    mapH: 64, // world units (halfL = 32)
    viewDist: 28, // max distance a bot/explosive is visible from player
    zoom: 6, // world units per canvas pixel (larger = more zoomed out)
    dotSize: 3, // player trial size in px
    bombSize: 5, // bomb icon size in px
    fadeDist: 14, // distance at which visible things fade to transparent
  };

  // --- DOM / canvas setup ------------------------------------------------------
  const container = null;
  let canvas = null;
  let ctx = null;
  let styleEl = null;
  let styleStr = "";
  let visible = false;

  // Off-screen cache used while the radar sweep is being drawn.
  let offscreen = null;
  let offCtx = null;
  let sweepAngle = 0; // current sweep rotation in radians
  let sweepDir = 1;   // +1 = clockwise, -1 = counter-clockwise
  const sweepSpeed = 0.012; // radians per frame

  // Map orientation: convert a world position to a canvas (x,y) pixel.
  // We decide to show the world top-down: world Z = depth (into the screen).
  // Canvas X = -worldZ + halfL, Canvas Y = worldX + halfW (inverted Y axis)
  function toCanvas(worldX, worldZ) {
    // Cos/Sin compensate for map rotation around the world origin if any.
    const c = Math.cos(0);
    const s = Math.sin(0);
    // The minimap always points north (along -Z) at the top of the canvas.
    const cx = (worldZ + cfg.mapH / 2) * cfg.zoom;
    const cy = (worldX + cfg.mapW / 2) * cfg.zoom;
    return [cx, cy];
  }

  // Test a point against the axis-aligned map bounds.
  function insideMap(x, z) {
    return x >= -cfg.mapW / 2 && x <= cfg.mapW / 2 && z >= -cfg.mapH / 2 && z <= cfg.mapH / 2;
  }

  // === Public API ==============================================================

  function mount(el) {
    container = el;
    canvas = document.createElement("canvas");
    canvas.className = "minimap-overlay";
    canvas.width = 320;
    canvas.height = 448;
    // Keep the minimap aspect ratio (40:64 -> 5:8).
    canvas.style.width = "auto";
    canvas.style.height = "100%";
    canvas.style.maxWidth = "160px";
    canvas.style.maxHeight = "224px";
    canvas.style.position = "absolute";
    canvas.style.bottom = "16px";
    canvas.style.left = "16px";
    canvas.style.borderRadius = "8px";
    canvas.style.pointerEvents = "none";
    canvas.style.boxShadow = "0 2px 8px rgba(0,0,0,0.35)";
    container.appendChild(canvas);

    styleStr =
      ".minimap-overlay{" +
      "position:absolute;bottom:16px;left:16px;border-radius:8px;pointer-events:none;" +
      "box-shadow:0 2px 8px rgba(0,0,0,0.35);" +
      "background:rgba(8,12,20,0.85);color:#e8ecf4;padding:8px;border:1px solid rgba(255,255,255,0.12);" +
      "font-family:sans-serif;font-size:12px;letter-spacing:0.3px;}" +
      ".minimap-overlay canvas{max-width:100%;height:auto;}";
    styleEl = document.createElement("style");
    styleEl.textContent = styleStr;
    document.head.appendChild(styleEl);
    canvas.addEventListener("click", () => setVisible(!visible));
    updateSize();
  }

  function updateSize() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || 160;
    const h = rect.height || 224;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    // Off-screen buffer for the sweep, sized to the canvas.
    offscreen = document.createElement("canvas");
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    offCtx = offscreen.getContext("2d");
  }

  function setVisible(v) {
    visible = v;
    if (canvas) canvas.style.display = visible ? "block" : "none";
  }

  // --- Drawing helpers ---------------------------------------------------------
  function drawTile(ctx, x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }

  function strokeLine(ctx, x1, y1, x2, y2, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 1.5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // -- 1. Draw the map background and wall segments ---------------------------
  function drawMapWalls() {
    // Filled base: lightly tinted. Not strictly required by the spec, but it
    // makes the minimap readable against the HUD background.
    drawTile(ctx, 0, 0, canvas.width, canvas.height, "rgba(12,18,28,0.75)");

    // Walls are passed as 2D segments: [[x1,z1,x2,z2], ...].
    // They are rendered as 2D screen space lines.
    const wallList = this._walls || [];
    for (const w of wallList) {
      const [x1, z1, x2, z2] = w;
      if (!insideMap(x1, z1) || !insideMap(x2, z2)) continue;
      const [a] = toCanvas(x1, z1);
      const [b] = toCanvas(x2, z2);
      strokeLine(ctx, a, b, b, a, "rgba(70,85,110,0.85)", 2);
      // Lighter strokes for grid/trim (thin walls look slightly different).
    }
    // A subtle grid helps the player judge distance.
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let x = -cfg.mapW / 2; x <= cfg.mapW / 2; x += 4) {
      const [px] = toCanvas(x, -cfg.mapH / 2);
      const [qx] = toCanvas(x, cfg.mapH / 2);
      strokeLine(ctx, px, 0, qx, 0, "rgba(255,255,255,0.05)");
    }
    for (let z = -cfg.mapH / 2; z <= cfg.mapH / 2; z += 4) {
      const [py] = toCanvas(-cfg.mapW / 2, z);
      const [qy] = toCanvas(cfg.mapW / 2, z);
      strokeLine(ctx, 0, py, 0, qy, "rgba(255,255,255,0.05)");
    }
  }

  // -- 2. Fog-of-war / sweep mask ----------------------------------------------
  function drawSweepMask() {
    // Clear a transparent layer, then paint a wedge for the visible sweep.
    const W = offscreen.width;
    const H = offscreen.height;
    offCtx.clearRect(0, 0, W, H);
    offCtx.globalCompositeOperation = "destination-out";

    const cx = W / 2;
    const cy = H / 2;
    const sweepR = Math.min(W, H) * 0.48;

    offCtx.save();
    offCtx.beginPath();
    offCtx.moveTo(cx, cy);
    const start = sweepAngle;
    const end = sweepAngle + 0.7; // ~40deg wedge
    for (let i = start; i <= end; i += 0.05) {
      const rad = i;
      offCtx.lineTo(cx + Math.cos(rad) * sweepR, cy + Math.sin(rad) * sweepR);
    }
    offCtx.closePath();
    offCtx.fillStyle = "rgba(0,0,0,0.55)";
    offCtx.fill();
    offCtx.restore();

    // Blend the sweep wedge over the canvas.
    ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
  }

  // -- 3. Draw entities ---------------------------------------------------------
  function drawEntities(playerX, playerZ, playerYaw) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const dpr = window.devicePixelRatio || 1;

    // Player triangle (facing the player's yaw).
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(playerYaw);
    ctx.beginPath();
    ctx.moveTo(0, -cfg.dotSize);
    ctx.lineTo(-cfg.dotSize * 0.6, cfg.dotSize * 0.5);
    ctx.lineTo(cfg.dotSize * 0.6, cfg.dotSize * 0.5);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,180,255,0.9)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Fog of war: only enemies within view distance are shown.
    // Each entity fades in based on its distance from the player.
    for (const bot of this._bots || []) {
      if (bot.ally) continue; // Tag-style: red = enemy
      const [bx, by] = toCanvas(bot.x, bot.z);
      const dx = bx - cx;
      const dy = by - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > cfg.viewDist) continue;
      const alpha = Math.max(0.15, 1 - dist / cfg.fadeDist);
      ctx.save();
      ctx.translate(bx, by);
      ctx.beginPath();
      ctx.arc(0, 0, cfg.dotSize, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(220,40,40,${alpha})`;
      ctx.fill();
      ctx.strokeStyle = "rgba(255,80,80,0.9)";
      ctx.lineWidth = 1;
      ctx.stroke();
      // Blink a small indicator for very close enemies.
      if (dist < 8) {
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.beginPath();
        ctx.arc(0, 0, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Bomb: red flashing icon, visible only if within view distance.
    if (this._bomb && this._bomb.active) {
      const [bx, by] = toCanvas(this._bomb.x, this._bomb.z);
      const dx = bx - cx;
      const dy = by - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < cfg.viewDist) {
        const flash = 0.6 + 0.4 * Math.sin(Date.now() / 250);
        ctx.save();
        ctx.translate(bx, by);
        ctx.strokeStyle = `rgba(255,60,60,${flash})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, cfg.bombSize, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(255,60,60,${flash * 0.4})`;
        ctx.fill();
        // Small needle pointing to the bomb from the player.
        const bx2 = (this._bomb.x - playerX) * cfg.zoom;
        const bz2 = (this._bomb.z - playerZ) * cfg.zoom;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(bx2, bz2);
        ctx.strokeStyle = "rgba(255,60,60,0.4)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }
    }

    // Bomb sites: labeled zones (e.g., [S1] and [S2]).
    const labels = ["S1", "S2"];
    for (let i = 0; i < 2; i++) {
      const s = this._sites && this._sites[i];
      if (!s) continue;
      const [sx, sy] = toCanvas(s.x, s.z);
      const dx = sx - cx;
      const dy = sy - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < cfg.viewDist) {
        const alpha = Math.max(0.3, 1 - dist / cfg.fadeDist);
        ctx.save();
        ctx.translate(sx, sy);
        ctx.fillStyle = `rgba(30,140,255,${alpha})`;
        ctx.beginPath();
        ctx.arc(0, 0, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(30,140,255,${alpha})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = `rgba(255,255,255,${alpha})`;
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(labels[i], 0, 1);
        ctx.restore();
      }
    }
  }

  // == Public update ==
  function update(player, bots, bomb, sites) {
    // Store the pure data payloads for the drawing functions to read.
    this._walls = player.walls || [];
    this._bots = bots || [];
    this._bomb = bomb || null;
    this._sites = sites || null;
    this._player = player || { x: 0, z: 0, yaw: 0 };

    if (!visible) return;

    // --- Sweep radar animation (continuous rotation) ---
    sweepAngle += sweepDir * sweepSpeed;
    // Reverse direction occasionally so it does not lock on one side.
    if (Math.abs(sweepAngle % (Math.PI * 2)) < 0.05 || Math.abs(sweepAngle % (Math.PI * 2) - Math.PI) < 0.05) {
      sweepDir *= -1;
    }
    drawSweepMask();

    drawMapWalls();
    drawEntities(
      this._player.x,
      this._player.z,
      this._player.yaw
    );
  }

  // -- Resize ------------------------------------------------------------------
  function resize(w, h) {
    // The minimap canvas is sized via CSS, so this simply measures the
    // container and forces a re-layout using updateSize(). In a real HUD the
    // container would already be the actual window size; here we keep the
    // on-screen canvas at 320x448 with a 5:8 aspect ratio.
    const dpr = window.devicePixelRatio || 1;
    const cW = w || 320;
    const cH = h || 448;
    canvas.width = cW * dpr;
    canvas.height = cH * dpr;
    ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    offscreen = document.createElement("canvas");
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    offCtx = offscreen.getContext("2d");
  }

  return {
    mount,
    update,
    setVisible,
    resize,
  };
}
