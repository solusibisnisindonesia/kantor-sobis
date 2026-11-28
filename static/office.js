/* Rekan Kantor · a data-driven, asset-free isometric office. */
"use strict";

window.Office = (function () {
  const W = 1200, H = 780;
  let canvas = null, ctx = null, options = {}, visible = false;
  let agents = [], tasks = [], statuses = new Map(), slots = [], page = 1;
  let raf = null, bound = false, reduceMotion = false, intersecting = true;
  let expiryTimer = null, transfers = [];
  const bubbles = new Map();
  const BOARD = { x: 886, y: 28, w: 284, h: 158 };
  const STATUS = {
    idle: { label: "Siap", color: "#54645e" },
    working: { label: "Bekerja", color: "#087b70" },
    error: { label: "Gagal", color: "#b43c3c" }
  };
  const statusOf = name => statuses.get(name)?.status || "idle";
  const normalizeStatus = value => Object.hasOwn(STATUS, value) ? value : "idle";
  function canDraw() { return Boolean(ctx && visible && intersecting && !document.hidden); }
  function prune() {
    const now = performance.now();
    for (const [name, bubble] of bubbles) if (bubble.until <= now) bubbles.delete(name);
    const names = new Set(slots.map(s => s.name));
    transfers = transfers.filter(t => t.until > now && names.has(t.from) && names.has(t.to));
  }
  function wantsMotion() { return canDraw() && !reduceMotion && (transfers.length > 0 || slots.some(s => statusOf(s.name) === "working")); }
  function syncLoop() {
    prune();
    if (!wantsMotion() && raf !== null) { cancelAnimationFrame(raf); raf = null; }
    if (wantsMotion() && raf === null) raf = requestAnimationFrame(tick);
    if (expiryTimer !== null) { clearTimeout(expiryTimer); expiryTimer = null; }
    if (canDraw() && raf === null) {
      const deadlines = slots.map(s => bubbles.get(s.name)?.until).filter(Boolean).concat(transfers.map(t => t.until));
      if (deadlines.length) expiryTimer = setTimeout(() => { expiryTimer = null; invalidate(); }, Math.max(1, Math.min(...deadlines) - performance.now() + 1));
    }
  }
  function tick() {
    raf = null;
    if (canDraw()) render();
    syncLoop();
  }
  function invalidate() { if (canDraw()) render(); syncLoop(); }

  function pages() { return Math.max(1, Math.ceil(agents.length / 8)); }
  function iso(x, y, z = 0) { return { x: 568 + (x - y) * 37, y: 205 + (x + y) * 18.5 - z }; }
  function layout() {
    page = Math.min(page, pages());
    let worker = 0;
    slots = agents.slice((page - 1) * 8, page * 8).map(a => {
      const coordinator = Boolean(a.is_orchestrator);
      const i = worker;
      if (!coordinator) worker++;
      const gx = coordinator ? 2.8 : 6.0 + (i % 3) * 3.05;
      const gy = coordinator ? 2.5 : 1.9 + Math.floor(i / 3) * 3.0;
      return { name: a.name, coordinator, gx, gy, ...iso(gx, gy + 0.95) };
    });
  }
  function text(value, x, y, size = 16, color = "#263e39", weight = 500, align = "center") {
    ctx.font = `${weight} ${size}px system-ui, sans-serif`;
    ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = "middle";
    ctx.fillText(value, x, y);
  }
  function pointer(event) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = (event.clientX - r.left) * W / r.width, y = (event.clientY - r.top) * H / r.height;
    if (x >= BOARD.x && x <= BOARD.x + BOARD.w && y >= BOARD.y && y <= BOARD.y + BOARD.h) return { board: true };
    return slots.find(s => (Math.abs(x - s.x) <= 23 && y >= s.y - 58 && y <= s.y + 4) || (Math.abs(x - s.x) <= 88 && y > s.y + 4 && y <= s.y + 48)) || null;
  }
  function polygon(points, fill, stroke) {
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }
  function panel(x, y, w, h, fill, radius = 10) {
    ctx.beginPath(); ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius); ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius); ctx.arcTo(x, y, x + w, y, radius); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
  }
  function clipped(value, max = 29) {
    const chars = Array.from(String(value || "").replace(/\s+/g, " ").trim());
    return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : chars.join("");
  }
  // Every solid uses the same world-to-screen projection. No bounding-diamond shortcuts.
  function plane(x, y, w, d, z, color, stroke) {
    polygon([iso(x, y, z), iso(x + w, y, z), iso(x + w, y + d, z), iso(x, y + d, z)], color, stroke);
  }
  function box(x, y, w, d, height, top, left, right, z = 0) {
    const a = iso(x, y, z + height), b = iso(x + w, y, z + height);
    const c = iso(x + w, y + d, z + height), e = iso(x, y + d, z + height);
    const bb = iso(x + w, y, z), cc = iso(x + w, y + d, z), ee = iso(x, y + d, z);
    polygon([e, c, cc, ee], left);
    polygon([b, c, cc, bb], right);
    polygon([a, b, c, e], top);
  }
  function line(a, b, color, width = 1) {
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  }
  function ellipse(x, y, rx, ry, color, rotation = 0) {
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  }
  function shadow(x, y, rx, ry) { const p = iso(x, y); ellipse(p.x + 5, p.y + 4, rx, ry, "rgba(53,50,36,.10)"); }
  function floorAndWalls() {
    // The cutaway slab has actual depth; restrained staggered oak strips replace checkerboard tiles.
    const corners = [iso(0, 0), iso(14, 0), iso(14, 12), iso(0, 12)];
    polygon(corners.map(p => ({ x: p.x + 7, y: p.y + 24 })), "rgba(50,59,43,.09)");
    box(0, 0, 14, 12, 16, "#e7ddca", "#c4b399", "#b5a58b", -16);
    const oak = ["#e6dcc9", "#e9dfcd", "#e4dac6", "#e8decb"];
    for (let row = 0; row < 24; row++) {
      const y = row * 0.5;
      for (let x = 0; x < 14; x += 2) {
        const length = Math.min(2, 14 - x);
        plane(x, y, length, 0.5, 0.2, oak[(row * 3 + x) % oak.length], "rgba(111,92,60,.055)");
        if ((row + x) % 3 === 0) line(iso(x + 0.22, y + 0.24, 0.3), iso(x + length - 0.15, y + 0.24, 0.3), "rgba(123,99,65,.065)");
      }
    }
    // Back walls with a slim teal skirting and an ivory cap.
    box(-0.12, 0, 0.12, 12, 124, "#f5f0e5", "#dedfcd", "#dedfcd");
    box(0, -0.12, 14, 0.12, 124, "#f5f0e5", "#e8e7d8", "#d6d8c7");
    box(0, 0, 0.06, 12, 7, "#648b7e", "#648b7e", "#648b7e");
    box(0, 0, 14, 0.06, 7, "#729486", "#729486", "#729486");
    for (let y = 0.8; y < 11.8; y += 0.42) line(iso(0.015, y, 10), iso(0.015, y, 121), "rgba(95,105,80,.055)");
    // Inset glazing follows the wall plane, including its sill and mullions.
    const leftWindow = (start, end) => {
      polygon([iso(0.08, start, 108), iso(0.08, end, 108), iso(0.08, end, 43), iso(0.08, start, 43)], "#7f9e93");
      polygon([iso(0.09, start + 0.1, 104), iso(0.09, end - 0.1, 104), iso(0.09, end - 0.1, 48), iso(0.09, start + 0.1, 48)], "#c5dcd2");
      polygon([iso(0.10, start + 0.12, 102), iso(0.10, end - 0.12, 102), iso(0.10, start + 0.12, 57)], "rgba(252,248,219,.46)");
      for (let y = start + 0.75; y < end; y += 0.85) line(iso(0.11, y, 46), iso(0.11, y, 106), "#f4f2e5", 3);
      line(iso(0.12, start, 75), iso(0.12, end, 75), "#f4f2e5", 3);
      box(0, start - 0.08, 0.28, end - start + 0.16, 5, "#f5f0de", "#c3bfaa", "#c3bfaa", 40);
    };
    leftWindow(1.9, 5.5); leftWindow(7.0, 10.6);
    polygon([iso(6.0, 0.08, 108), iso(9.2, 0.08, 108), iso(9.2, 0.08, 49), iso(6.0, 0.08, 49)], "#74958a");
    polygon([iso(6.1, 0.10, 104), iso(9.1, 0.10, 104), iso(9.1, 0.10, 53), iso(6.1, 0.10, 53)], "#d1e2d8");
    for (let x = 6.8; x < 9.2; x += 0.8) line(iso(x, 0.12, 51), iso(x, 0.12, 106), "#f8f6e9", 3);
    line(iso(6, 0.12, 79), iso(9.2, 0.12, 79), "#f8f6e9", 3);
    // Framed abstract art, not an invented activity display.
    polygon([iso(10.7, 0.13, 106), iso(12.6, 0.13, 106), iso(12.6, 0.13, 53), iso(10.7, 0.13, 53)], "#997951");
    polygon([iso(10.8, 0.14, 102), iso(12.5, 0.14, 102), iso(12.5, 0.14, 57), iso(10.8, 0.14, 57)], "#f6edda");
    polygon([iso(10.9, 0.15, 59), iso(11.65, 0.15, 94), iso(12.4, 0.15, 59)], "#769282");
    const sun = iso(12.05, 0.16, 91); ellipse(sun.x, sun.y, 6, 7, "#c6a365");
    // A quiet patch of morning light is static, never an idle animation.
    plane(0.6, 4.7, 3.8, 1.8, 0.4, "rgba(255,247,213,.19)");
  }
  function rug(x, y, w, d, color) {
    plane(x, y, w, d, 0.5, color);
    plane(x + 0.13, y + 0.13, w - 0.26, d - 0.26, 0.6, null, "rgba(247,244,229,.58)");
    for (let i = 0.25; i < w; i += 0.22) line(iso(x + i, y + d - 0.18, 0.8), iso(x + i, y + d - 0.06, 0.8), "rgba(255,255,244,.35)");
  }
  function plant(x, y, scale = 1) {
    const p = iso(x, y);
    shadow(x, y, 18 * scale, 7 * scale);
    box(x - 0.23, y - 0.23, 0.46, 0.46, 17 * scale, "#ccbaa0", "#b29c7f", "#a58e71");
    ellipse(p.x, p.y - 17 * scale, 11, 5, "#6c6650");
    for (let i = 0; i < 7; i++) {
      const angle = i * 2.4, dx = Math.cos(angle) * 15 * scale;
      const top = p.y - (31 + (i % 3) * 8) * scale;
      line({ x: p.x, y: p.y - 16 * scale }, { x: p.x + dx, y: top }, "#627752", 1.6);
      ellipse(p.x + dx, top, 6 * scale, 13 * scale, i % 2 ? "#6e8c5d" : "#4f7956", -angle * 0.45);
    }
  }
  function chair(x, y, teal = "#346f68") {
    const p = iso(x, y);
    shadow(x, y, 20, 7);
    line(iso(x, y, 1), iso(x, y, 17), "#52594e", 4);
    line({ x: p.x - 15, y: p.y + 1 }, { x: p.x + 15, y: p.y + 1 }, "#52594e", 2);
    box(x - 0.3, y - 0.3, 0.6, 0.6, 5, "#588b80", "#2f5d56", "#2a554f", 15);
    box(x - 0.3, y + 0.21, 0.6, 0.13, 23, teal, "#2a5952", "#27514c", 19);
  }
  function timberTable(x, y, w, d, height, top = "#cda373") {
    shadow(x + w / 2, y + d / 2, (w + d) * 15, (w + d) * 7);
    for (const [dx, dy] of [[0.12, 0.1], [w - 0.22, 0.1], [0.12, d - 0.2], [w - 0.22, d - 0.2]]) {
      box(x + dx, y + dy, 0.1, 0.1, height - 3, "#77624c", "#685a48", "#5c5142");
    }
    box(x, y, w, d, 4, top, "#a87950", "#9c714b", height - 4);
    for (let j = 1; j < 5; j++) line(iso(x + 0.12, y + d * j / 5, height + 0.1), iso(x + w - 0.12, y + d * j / 5, height + 0.1), "rgba(107,72,38,.11)");
    line(iso(x, y + d, height + 0.2), iso(x + w, y + d, height + 0.2), "rgba(255,236,196,.55)");
  }
  function workstation(s) {
    const { gx: x, gy: y } = s, height = s.coordinator ? 35 : 34, width = s.coordinator ? 2.5 : 2.15;
    const working = statusOf(s.name) === "working";
    timberTable(x - width / 2, y - 0.55, width, 1.05, height);
    // Screen and stand are solids in the desk plane, rather than floating front-facing icons.
    box(x - 0.19, y - 0.2, 0.38, 0.27, 2, "#53635d", "#3e4d46", "#37463f", height);
    box(x - 0.055, y - 0.15, 0.11, 0.11, 8, "#53635d", "#3e4d46", "#37463f", height + 2);
    box(x - 0.44, y - 0.24, 0.88, 0.12, 23, "#465b54", "#33463f", "#2d3e38", height + 9);
    polygon([iso(x - 0.37, y - 0.105, height + 29), iso(x + 0.37, y - 0.105, height + 29), iso(x + 0.37, y - 0.105, height + 12), iso(x - 0.37, y - 0.105, height + 12)], working ? "#a1cbb6" : "#bdcfc2");
    for (let row = 0; row < 3; row++) line(iso(x - 0.27, y - 0.1, height + 24 - row * 4), iso(x + 0.12 - row * 0.07, y - 0.1, height + 24 - row * 4), working ? "#518d75" : "#91a99b", 1.5);
    if (working) {
      const phase = reduceMotion ? 0 : Math.floor(performance.now() / 210) % 3;
      const p = iso(x - 0.23 + phase * 0.15, y - 0.09, height + 14);
      ellipse(p.x, p.y, 2, 1.5, "#236a55");
    }
    box(x - 0.34, y + 0.14, 0.68, 0.25, 1.5, "#e7e8dc", "#bbbfb1", "#b1b9ac", height);
    for (let i = 1; i < 6; i++) line(iso(x - 0.34 + i * 0.11, y + 0.16, height + 1.7), iso(x - 0.34 + i * 0.11, y + 0.36, height + 1.7), "#b8bfae");
    const mug = iso(x + width / 2 - 0.25, y + 0.12, height + 7);
    panel(mug.x - 4, mug.y, 8, 8, "#eae5d5", 2); ellipse(mug.x, mug.y, 4, 2, "#85745b");
    if (s.coordinator) {
      box(x - 0.97, y + 0.05, 0.35, 0.4, 2, "#7c9381", "#607761", "#607761", height);
      box(x - 1, y + 0.04, 0.35, 0.4, 1.3, "#e8ddbb", "#c9bd97", "#c9bd97", height + 2);
    }
    chair(x, y + 0.95);
    avatar(s, working);
  }
  function avatar(s, working) {
    const { x, y } = s;
    const palette = ["#477e87", "#9e7652", "#7d789b", "#70865e", "#ae7964", "#657f98"];
    let hash = 0; for (const c of s.name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    const skin = ["#dbb28d", "#c68e66", "#efc6a1", "#b88361"][hash % 4];
    const shirt = s.coordinator ? "#ac8050" : palette[hash % palette.length];
    const typing = working && !reduceMotion ? Math.sin(performance.now() / 115) * 1.8 : 0;
    ellipse(x - 5, y - 3, 6, 3, "#38483f"); ellipse(x + 7, y - 1, 6, 3, "#38483f");
    panel(x - 10, y - 22, 21, 18, "#4b5c50", 5);
    panel(x - 13, y - 43, 26, 27, shirt, 10);
    // Subtle jacket seam, collar, and arms make the characters read as people at furniture scale.
    line({ x, y: y - 34 }, { x: x + 1, y: y - 18 }, "rgba(255,255,240,.28)");
    polygon([{ x: x - 5, y: y - 42 }, { x: x + 5, y: y - 42 }, { x, y: y - 35 }], "#efe8d5");
    ellipse(x - 11, y - 23 + typing, 5, 4, skin, -0.4); ellipse(x + 12, y - 21 - typing, 5, 4, skin, 0.4);
    ellipse(x + 1, y - 51, 11, 13, skin);
    ellipse(x, y - 58, 11, 7, "#494236");
    ellipse(x - 8, y - 53, 3, 7, "#494236");
    ellipse(x - 2, y - 50, 1, 1.2, "#494236"); ellipse(x + 6, y - 49, 1, 1.2, "#494236");
    line({ x: x + 1, y: y - 44 }, { x: x + 5, y: y - 43 }, "#a16f52");
    if (statusOf(s.name) === "error") {
      ellipse(x + 18, y - 48, 8, 8, "#b43c3c"); text("!", x + 18, y - 48, 12, "#fffdf6", 800);
    }
  }
  function drawScene() {
    floorAndWalls();
    rug(0.65, 6.3, 4.5, 4.8, "#c4cdbd");
    rug(8.8, 9.15, 4.5, 2.5, "#c8d3cc");
    rug(1.1, 1.3, 3.3, 3.5, "#d9ceb8");
    const objects = [];
    const add = (depth, draw) => objects.push({ depth, draw });
    for (const s of slots) add(s.gx + s.gy + 1.2, () => workstation(s));
    for (const [x, y, scale] of [[0.8, 1.0, 1.1], [4.8, 0.7, 0.9], [13.15, 0.85, 1.2], [0.75, 6.0, 0.9], [0.9, 11, 1.1], [5.2, 10.6, 1], [13.25, 11.1, 1.1]]) add(x + y, () => plant(x, y, scale));
    add(9.4, () => {
      shadow(2.1, 7.1, 63, 25);
      box(0.95, 6.6, 2.8, 0.95, 17, "#588c7d", "#346f68", "#2e5e56", 8);
      box(0.95, 6.56, 2.8, 0.18, 29, "#639582", "#346f68", "#2e5e56", 17);
      for (let i = 0; i < 3; i++) box(1.1 + i * 0.85, 6.82, 0.78, 0.6, 5, "#6c9985", "#4c806f", "#437365", 25);
      box(0.9, 6.65, 0.18, 0.95, 12, "#789f8b", "#346f68", "#2e5e56", 24);
      box(3.62, 6.65, 0.18, 0.95, 12, "#789f8b", "#346f68", "#2e5e56", 24);
      const pillow = iso(1.52, 6.92, 38); ellipse(pillow.x, pillow.y, 12, 10, "#d4b57f", 0.35);
    });
    add(11.4, () => {
      timberTable(2.5, 8.05, 1.35, 0.95, 18, "#d8b58b");
      box(2.72, 8.2, 0.4, 0.36, 1.5, "#f3e9d4", "#b9ad95", "#b9ad95", 18);
      box(3.1, 8.4, 0.25, 0.23, 1.5, "#a5bba3", "#788b72", "#788b72", 18);
    });
    add(10.7, () => chair(1.1, 9.6));
    add(5.8, () => {
      box(0.4, 4.9, 0.95, 0.6, 31, "#c7b18a", "#557869", "#406859");
      box(0.55, 5.0, 0.36, 0.26, 19, "#57645a", "#384a40", "#2f4038", 31);
      const p = iso(0.75, 5.35, 32); ellipse(p.x, p.y, 5, 3, "#f4ead6");
    });
    add(10.1, () => {
      const p = iso(4.3, 5.8); ellipse(p.x, p.y, 12, 5, "#a99675");
      line(p, { x: p.x, y: p.y - 79 }, "#8a795a", 3);
      polygon([{ x: p.x - 11, y: p.y - 89 }, { x: p.x + 11, y: p.y - 89 }, { x: p.x + 18, y: p.y - 65 }, { x: p.x - 18, y: p.y - 65 }], "#e9d9ad");
      ellipse(p.x, p.y - 65, 18, 5, "#d4c092");
    });
    // Meeting chairs, table, and foreground chairs share the painter queue.
    add(19.0, () => chair(9.5, 9.45)); add(21.2, () => chair(11.8, 9.4));
    add(21.8, () => {
      timberTable(9.7, 9.75, 2.3, 1.15, 29, "#d8b58b");
      box(10.1, 9.98, 0.48, 0.4, 1.2, "#f1e8d2", "#c0b69f", "#c0b69f", 29);
      box(11.2, 10.2, 0.4, 0.32, 1.5, "#7a9b89", "#5f7a68", "#5f7a68", 29);
    });
    add(22.4, () => chair(10.8, 11.2));
    objects.sort((a, b) => a.depth - b.depth);
    for (const item of objects) item.draw();
    text("KOORDINASI", 562, 226, 12, "#67715d", 750);
    text("AREA TIM", 845, 249, 12, "#67715d", 750);
    text("LOUNGE", 272, 478, 12, "#67715d", 750);
    text("RUANG RAPAT", 551, 659, 12, "#67715d", 750);
  }
  function drawLabels() {
    for (const s of slots) {
      ctx.font = "700 17px system-ui, sans-serif";
      let label = s.name;
      while (ctx.measureText(label).width > 160 && label.length > 1) label = label.slice(0, -2) + "…";
      const width = Math.max(108, Math.min(184, ctx.measureText(label).width + 24));
      panel(s.x - width / 2 + 1, s.y + 9, width, 43, "rgba(60,64,44,.09)", 9);
      panel(s.x - width / 2, s.y + 6, width, 43, "#fffdf5", 9);
      text(label, s.x, s.y + 20, 17, "#263e39", 700);
      const status = STATUS[statusOf(s.name)];
      text(status.label, s.x, s.y + 39, 15, status.color, 600);
    }
  }
  function drawBoard() {
    const { x, y, w, h } = BOARD;
    panel(x + 2, y + 5, w, h, "rgba(43,57,45,.10)");
    panel(x, y, w, h, "#fffdf6");
    text("PAPAN TUGAS", x + 18, y + 23, 14, "#274f47", 750, "left");
    text("↗", x + w - 23, y + 23, 22, "#087b70");
    [["queue", "Antre", "#54645e"], ["doing", "Bekerja", "#087b70"], ["done", "Selesai", "#54645e"], ["failed", "Gagal", "#b43c3c"]].forEach(([key, label, color], i) => {
      text(`${label} · ${tasks.filter(t => t.status === key).length}`, x + 18 + (i % 2) * 130, y + 57 + Math.floor(i / 2) * 28, 15, color, 600, "left");
    });
    text(tasks.length ? "Buka papan lengkap" : "Belum ada tugas", x + 18, y + h - 20, 13, "#6a766d", 500, "left");
  }
  function drawTransfers() {
    for (const t of transfers) {
      const from = slots.find(s => s.name === t.from), to = slots.find(s => s.name === t.to);
      const a = iso(from.gx, from.gy, 48), b = iso(to.gx, to.gy, 48);
      const progress = reduceMotion ? 1 : Math.min(1, (performance.now() - t.started) / 1200);
      const x = a.x + (b.x - a.x) * progress, y = a.y + (b.y - a.y) * progress - (reduceMotion ? 0 : Math.sin(progress * Math.PI) * 42);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.setLineDash([4, 6]); ctx.strokeStyle = "rgba(151,119,57,.35)"; ctx.stroke(); ctx.setLineDash([]);
      polygon([{ x: x - 11, y: y - 7 }, { x: x + 11, y: y - 7 }, { x: x + 11, y: y + 7 }, { x: x - 11, y: y + 7 }], "#fff9e9", "#b58a47");
      ctx.beginPath(); ctx.moveTo(x - 11, y - 7); ctx.lineTo(x, y + 1); ctx.lineTo(x + 11, y - 7); ctx.stroke();
    }
  }
  function drawBubble(s) {
    const bubble = bubbles.get(s.name);
    if (!bubble) return;
    const value = clipped(bubble.text, 56), lines = [];
    if (value.length <= 29) lines.push(value);
    else {
      let cut = value.lastIndexOf(" ", 28); if (cut < 12) cut = 28;
      lines.push(value.slice(0, cut).trim(), value.slice(cut).trim());
    }
    const x = Math.max(12, Math.min(W - 250, s.x - 118)), y = Math.max(20, s.y - 117);
    panel(x + 1, y + 3, 236, lines.length * 19 + 16, "rgba(38,62,57,.12)");
    panel(x, y, 236, lines.length * 19 + 16, "#fffef9");
    lines.forEach((line, i) => text(clipped(line, 29), x + 12, y + 17 + i * 19, 14, "#263e39", 500, "left"));
  }
  function render() {
    if (!ctx) return;
    prune();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#f5f1e9";
    ctx.fillRect(0, 0, W, H);
    drawScene();
    drawLabels();
    drawTransfers();
    for (const s of slots) drawBubble(s);
    drawBoard();
    if (!agents.length) text("Belum ada agen aktif · Tambahkan melalui Tim agen", W / 2, 720, 18);
  }
  function init(o) {
    options = o || {};
    canvas = document.getElementById("office-canvas");
    ctx = canvas && canvas.getContext("2d");
    if (!bound) {
      document.addEventListener("visibilitychange", invalidate);
      const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
      reduceMotion = Boolean(media && media.matches);
      const onChange = event => { reduceMotion = event.matches; invalidate(); };
      if (media?.addEventListener) media.addEventListener("change", onChange);
      else if (media?.addListener) media.addListener(onChange);
      bound = true;
    }
    if (canvas) {
      canvas.width = W; canvas.height = H;
      if (!canvas.__officeBound) {
        canvas.addEventListener("click", event => {
          const hit = pointer(event);
          if (hit?.board) { if (options.onBoardClick) options.onBoardClick(); }
          else if (hit && options.onAgentClick) options.onAgentClick(hit.name);
        });
        canvas.addEventListener("mousemove", event => { canvas.style.cursor = pointer(event) ? "pointer" : "default"; });
        if (typeof window.IntersectionObserver === "function") {
          const observer = new window.IntersectionObserver(entries => {
            for (const entry of entries) if (entry.target === canvas) { intersecting = entry.isIntersecting; invalidate(); }
          });
          observer.observe(canvas);
        }
        canvas.__officeBound = true;
      }
    }
    render(); syncLoop();
  }
  function setAgents(list) {
    const names = new Set();
    agents = (Array.isArray(list) ? list : []).filter(a => {
      if (!a || typeof a.name !== "string" || !a.name || a.is_active === false || a.is_active === 0 || names.has(a.name)) return false;
      names.add(a.name); return true;
    }).map(a => ({ ...a }));
    agents.sort((a, b) => Number(Boolean(b.is_orchestrator)) - Number(Boolean(a.is_orchestrator)));
    for (const name of statuses.keys()) if (!names.has(name)) statuses.delete(name);
    for (const name of bubbles.keys()) if (!names.has(name)) bubbles.delete(name);
    for (const a of agents) if (a.status !== undefined) statuses.set(a.name, { status: normalizeStatus(a.status), task_id: a.task_id ?? null });
    layout(); invalidate();
  }
  function setTasks(list) { tasks = Array.isArray(list) ? list.slice() : []; invalidate(); }
  function setStatuses(object) {
    statuses = new Map(Object.entries(object || {}).map(([name, value]) => [name, { status: normalizeStatus(value?.status), task_id: value?.task_id ?? null }]));
    for (const [name, bubble] of bubbles) if (bubble.stream && statusOf(name) !== "working") bubbles.delete(name);
    invalidate();
  }
  function handleEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "agent_status" && agents.some(a => a.name === event.agent)) {
      statuses.set(event.agent, { status: normalizeStatus(event.status), task_id: event.task_id ?? null });
      if (event.status === "working" || bubbles.get(event.agent)?.stream) bubbles.delete(event.agent);
      invalidate();
    } else if (event.type === "delegation") {
      if (event.from !== event.to && slots.some(s => s.name === event.from) && slots.some(s => s.name === event.to)) {
        const now = performance.now();
        transfers.push({ from: event.from, to: event.to, task_id: event.task_id, started: now, until: now + (reduceMotion ? 1800 : 1200) });
        transfers = transfers.slice(-12); invalidate();
      }
    } else if (event.type === "delta" && agents.some(a => a.name === event.agent)) {
      const previous = bubbles.get(event.agent);
      const text = ((previous?.stream ? previous.text : "") + String(event.text || "")).replace(/\s+/g, " ").slice(-140);
      if (text.trim()) bubbles.set(event.agent, { text, stream: true, until: performance.now() + 2600 });
      invalidate();
    } else if (event.type === "message") {
      const m = event.message || {};
      if (m.sender_type === "agent" && agents.some(a => a.name === m.sender_name) && String(m.content || "").trim()) {
        bubbles.set(m.sender_name, { text: clipped(m.content, 110), stream: false, until: performance.now() + 4200 });
        invalidate();
      }
    } else if (event.type === "snapshot") {
      const state = event.state || event;
      bubbles.clear(); transfers = [];
      setAgents(state.agents); setTasks(state.tasks); setStatuses(state.agent_statuses);
    }
  }
  function setVisible(value) { visible = Boolean(value); invalidate(); }
  function setPage(value) { page = Math.max(1, Math.min(pages(), Math.floor(Number(value)) || 1)); layout(); invalidate(); }
  function pageInfo() { return { page, pages: pages() }; }
  function inspect() { return { visible, rafActive: raf !== null, slots: slots.map(s => ({ name: s.name, x: s.x, y: s.y })), ...pageInfo() }; }
  return { init, setAgents, setTasks, setStatuses, handleEvent, setVisible, onShow: () => setVisible(true), setPage, pageInfo, inspect };
})();