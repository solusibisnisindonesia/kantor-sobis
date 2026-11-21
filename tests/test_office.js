"use strict";
// No browser, dependencies, network, or production data: run `node --test tests/test_office.js`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../static/office.js"), "utf8");

function harness({ missingCanvas = false, missingContext = false, reduced = false, observe = false } = {}) {
  let now = 1000, sequence = 0;
  const frames = new Map(), timers = new Map(), listeners = {}, canvasListeners = {}, mediaListeners = {};
  const operations = [];
  let points = [];
  const context = {
    font: "12px sans-serif", fillStyle: "#000", strokeStyle: "#000", lineWidth: 1,
    beginPath() { points = []; },
    moveTo(x, y) { points.push([x, y]); }, lineTo(x, y) { points.push([x, y]); },
    closePath() {}, arc() {}, ellipse(x, y, rx, ry) { points.push([x - rx, y - ry], [x + rx, y + ry]); }, arcTo() {}, quadraticCurveTo() {},
    fill() { operations.push({ type: "fill", points: points.slice(), color: this.fillStyle }); },
    stroke() { operations.push({ type: "stroke", points: points.slice(), color: this.strokeStyle }); },
    fillRect(x, y, w, h) { operations.push({ type: "rect", x, y, w, h, color: this.fillStyle }); },
    strokeRect() {}, clearRect() { operations.length = 0; },
    fillText(text, x, y) { operations.push({ type: "text", text: String(text), x, y, color: this.fillStyle, font: this.font }); },
    measureText(text) { return { width: String(text).length * (parseFloat(this.font.match(/([\d.]+)px/)?.[1]) || 12) * 0.53 }; },
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, setTransform() {}, setLineDash() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; }
  };
  const canvas = {
    width: 960, height: 640, style: {},
    getContext() { return missingContext ? null : context; },
    getBoundingClientRect() { return { left: 20, top: 30, width: 600, height: 390 }; },
    addEventListener(name, fn) { (canvasListeners[name] ||= []).push(fn); }
  };
  const document = {
    hidden: false, getElementById() { return missingCanvas ? null : canvas; },
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); }
  };
  const media = { matches: reduced, addEventListener(name, fn) { mediaListeners[name] = fn; } };
  const window = { document, matchMedia() { return media; } };
  const sandbox = { window, document, console, performance: { now: () => now },
    requestAnimationFrame(fn) { const id = ++sequence; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  let intersectionCallback = null;
  if (observe) sandbox.IntersectionObserver = class {
    constructor(callback) { intersectionCallback = callback; }
    observe() {} disconnect() {}
  };
  Object.assign(window, sandbox);
  vm.runInNewContext(source, sandbox, { filename: "office.js" });
  const office = window.Office;
  return { office, canvas, frames, timers, operations, context,
    plain(value) { return JSON.parse(JSON.stringify(value)); },
    texts() { return operations.filter(o => o.type === "text"); },
    click(x, y) { for (const fn of canvasListeners.click || []) fn({ clientX: 20 + x / 2, clientY: 30 + y / 2 }); },
    move(x, y) { for (const fn of canvasListeners.mousemove || []) fn({ clientX: 20 + x / 2, clientY: 30 + y / 2 }); },
    hidden(value) { document.hidden = value; for (const fn of listeners.visibilitychange || []) fn(); },
    reduce(value) { media.matches = value; mediaListeners.change?.({ matches: value }); },
    intersect(value) { intersectionCallback?.([{ target: canvas, isIntersecting: value }]); },
    advance(ms = 16) {
      now += ms;
      const due = [...timers].filter(([, timer]) => timer.at <= now);
      for (const [id, timer] of due) { timers.delete(id); timer.fn(); }
      const pending = [...frames]; frames.clear(); for (const [, fn] of pending) fn(now);
    }
  };
}
const agent = (name, extra = {}) => ({ name, is_active: true, is_orchestrator: false, ...extra });

test("roster paginates unique clickable desks, using the actual coordinator", () => {
  const h = harness(), clicks = [];
  h.office.init({ onAgentClick: name => clicks.push(name) });
  const roster = Array.from({ length: 21 }, (_, i) => agent(`Tim_${i}`));
  roster[13].is_orchestrator = true;
  roster.push(agent("Nonaktif", { is_active: false }), agent("Tim_0"));
  h.office.setAgents(roster); h.office.onShow();
  assert.deepEqual(h.plain(h.office.pageInfo()), { page: 1, pages: 3 });
  const visited = [];
  for (let page = 1; page <= 3; page++) {
    h.office.setPage(page);
    const slots = h.office.inspect().slots;
    assert.equal(slots.length, page === 3 ? 5 : 8);
    assert.equal(new Set(slots.map(s => `${s.x}:${s.y}`)).size, slots.length);
    for (const s of slots) {
      assert.ok(s.x > 70 && s.x < 1130 && s.y > 120 && s.y < 690);
      h.click(s.x, s.y - 24);
      assert.equal(clicks.at(-1), s.name);
      h.move(s.x, s.y - 24); assert.equal(h.canvas.style.cursor, "pointer");
      visited.push(s.name);
    }
    if (page === 1) assert.equal(slots[0].name, "Tim_13");
  }
  assert.equal(new Set(visited).size, 21);
  assert.ok(!h.texts().some(t => t.text === "Sobis"), "no imaginary coordinator");
  h.office.setPage(999); assert.equal(h.office.pageInfo().page, 3);
  h.office.setPage(-99); assert.equal(h.office.pageInfo().page, 1);
  h.office.setPage(NaN); assert.equal(h.office.pageInfo().page, 1);
  h.move(1, 1); assert.equal(h.canvas.style.cursor, "default");
  h.office.setPage(3); h.office.setAgents([agent("Pengganti", { is_orchestrator: true })]);
  assert.deepEqual(h.plain(h.office.pageInfo()), { page: 1, pages: 1 });
  assert.deepEqual(h.office.inspect().slots.map(s => s.name).join(), "Pengganti");
  h.office.setAgents([]);
  assert.equal(h.office.inspect().slots.length, 0);
  assert.ok(h.texts().some(t => /Belum ada agen aktif/.test(t.text)));
});

test("real status drives labels and RAF; hidden, idle and reduced-motion never loop", () => {
  const h = harness();
  h.office.init({});
  h.office.setAgents([agent("Ketua", { is_orchestrator: true }), agent("Riset")]);
  h.office.onShow();
  assert.equal(h.frames.size, 0, "idle office is a single static drawing");
  h.office.setStatuses({ Riset: { status: "working", task_id: 11 } });
  assert.equal(h.frames.size, 1);
  assert.equal(h.office.inspect().rafActive, true);
  assert.ok(h.texts().some(t => t.text === "Bekerja"));
  h.office.setVisible(true); h.office.init({});
  assert.equal(h.frames.size, 1, "no double animation loop");
  h.advance(); assert.equal(h.frames.size, 1);
  h.office.setVisible(false); assert.equal(h.frames.size, 0);
  h.office.setStatuses({ Riset: { status: "working" } }); assert.equal(h.frames.size, 0);
  h.office.onShow(); assert.equal(h.frames.size, 1);
  h.hidden(true); assert.equal(h.frames.size, 0);
  h.hidden(false); assert.equal(h.frames.size, 1, "visible office resumes real work");
  h.office.setVisible(false); h.hidden(true); h.hidden(false); assert.equal(h.frames.size, 0);
  h.office.onShow(); h.reduce(true); assert.equal(h.frames.size, 0);
  assert.ok(h.texts().some(t => t.text === "Bekerja"), "reduced motion still shows accurate static work");
  h.reduce(false); assert.equal(h.frames.size, 1);
  h.office.handleEvent({ type: "agent_status", agent: "Riset", status: "error", task_id: 11 });
  assert.equal(h.frames.size, 0);
  assert.ok(h.texts().some(t => t.text === "Gagal" && t.color === "#b43c3c"));
  h.office.handleEvent({ type: "agent_status", agent: "Ketua", status: "working" });
  assert.equal(h.frames.size, 1);
  h.office.setStatuses({}); assert.equal(h.frames.size, 0, "snapshot clears stale busy state");
  h.office.setAgents([agent("Baru", { status: "working" })]); assert.equal(h.frames.size, 1);
  h.office.setAgents([agent("Pengganti", { status: "idle" })]); assert.equal(h.frames.size, 0);
  h.office.handleEvent({ type: "agent_status", agent: "Hilang", status: "working" });
  assert.equal(h.frames.size, 0);
  h.office.handleEvent({ type: "snapshot", state: { agents: [agent("Snapshot", { status: "working" })], agent_statuses: { Snapshot: { status: "error" } }, tasks: [] } });
  assert.equal(h.office.inspect().slots[0].name, "Snapshot");
  assert.ok(h.texts().some(t => t.text === "Gagal"));
  const reduced = harness({ reduced: true });
  reduced.office.init({}); reduced.office.setAgents([agent("R", { status: "working" })]); reduced.office.onShow();
  assert.equal(reduced.frames.size, 0);
});

test("mini board displays only supplied task totals and opens the full board", () => {
  const h = harness(); let opened = 0;
  h.office.init({ onBoardClick: () => opened++ }); h.office.onShow();
  h.office.setTasks([{ status: "queue" }, { status: "queue" }, { status: "doing" }, { status: "failed" }]);
  for (const label of ["Antre · 2", "Bekerja · 1", "Selesai · 0", "Gagal · 1"]) {
    assert.ok(h.texts().some(t => t.text === label), label);
  }
  const title = h.texts().find(t => t.text === "PAPAN TUGAS");
  assert.ok(title); h.click(title.x, title.y); assert.equal(opened, 1);
  h.move(title.x, title.y); assert.equal(h.canvas.style.cursor, "pointer");
  h.office.setTasks([]); assert.ok(h.texts().some(t => t.text === "Belum ada tugas"));
  assert.equal(h.frames.size, 0);
});

test("delegation travels between the actual named desks, never inferred from chat", () => {
  const h = harness(); h.office.init({});
  h.office.setAgents([agent("Pemimpin", { is_orchestrator: true }), agent("Riset"), agent("Penulis")]); h.office.onShow();
  const envelope = () => h.operations.find(o => o.type === "fill" && o.color === "#fff9e9");
  const center = shape => ({ x: shape.points.reduce((sum, p) => sum + p[0], 0) / 4, y: shape.points.reduce((sum, p) => sum + p[1], 0) / 4 });
  const slots = h.office.inspect().slots;
  h.office.handleEvent({ type: "delegation", from: "Riset", to: "Penulis", task_id: 25 });
  assert.equal(h.frames.size, 1); assert.ok(envelope());
  const from = slots.find(s => s.name === "Riset"), to = slots.find(s => s.name === "Penulis");
  assert.ok(Math.abs(center(envelope()).x - (from.x + 35.15)) < 1);
  h.advance(1199);
  assert.ok(Math.abs(center(envelope()).x - (to.x + 35.15)) < 2);
  h.advance(100); assert.equal(h.frames.size, 0); assert.ok(!envelope());
  h.office.handleEvent({ type: "message", message: { sender_type: "system", content: "📋 @Riset @Penulis" } });
  assert.equal(h.frames.size, 0); assert.ok(!envelope());
  h.office.handleEvent({ type: "delegation", from: "Missing", to: "Penulis", task_id: 99 }); assert.equal(h.frames.size, 0);
  h.reduce(true);
  h.office.handleEvent({ type: "delegation", from: "Penulis", to: "Riset", task_id: 26 });
  assert.equal(h.frames.size, 0); assert.ok(envelope(), "static event acknowledgement in reduced motion");
  h.advance(2000); assert.ok(!envelope()); assert.equal(h.timers.size, 0);
});

test("live speech is bounded, expires without idle RAF, and terminal statuses clear stream text", () => {
  const h = harness(); h.office.init({}); h.office.setAgents([agent("Riset")]); h.office.onShow();
  h.office.handleEvent({ type: "delta", agent: "Riset", text: "UnikBicara".repeat(80) });
  const lines = h.texts().filter(t => t.text.includes("UnikBicara"));
  assert.ok(lines.length > 0 && lines.length <= 2);
  assert.ok(lines.every(t => t.text.length <= 30), "single long token must be clipped too");
  assert.equal(h.frames.size, 0, "delta does not invent working status");
  assert.equal(h.timers.size, 1, "one finite expiration timeout, not a decorative animation loop");
  h.office.handleEvent({ type: "agent_status", agent: "Riset", status: "idle" });
  assert.ok(!h.texts().some(t => t.text.includes("UnikBicara")));
  h.office.handleEvent({ type: "message", message: { sender_type: "agent", sender_name: "Riset", content: "Hasil sudah siap" } });
  assert.ok(h.texts().some(t => t.text.includes("Hasil sudah siap")));
  h.hidden(true); assert.equal(h.timers.size, 0); assert.equal(h.frames.size, 0);
  h.advance(5000); h.hidden(false);
  assert.ok(!h.texts().some(t => t.text.includes("Hasil sudah siap")));
  assert.equal(h.timers.size, 0);
});

test("office draws true projected timber desk boxes back-to-front, with readable avatar labels", () => {
  const h = harness(); h.office.init({});
  const roster = Array.from({ length: 8 }, (_, i) => agent(i === 0 ? "KoordinatorBaru" : `Spesialis_${i}`, { is_orchestrator: i === 0 }));
  h.office.setAgents(roster); h.office.onShow();
  const tops = h.operations.filter(o => o.type === "fill" && o.color === "#cda373");
  assert.equal(tops.length, 8, "one solid timber desktop per agent");
  let previousDepth = -Infinity;
  for (const top of tops) {
    assert.equal(top.points.length, 4);
    const [a, b, c, d] = top.points;
    const slope = (p, q) => (q[1] - p[1]) / (q[0] - p[0]);
    assert.ok(Math.abs(slope(a, b) - 0.5) < 1e-8, "x-axis isometrically projected");
    assert.ok(Math.abs(slope(b, c) + 0.5) < 1e-8, "y-axis isometrically projected");
    assert.ok(Math.abs(a[0] + c[0] - b[0] - d[0]) < 1e-8, "top is a genuine parallelogram, not a bounding diamond");
    const depth = top.points.reduce((sum, p) => sum + p[1], 0) / 4;
    assert.ok(depth >= previousDepth, "painter depth order is back to front"); previousDepth = depth;
    const index = h.operations.indexOf(top);
    const sides = h.operations.slice(index - 2, index);
    assert.ok(sides.every(s => s.type === "fill" && s.points.length === 4));
    for (const side of sides) {
      assert.ok(side.points.some(p => top.points.some(t => Math.hypot(t[0] - p[0], t[1] - p[1]) < 1e-8)), "box sides meet actual desktop corners");
    }
  }
  for (const a of roster) {
    const label = h.texts().find(t => t.text === a.name);
    assert.ok(label, a.name); assert.ok(Number(label.font.match(/([\d.]+)px/)[1]) >= 17);
    const slot = h.office.inspect().slots.find(s => s.name === a.name);
    assert.ok(Math.hypot(label.x - slot.x, label.y - slot.y) < 44, "name is adjacent to avatar, not a distant desk");
  }
  for (const zone of ["KOORDINASI", "AREA TIM", "LOUNGE", "RUANG RAPAT"]) assert.ok(h.texts().some(t => t.text === zone), zone);
  assert.ok(h.operations.some(o => o.color === "#346f68"), "teal upholstered furniture");
  assert.ok(h.operations.some(o => o.color === "#4f7956"), "plants");
  assert.equal(h.frames.size, 0, "no decorative idle animation");
  const idle = JSON.stringify(h.operations); h.advance(1000); assert.equal(JSON.stringify(h.operations), idle);
  h.office.handleEvent({ type: "agent_status", agent: "Spesialis_1", status: "working" });
  const active = JSON.stringify(h.operations); h.advance(150); assert.notEqual(JSON.stringify(h.operations), active, "real work animates the avatar / display");
});

test("an office scrolled offscreen suspends work until it actually intersects again", () => {
  const h = harness({ observe: true });
  h.office.init({}); h.office.setAgents([agent("Riset", { status: "working" })]); h.office.onShow();
  assert.equal(h.frames.size, 1);
  h.intersect(false); assert.equal(h.frames.size, 0);
  h.office.handleEvent({ type: "delta", agent: "Riset", text: "Teks" });
  assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);
  h.intersect(true); assert.equal(h.frames.size, 1);
  h.office.setVisible(false); h.intersect(false); h.intersect(true); assert.equal(h.frames.size, 0);
});

test("safe public interface initializes at the 1200 × 780 canvas contract", () => {
  const h = harness();
  h.office.init({});
  for (const key of ["init", "setAgents", "setTasks", "setStatuses", "handleEvent", "setVisible", "onShow", "setPage", "pageInfo", "inspect"]) {
    assert.equal(typeof h.office[key], "function", key);
  }
  assert.equal(h.canvas.width, 1200);
  assert.equal(h.canvas.height, 780);
  assert.deepEqual(h.plain(h.office.inspect()), { visible: false, rafActive: false, slots: [], page: 1, pages: 1 });
  assert.equal(h.frames.size, 0, "hidden office does not start RAF");
  for (const options of [{ missingCanvas: true }, { missingContext: true }]) {
    const absent = harness(options);
    assert.doesNotThrow(() => {
      absent.office.init({}); absent.office.setAgents([agent("Riset")]);
      absent.office.setStatuses({ Riset: { status: "working", task_id: 1 } });
      absent.office.onShow(); absent.office.handleEvent({ type: "delta", agent: "Riset", text: "hello" });
      absent.office.setVisible(false);
    });
    assert.equal(absent.frames.size, 0);
  }
});
