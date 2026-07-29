/* 足球战术板 · 8人制 (8-a-side)
 * 单文件逻辑:球场渲染、棋子拖动、阵型预设、跑位箭头、关键帧战术模拟。
 */
(function () {
  "use strict";

  // ---- 球场尺寸 (SVG 坐标) ----
  const W = 680;
  const H = 1050;
  const SVG_NS = "http://www.w3.org/2000/svg";

  // 8人制常见阵型 (不含守门员,行数从后卫到前锋,和为 7)
  const FORMATIONS = {
    "3-2-2": [3, 2, 2],
    "2-3-2": [2, 3, 2],
    "3-3-1": [3, 3, 1],
    "2-4-1": [2, 4, 1],
    "3-1-3": [3, 1, 3],
    "2-2-3": [2, 2, 3],
  };
  const DEFAULT_HOME = "3-2-2";
  const DEFAULT_AWAY = "2-3-2";

  const pitch = document.getElementById("pitch");
  let layers = {}; // grid/pieces/arrows groups

  // 状态
  const state = {
    mode: "move",
    pieces: [], // {id, team, num, x, y, el, circle}
    ball: null, // {x, y, el}
    ballOwner: null,     // ボールを保持している選手のid (null=フリー)
    arrows: [],          // 箭头对象数组 {el, path, end}
    selectedArrow: null, // 当前选中的箭头
    arrowDelBtn: null,   // 删除按钮 (SVG group)
    frames: [], // 关键帧: [{positions:{id:{x,y}}, ball:{x,y}}]
    playing: false,
    playPos: 0,          // 现在的播放位置 (0..frames.length-1 的浮点)
    playStartPos: 0,     // 本次播放起点
    playStartTime: 0,    // 本次播放起始时间
    rafId: 0,
    loop: false,
    showTrails: false,
    fpv: { active: false, playerId: null, yaw: 0, pitch: -6 }, // 一人称视点
  };

  // ---------- 工具 ----------
  function el(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // 把客户端坐标转换为 SVG 坐标
  function toSvg(clientX, clientY) {
    const ctm = pitch.getScreenCTM();
    const inv = ctm.inverse();
    const p = pitch.createSVGPoint();
    p.x = clientX; p.y = clientY;
    const r = p.matrixTransform(inv);
    return { x: r.x, y: r.y };
  }

  // ---------- 球场绘制 ----------
  function drawPitch() {
    const g = el("g", {});
    const pad = 30; // 边线到画布边缘
    const x0 = pad, y0 = pad, x1 = W - pad, y1 = H - pad;
    const midY = H / 2;

    // 草坪 + 条纹
    g.appendChild(el("rect", { x: 0, y: 0, width: W, height: H, fill: "#2f8f46" }));
    const stripes = 10;
    const sh = H / stripes;
    for (let i = 0; i < stripes; i++) {
      if (i % 2 === 0)
        g.appendChild(el("rect", { x: 0, y: i * sh, width: W, height: sh, fill: "#2a8340" }));
    }

    const lineAttr = { stroke: "rgba(255,255,255,.85)", "stroke-width": 3, fill: "none" };

    // 外框
    g.appendChild(el("rect", Object.assign({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, lineAttr)));
    // 中线
    g.appendChild(el("line", Object.assign({ x1: x0, y1: midY, x2: x1, y2: midY }, lineAttr)));
    // 中圈
    g.appendChild(el("circle", Object.assign({ cx: W / 2, cy: midY, r: 82 }, lineAttr)));
    g.appendChild(el("circle", { cx: W / 2, cy: midY, r: 6, fill: "rgba(255,255,255,.85)" }));

    // 禁区 / 球门区 (上下各一)
    const boxW = 360, boxH = 120;     // 大禁区
    const gaW = 200, gaH = 55;        // 小禁区
    const goalW = 120, goalH = 14;    // 球门
    const bx = (W - boxW) / 2, gax = (W - gaW) / 2, gx = (W - goalW) / 2;

    // 上方 (对方)
    g.appendChild(el("rect", Object.assign({ x: bx, y: y0, width: boxW, height: boxH }, lineAttr)));
    g.appendChild(el("rect", Object.assign({ x: gax, y: y0, width: gaW, height: gaH }, lineAttr)));
    g.appendChild(el("rect", Object.assign({ x: gx, y: y0 - goalH, width: goalW, height: goalH }, lineAttr, { fill: "rgba(255,255,255,.25)" })));
    g.appendChild(penArc(W / 2, y0 + boxH, false, lineAttr));
    g.appendChild(el("circle", { cx: W / 2, cy: y0 + boxH - 42, r: 5, fill: "rgba(255,255,255,.85)" }));

    // 下方 (我方)
    g.appendChild(el("rect", Object.assign({ x: bx, y: y1 - boxH, width: boxW, height: boxH }, lineAttr)));
    g.appendChild(el("rect", Object.assign({ x: gax, y: y1 - gaH, width: gaW, height: gaH }, lineAttr)));
    g.appendChild(el("rect", Object.assign({ x: gx, y: y1, width: goalW, height: goalH }, lineAttr, { fill: "rgba(255,255,255,.25)" })));
    g.appendChild(penArc(W / 2, y1 - boxH, true, lineAttr));
    g.appendChild(el("circle", { cx: W / 2, cy: y1 - boxH + 42, r: 5, fill: "rgba(255,255,255,.85)" }));

    // 角球弧
    const cr = 16;
    [[x0, y0, 0, 90], [x1, y0, 90, 180], [x1, y1, 180, 270], [x0, y1, 270, 360]].forEach(function (c) {
      g.appendChild(cornerArc(c[0], c[1], cr, c[2]));
    });

    pitch.appendChild(g);
  }

  function penArc(cx, cy, isBottom, lineAttr) {
    const r = 70;
    const dir = isBottom ? -1 : 1;
    // 半圆朝向场地中央
    const sx = cx - 58, ex = cx + 58;
    const sy = cy, ey = cy;
    const sweep = isBottom ? 1 : 0;
    const d = `M ${sx} ${sy} A ${r} ${r} 0 0 ${sweep} ${ex} ${ey}`;
    return el("path", Object.assign({ d: d }, lineAttr));
  }

  function cornerArc(cx, cy, r, startDeg) {
    const a0 = (startDeg) * Math.PI / 180;
    const a1 = (startDeg + 90) * Math.PI / 180;
    const p0 = { x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) };
    const p1 = { x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) };
    const d = `M ${p0.x} ${p0.y} A ${r} ${r} 0 0 1 ${p1.x} ${p1.y}`;
    return el("path", { d: d, stroke: "rgba(255,255,255,.85)", "stroke-width": 3, fill: "none" });
  }

  // ---------- 阵型定位 ----------
  // 返回 7 名外场球员 + 守门员的位置 (SVG 坐标)
  function formationPositions(rows, isHome) {
    const pad = 60;
    const usableW = W - pad * 2;
    const positions = [];

    // 守门员
    const gkY = isHome ? H - 70 : 70;
    positions.push({ x: W / 2, y: gkY, gk: true });

    // 外场行:我方占下半场 (y 大)。t=0=最终线(PK区线附近), t=1=前锋(中线附近)
    // PK区线: home = H-150 (=900), away = 150 (与 drawPitch 的大禁区一致)
    const BOX_LINE = 150; // pad(30)+boxH(120)
    const nRows = rows.length;
    rows.forEach(function (count, i) {
      const t = nRows === 1 ? 0.5 : i / (nRows - 1); // 0..1
      let y;
      if (isHome) {
        y = (H - BOX_LINE) - t * ((H - BOX_LINE) - H * 0.54); // 900 -> 567
      } else {
        y = BOX_LINE + t * (H * 0.46 - BOX_LINE); // 150 -> 483
      }
      for (let j = 0; j < count; j++) {
        const fx = count === 1 ? 0.5 : (j + 0.5) / count;
        const x = pad + fx * usableW;
        positions.push({ x: x, y: y, gk: false });
      }
    });
    return positions;
  }

  // ---------- 棋子 ----------
  function makePiece(team, num, x, y) {
    const g = el("g", { class: "piece", "data-id": team + num });
    const color = team === "home" ? "#e5484d" : "#2f7de1";
    const dark = team === "home" ? "#8f1f23" : "#153f77";

    const halo = el("circle", { class: "halo", cx: 0, cy: 0, r: 30, fill: "none", stroke: color, "stroke-width": 3, opacity: 0 });
    const shadow = el("ellipse", { cx: 0, cy: 4, rx: 22, ry: 22, fill: "rgba(0,0,0,.28)" });
    const circle = el("circle", { cx: 0, cy: 0, r: 22, fill: color, stroke: dark, "stroke-width": 3 });
    const label = el("text", { class: "piece-num", x: 0, y: 7, "text-anchor": "middle", fill: "#fff" });
    label.textContent = num;

    g.appendChild(halo);
    g.appendChild(shadow);
    g.appendChild(circle);
    g.appendChild(label);

    const piece = { id: team + num, team: team, num: num, x: x, y: y, el: g };
    setPiecePos(piece, x, y);
    attachDrag(g, piece);
    layers.pieces.appendChild(g);
    return piece;
  }

  function setPiecePos(piece, x, y) {
    piece.x = clamp(x, 24, W - 24);
    piece.y = clamp(y, 24, H - 24);
    piece.el.setAttribute("transform", `translate(${piece.x},${piece.y})`);
  }

  function makeBall(x, y) {
    const g = el("g", { class: "piece ball", "data-id": "ball" });
    g.appendChild(el("circle", { cx: 0, cy: 4, r: 13, fill: "rgba(0,0,0,.28)" }));
    g.appendChild(el("circle", { cx: 0, cy: 0, r: 13, fill: "#f4f4f4", stroke: "#333", "stroke-width": 2 }));
    // 简单黑白块
    g.appendChild(el("polygon", { points: "0,-6 5,-2 3,4 -3,4 -5,-2", fill: "#222" }));
    const ball = { id: "ball", x: x, y: y, el: g };
    ball.el.setAttribute("transform", `translate(${x},${y})`);
    attachDrag(g, ball);
    layers.pieces.appendChild(g);
    return ball;
  }

  function setBallPos(ball, x, y) {
    ball.x = clamp(x, 16, W - 16);
    ball.y = clamp(y, 16, H - 16);
    ball.el.setAttribute("transform", `translate(${ball.x},${ball.y})`);
  }

  // ---------- ボール保持 (選手にくっつく) ----------
  const ATTACH_R = 34;                    // この距離内の選手に付く
  const ATTACH_OFFSET = { x: 0, y: 24 };  // 足元に置くオフセット
  function ballOwnerPiece() {
    return state.ballOwner ? state.pieces.find(function (p) { return p.id === state.ballOwner; }) : null;
  }
  function moveBallToOwner() {
    const o = ballOwnerPiece();
    if (o && state.ball) setBallPos(state.ball, o.x + ATTACH_OFFSET.x, o.y + ATTACH_OFFSET.y);
  }
  function attachBallTo(piece) {
    detachBall();
    state.ballOwner = piece.id;
    piece.el.classList.add("has-ball");
    moveBallToOwner();
  }
  function detachBall() {
    const o = ballOwnerPiece();
    if (o) o.el.classList.remove("has-ball");
    state.ballOwner = null;
  }
  function nearestPieceTo(x, y, maxD) {
    let best = null, bestD = maxD;
    state.pieces.forEach(function (p) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; best = p; }
    });
    return best;
  }

  // ---------- 拖动 ----------
  function attachDrag(node, obj) {
    let dragging = false;
    let offset = { x: 0, y: 0 };
    let startPt = { x: 0, y: 0 };
    let moved = false;
    let wasAttached = false;
    const isBall = obj.id === "ball";

    function down(e) {
      if (state.mode !== "move" || state.playing) return;
      e.preventDefault();
      dragging = true;
      moved = false;
      node.classList.add("dragging");
      layers.pieces.appendChild(node); // 提到最上层
      const pt = toSvg(clientX(e), clientY(e));
      startPt.x = pt.x; startPt.y = pt.y;
      if (isBall) {
        wasAttached = !!state.ballOwner;
        if (wasAttached) detachBall(); // 触ったら一旦保持解除
      }
      offset.x = pt.x - obj.x;
      offset.y = pt.y - obj.y;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    }
    function move(e) {
      if (!dragging) return;
      const pt = toSvg(clientX(e), clientY(e));
      if (Math.hypot(pt.x - startPt.x, pt.y - startPt.y) > 5) moved = true;
      const nx = pt.x - offset.x, ny = pt.y - offset.y;
      if (isBall) {
        setBallPos(obj, nx, ny);
      } else {
        setPiecePos(obj, nx, ny);
        if (state.ballOwner === obj.id) moveBallToOwner(); // 保持中はボールも追従
      }
    }
    function up() {
      dragging = false;
      node.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (isBall) {
        if (!moved && wasAttached) {
          // タップ = 保持解除 (その場に残す)
        } else {
          // ドラッグ後: 近くに選手がいれば保持させる
          const p = nearestPieceTo(obj.x, obj.y, ATTACH_R);
          if (p) attachBallTo(p);
        }
      }
    }
    node.addEventListener("pointerdown", down);
  }
  function clientX(e) { return e.touches ? e.touches[0].clientX : e.clientX; }
  function clientY(e) { return e.touches ? e.touches[0].clientY : e.clientY; }

  // ---------- 箭头绘制 ----------
  let drawStart = null, drawPreview = null;
  function initArrowDrawing() {
    // 画线模式:在空白处按下开始画箭头
    pitch.addEventListener("pointerdown", function (e) {
      if (state.mode !== "draw" || state.playing) return;
      hideArrowDelete();
      const start = toSvg(clientX(e), clientY(e));
      drawStart = start;
      drawPreview = el("path", { class: "arrow-path", "marker-end": "url(#arrowhead)", opacity: .7 });
      layers.arrows.appendChild(drawPreview);
      window.addEventListener("pointermove", drawMove);
      window.addEventListener("pointerup", drawUp);
    });
    // 点击空白处收起删除按钮
    pitch.addEventListener("pointerdown", function (e) {
      if (e.target.closest && (e.target.closest(".arrow") || e.target.closest(".arrow-del"))) return;
      hideArrowDelete();
    });
  }
  function drawMove(e) {
    if (!drawStart) return;
    const p = toSvg(clientX(e), clientY(e));
    drawPreview.setAttribute("d", curve(drawStart, p));
  }
  function drawUp(e) {
    if (!drawStart) return;
    const p = toSvg(clientX(e), clientY(e));
    const dist = Math.hypot(p.x - drawStart.x, p.y - drawStart.y);
    drawPreview.remove();
    if (dist >= 20) createArrow(drawStart, p);
    drawStart = null; drawPreview = null;
    window.removeEventListener("pointermove", drawMove);
    window.removeEventListener("pointerup", drawUp);
  }
  function curve(a, b) {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    return `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
  }

  // 生成一个可点击的箭头 (含透明加宽命中区)
  function createArrow(a, b) {
    const d = curve(a, b);
    const g = el("g", { class: "arrow" });
    const hit = el("path", { class: "arrow-hit", d: d, fill: "none", stroke: "transparent", "stroke-width": 24, "stroke-linecap": "round" });
    const path = el("path", { class: "arrow-path", d: d, "marker-end": "url(#arrowhead)" });
    g.appendChild(hit);
    g.appendChild(path);
    const arrow = { el: g, path: path, end: { x: b.x, y: b.y } };
    g.addEventListener("pointerdown", function (e) {
      if (state.mode === "draw" || state.playing) return; // 画线模式下让事件穿透去画新箭头
      e.stopPropagation();
      selectArrow(arrow);
    });
    layers.arrows.appendChild(g);
    state.arrows.push(arrow);
  }

  // 选中箭头并在末端显示删除按钮
  function selectArrow(arrow) {
    hideArrowDelete();
    state.selectedArrow = arrow;
    arrow.path.classList.add("selected");
    const x = clamp(arrow.end.x, 22, W - 22);
    const y = clamp(arrow.end.y, 22, H - 22);
    const g = el("g", { class: "arrow-del" });
    g.appendChild(el("circle", { cx: x, cy: y, r: 16, fill: "#e5484d", stroke: "#fff", "stroke-width": 2.5 }));
    const t = el("text", { x: x, y: y + 6, "text-anchor": "middle", fill: "#fff", "font-size": 20, "font-weight": 700 });
    t.textContent = "×";
    g.appendChild(t);
    g.addEventListener("pointerdown", function (e) {
      e.stopPropagation();
      deleteArrow(arrow);
    });
    layers.arrowUI.appendChild(g);
    state.arrowDelBtn = g;
  }

  function deleteArrow(arrow) {
    arrow.el.remove();
    const i = state.arrows.indexOf(arrow);
    if (i >= 0) state.arrows.splice(i, 1);
    hideArrowDelete();
  }

  function hideArrowDelete() {
    if (state.arrowDelBtn) { state.arrowDelBtn.remove(); state.arrowDelBtn = null; }
    if (state.selectedArrow) { state.selectedArrow.path.classList.remove("selected"); state.selectedArrow = null; }
  }

  function clearArrows() {
    hideArrowDelete();
    state.arrows.forEach(function (a) { a.el.remove(); });
    state.arrows = [];
  }

  // ---------- 阵型应用 ----------
  function applyFormation(team, name) {
    const rows = FORMATIONS[name];
    const isHome = team === "home";
    const pos = formationPositions(rows, isHome);
    const teamPieces = state.pieces.filter(function (p) { return p.team === team; });
    // 排序:守门员 (num=1) 在前
    teamPieces.sort(function (a, b) { return a.num - b.num; });
    teamPieces.forEach(function (p, i) {
      const target = pos[i] || { x: W / 2, y: isHome ? H - 120 : 120 };
      setPiecePos(p, target.x, target.y);
    });
    if (state.ballOwner) moveBallToOwner(); // 保持中ならボールも追従
  }

  // ---------- 初始化棋子 ----------
  function buildTeams() {
    const homePos = formationPositions(FORMATIONS[DEFAULT_HOME], true);
    const awayPos = formationPositions(FORMATIONS[DEFAULT_AWAY], false);
    for (let i = 0; i < 8; i++) {
      state.pieces.push(makePiece("home", i + 1, homePos[i].x, homePos[i].y));
    }
    for (let i = 0; i < 8; i++) {
      state.pieces.push(makePiece("away", i + 1, awayPos[i].x, awayPos[i].y));
    }
    state.ball = makeBall(W / 2, H / 2);
  }

  // ---------- 战术模拟 (关键帧) ----------
  function snapshot() {
    const positions = {};
    state.pieces.forEach(function (p) { positions[p.id] = { x: p.x, y: p.y }; });
    return { positions: positions, ball: { x: state.ball.x, y: state.ball.y } };
  }
  function easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function currentFrameIndex() { return Math.round(state.playPos); }

  function applySnapshot(snap) {
    state.pieces.forEach(function (p) {
      const t = snap.positions[p.id];
      if (t) setPiecePos(p, t.x, t.y);
    });
    if (snap.ball) setBallPos(state.ball, snap.ball.x, snap.ball.y);
  }

  // 把播放位置 pos (0..n-1 浮点) 应用到场上
  function seek(pos, eased) {
    const n = state.frames.length;
    if (n === 0) return;
    pos = clamp(pos, 0, n - 1);
    state.playPos = pos;
    if (n === 1) {
      applySnapshot(state.frames[0]);
    } else {
      let seg = Math.floor(pos);
      if (seg > n - 2) seg = n - 2;
      let local = pos - seg;
      const t = eased ? easeInOutQuad(local) : local;
      const from = state.frames[seg], to = state.frames[seg + 1];
      state.pieces.forEach(function (p) {
        const a = from.positions[p.id], b = to.positions[p.id];
        if (a && b) setPiecePos(p, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      });
      if (from.ball && to.ball)
        setBallPos(state.ball, from.ball.x + (to.ball.x - from.ball.x) * t, from.ball.y + (to.ball.y - from.ball.y) * t);
    }
    syncSimUI();
  }

  function captureFrame() {
    // 现在的位置(可能是插值)先固定,再追加为新帧
    state.frames.push(snapshot());
    state.playPos = state.frames.length - 1;
    if (state.showTrails) drawTrails();
    renderFrameList();
    syncSimUI();
  }
  function updateCurrentFrame() {
    if (state.frames.length === 0) return;
    const idx = currentFrameIndex();
    state.frames[idx] = snapshot();
    seek(idx, false);
    if (state.showTrails) drawTrails();
    renderFrameList();
  }
  function deleteFrame(idx) {
    state.frames.splice(idx, 1);
    state.playPos = clamp(state.playPos, 0, Math.max(0, state.frames.length - 1));
    if (state.frames.length) seek(currentFrameIndex(), false);
    if (state.showTrails) drawTrails();
    renderFrameList();
    syncSimUI();
  }
  function moveFrame(idx, dir) {
    const j = idx + dir;
    if (j < 0 || j >= state.frames.length) return;
    const tmp = state.frames[idx];
    state.frames[idx] = state.frames[j];
    state.frames[j] = tmp;
    state.playPos = j;
    seek(j, false);
    if (state.showTrails) drawTrails();
    renderFrameList();
  }
  function gotoFrame(idx) {
    pause();
    seek(idx, false);
    renderFrameList();
  }
  function clearFrames() {
    pause();
    state.frames = [];
    state.playPos = 0;
    drawTrails();
    renderFrameList();
    syncSimUI();
  }

  // ---- 播放控制 ----
  // 再生時間は「移動距離 ÷ 子供の走速度」で決める(区間ごとに可変)
  function childSpeedMps() { return parseFloat(document.getElementById("speed").value) || 2.5; }
  function segDurationMs(seg, speedMps) {
    const from = state.frames[seg], to = state.frames[seg + 1];
    let maxDist = 0; // その区間で最も長く動く選手の距離(SVG単位)
    state.pieces.forEach(function (p) {
      const a = from.positions[p.id], b = to.positions[p.id];
      if (a && b) { const d = Math.hypot(b.x - a.x, b.y - a.y); if (d > maxDist) maxDist = d; }
    });
    const meters = maxDist * FPV.S; // FPV.S=0.055 (8人制の実寸スケール)
    return Math.max(400, (meters / speedMps) * 1000); // 最低0.4秒
  }
  function play() {
    if (state.frames.length < 2) return;
    if (state.playing) { pause(); return; }
    state.playing = true;
    // 到末尾了就从头开始
    if (state.playPos >= state.frames.length - 1) { state.playPos = 0; seek(0, false); }
    state.playPrevTime = performance.now();
    syncSimUI();
    state.rafId = requestAnimationFrame(playStep);
  }
  function playStep(now) {
    if (!state.playing) return;
    let dt = now - state.playPrevTime;
    state.playPrevTime = now;
    if (dt < 0) dt = 0;
    const speed = childSpeedMps();
    const maxPos = state.frames.length - 1;
    let pos = state.playPos;
    let remaining = dt; // 消化すべき残り時間(ms)
    while (remaining > 0 && pos < maxPos) {
      const seg = Math.min(Math.floor(pos + 1e-9), maxPos - 1);
      const local = pos - seg;
      const dur = segDurationMs(seg, speed);
      const remLocalMs = (1 - local) * dur; // この区間の残り時間
      if (remaining < remLocalMs) {
        pos = seg + local + remaining / dur;
        remaining = 0;
      } else {
        remaining -= remLocalMs;
        pos = seg + 1;
      }
    }
    if (pos >= maxPos) {
      seek(maxPos, true);
      if (state.loop) {
        state.playPos = 0;
        seek(0, true);
        state.playPrevTime = now;
        state.rafId = requestAnimationFrame(playStep);
      } else {
        pause();
      }
      return;
    }
    seek(pos, true);
    state.rafId = requestAnimationFrame(playStep);
  }
  function pause() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = 0;
    state.playing = false;
    syncSimUI();
  }
  function stepFrame(dir) {
    pause();
    if (state.frames.length === 0) return;
    let idx = currentFrameIndex() + dir;
    idx = clamp(idx, 0, state.frames.length - 1);
    seek(idx, false);
    renderFrameList();
  }

  // ---- 动きの軌跡 (点线 + 每帧圆点) ----
  function drawTrails() {
    if (!layers.trails) return;
    layers.trails.innerHTML = "";
    if (!state.showTrails || state.frames.length < 2) return;
    function pathFor(getter, color) {
      let d = "";
      state.frames.forEach(function (f, i) {
        const pt = getter(f);
        if (!pt) return;
        d += (i === 0 ? "M " : "L ") + pt.x + " " + pt.y + " ";
      });
      if (d) {
        layers.trails.appendChild(el("path", {
          d: d, fill: "none", stroke: color, "stroke-width": 2.5,
          "stroke-dasharray": "6 6", "stroke-linecap": "round", opacity: .75,
        }));
        state.frames.forEach(function (f) {
          const pt = getter(f);
          if (pt) layers.trails.appendChild(el("circle", { cx: pt.x, cy: pt.y, r: 3.5, fill: color, opacity: .8 }));
        });
      }
    }
    state.pieces.forEach(function (p) {
      const color = p.team === "home" ? "#ff8a8d" : "#7fb0f2";
      pathFor(function (f) { return f.positions[p.id]; }, color);
    });
    pathFor(function (f) { return f.ball; }, "#ffffff");
  }
  function toggleTrails() {
    state.showTrails = !state.showTrails;
    document.getElementById("trailsBtn").classList.toggle("on", state.showTrails);
    drawTrails();
  }

  // ---- 界面同步 ----
  function renderFrameList() {
    const list = document.getElementById("frameList");
    list.innerHTML = "";
    const active = currentFrameIndex();
    state.frames.forEach(function (f, idx) {
      const li = document.createElement("li");
      li.className = "frame-item" + (idx === active && state.frames.length ? " active" : "");
      li.innerHTML =
        '<span class="fi-label"><span class="fi-index">' + (idx + 1) + '</span>フレーム ' + (idx + 1) + '</span>' +
        '<span class="fi-actions">' +
        '<button class="mini-btn" data-act="up" title="上へ">↑</button>' +
        '<button class="mini-btn" data-act="down" title="下へ">↓</button>' +
        '<button class="mini-btn" data-act="del" title="削除">🗑</button>' +
        '</span>';
      li.onclick = function (ev) {
        if (ev.target.closest(".mini-btn")) return;
        gotoFrame(idx);
      };
      li.querySelector('[data-act="up"]').onclick = function (ev) { ev.stopPropagation(); moveFrame(idx, -1); };
      li.querySelector('[data-act="down"]').onclick = function (ev) { ev.stopPropagation(); moveFrame(idx, 1); };
      li.querySelector('[data-act="del"]').onclick = function (ev) { ev.stopPropagation(); deleteFrame(idx); };
      list.appendChild(li);
    });
    if (state.frames.length === 0) {
      const empty = document.createElement("li");
      empty.className = "hint";
      empty.style.listStyle = "none";
      empty.textContent = "フレームはまだありません。";
      list.appendChild(empty);
    }
  }

  // 播放条 / 按钮 / 提示 的状态同步
  function syncSimUI() {
    const n = state.frames.length;
    const has2 = n >= 2;
    const timeline = document.getElementById("timeline");
    const playBtn = document.getElementById("playBtn");
    const label = document.getElementById("curFrameLabel");

    // 播放/暂停按钮
    playBtn.textContent = state.playing ? "⏸" : "▶";

    // 需要 >=2 帧的控件
    ["firstBtn", "prevBtn", "playBtn", "nextBtn", "lastBtn", "timeline"].forEach(function (id) {
      document.getElementById(id).disabled = !has2;
    });
    document.getElementById("updateBtn").disabled = n === 0;
    document.getElementById("clearFramesBtn").disabled = n === 0;

    // 进度条
    if (has2) {
      timeline.value = Math.round((state.playPos / (n - 1)) * 1000);
    } else {
      timeline.value = 0;
    }

    // 位置文字
    if (n === 0) {
      label.textContent = "フレームなし";
    } else {
      const seg = Math.floor(state.playPos);
      const local = state.playPos - seg;
      if (local > 0.001 && seg < n - 1) {
        label.textContent = "再生位置 " + (seg + 1) + " → " + (seg + 2) + " / " + n;
      } else {
        label.textContent = "フレーム " + (currentFrameIndex() + 1) + " / " + n;
      }
    }

    // 高亮当前帧行
    const items = document.querySelectorAll("#frameList .frame-item");
    const active = currentFrameIndex();
    items.forEach(function (it, i) { it.classList.toggle("active", i === active && n > 0); });
  }

  // ---------- defs (箭头标记) ----------
  function initDefs() {
    const defs = el("defs", {});
    const marker = el("marker", { id: "arrowhead", markerWidth: 8, markerHeight: 8, refX: 6, refY: 3, orient: "auto", markerUnits: "strokeWidth" });
    marker.appendChild(el("path", { d: "M0,0 L6,3 L0,6 Z", fill: "#37d67a" }));
    defs.appendChild(marker);
    pitch.appendChild(defs);
  }

  // ---------- 界面事件 ----------
  function initUI() {
    // 填充阵型下拉
    const selH = document.getElementById("formationHome");
    const selA = document.getElementById("formationAway");
    Object.keys(FORMATIONS).forEach(function (name) {
      selH.appendChild(new Option(name, name));
      selA.appendChild(new Option(name, name));
    });
    selH.value = DEFAULT_HOME;
    selA.value = DEFAULT_AWAY;
    selH.onchange = function () { applyFormation("home", selH.value); };
    selA.onchange = function () { applyFormation("away", selA.value); };

    // 模式切换
    const modeMove = document.getElementById("modeMove");
    const modeDraw = document.getElementById("modeDraw");
    modeMove.onclick = function () { setMode("move"); };
    modeDraw.onclick = function () { setMode("draw"); };

    document.getElementById("clearArrows").onclick = clearArrows;
    document.getElementById("resetBtn").onclick = function () {
      detachBall();
      applyFormation("home", selH.value);
      applyFormation("away", selA.value);
      setBallPos(state.ball, W / 2, H / 2);
    };

    // 战术模拟控件
    document.getElementById("captureBtn").onclick = captureFrame;
    document.getElementById("updateBtn").onclick = updateCurrentFrame;
    document.getElementById("clearFramesBtn").onclick = clearFrames;
    document.getElementById("playBtn").onclick = play;
    document.getElementById("firstBtn").onclick = function () { pause(); seek(0, false); renderFrameList(); };
    document.getElementById("lastBtn").onclick = function () { pause(); seek(state.frames.length - 1, false); renderFrameList(); };
    document.getElementById("prevBtn").onclick = function () { stepFrame(-1); };
    document.getElementById("nextBtn").onclick = function () { stepFrame(1); };
    document.getElementById("loopBtn").onclick = function () {
      state.loop = !state.loop;
      document.getElementById("loopBtn").classList.toggle("on", state.loop);
    };
    document.getElementById("trailsBtn").onclick = toggleTrails;

    const timeline = document.getElementById("timeline");
    timeline.oninput = function () {
      if (state.frames.length < 2) return;
      // 先读取目标值,再 pause()(pause 会同步 UI 覆盖掉进度条的值)
      const pos = (parseInt(timeline.value, 10) / 1000) * (state.frames.length - 1);
      pause();
      seek(pos, true);
      renderFrameList();
    };

    // 速度スライダー = 子供の走速度 (m/s)。再生中もそのまま滑らかに反映される
    document.getElementById("speed").oninput = updateSpeedLabel;
    updateSpeedLabel();
  }

  function updateSpeedLabel() {
    const v = document.getElementById("speed").value;
    const el = document.getElementById("speedVal");
    if (el) el.textContent = v + " m/s";
  }

  function setMode(mode) {
    state.mode = mode;
    document.getElementById("modeMove").classList.toggle("active", mode === "move");
    document.getElementById("modeDraw").classList.toggle("active", mode === "draw");
    // 画线模式下棋子不响应拖动 (通过 mode 判断已实现);光标提示
    pitch.style.cursor = mode === "draw" ? "crosshair" : "default";
  }

  // ---------- 一人称视点 (伪 3D 投影) ----------
  // S: SVG座標→メートル。680×1050 を約 37m×57m の小学生8人制サイズに。
  // EYE/PLAYER_H は小学生向けの身長。BALL_R は視認性のため実寸(約0.11m)より誇張。
  const FPV = { S: 0.055, EYE: 1.35, FOV: 80 * Math.PI / 180, NEAR: 0.25, PLAYER_H: 1.45, BALL_R: 0.22 };
  let fpvCanvas, fpvCtx, fpvCssW = 250, fpvCssH = 180;

  // 球场线段 (SVG 坐标, 地面 h=0)
  const FPV_LINES = (function () {
    const L = [];
    const X0 = 30, Y0 = 30, X1 = 650, Y1 = 1020, MY = 525, CX = 340, CY = 525;
    function seg(a, b, c, d) { L.push([a, b, c, d]); }
    seg(X0, Y0, X1, Y0); seg(X1, Y0, X1, Y1); seg(X1, Y1, X0, Y1); seg(X0, Y1, X0, Y0); // 外框
    seg(X0, MY, X1, MY); // 中线
    const N = 40, R = 82; let px = CX + R, py = CY; // 中圈
    for (let i = 1; i <= N; i++) {
      const a = i / N * 2 * Math.PI, nx = CX + R * Math.cos(a), ny = CY + R * Math.sin(a);
      seg(px, py, nx, ny); px = nx; py = ny;
    }
    const bx = 160, bw = 360, bh = 120; // 禁区
    seg(bx, Y0, bx, Y0 + bh); seg(bx + bw, Y0, bx + bw, Y0 + bh); seg(bx, Y0 + bh, bx + bw, Y0 + bh);
    seg(bx, Y1, bx, Y1 - bh); seg(bx + bw, Y1, bx + bw, Y1 - bh); seg(bx, Y1 - bh, bx + bw, Y1 - bh);
    return L;
  })();
  // 球门框 (含高度 h, 单位米)
  const FPV_GOALS = [
    [280, 30, 0, 280, 30, 2.44], [400, 30, 0, 400, 30, 2.44], [280, 30, 2.44, 400, 30, 2.44],
    [280, 1020, 0, 280, 1020, 2.44], [400, 1020, 0, 400, 1020, 2.44], [280, 1020, 2.44, 400, 1020, 2.44],
  ];

  function fpvLabel(id) {
    const team = id.slice(0, 4) === "home" ? "自" : "相手";
    const num = id.slice(4);
    return team + " " + num + (num === "1" ? " (GK)" : "");
  }
  function getFpvCam() { return state.pieces.find(function (p) { return p.id === state.fpv.playerId; }) || null; }
  function syncYawSlider() { const s = document.getElementById("fpvYaw"); if (s) s.value = Math.round(state.fpv.yaw); }
  function nudgeYaw(d) { state.fpv.yaw = (state.fpv.yaw + d + 360) % 360; syncYawSlider(); }
  function faceDefault() {
    const cam = getFpvCam();
    state.fpv.yaw = (cam && cam.team === "away") ? 180 : 0; // 面向对方球门
    state.fpv.pitch = -6;
    syncYawSlider();
  }
  function setFpvPlayer(id) {
    state.fpv.playerId = id || null;
    state.fpv.active = !!id;
    state.pieces.forEach(function (p) { p.el.classList.toggle("is-camera", p.id === id); });
    if (state.fpv.active) faceDefault();
    else if (layers.fpvCone) layers.fpvCone.innerHTML = "";
  }

  function sizeFPV() {
    if (!fpvCanvas) return;
    const rect = fpvCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    fpvCssW = rect.width || 250; fpvCssH = rect.height || 180;
    fpvCanvas.width = Math.round(fpvCssW * dpr);
    fpvCanvas.height = Math.round(fpvCssH * dpr);
    fpvCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function initFPV() {
    fpvCanvas = document.getElementById("fpvCanvas");
    fpvCtx = fpvCanvas.getContext("2d");
    const sel = document.getElementById("fpvSelect");
    sel.innerHTML = "";
    sel.appendChild(new Option("オフ", ""));
    [["home", "自チーム"], ["away", "相手チーム"]].forEach(function (t) {
      const og = document.createElement("optgroup");
      og.label = t[1];
      for (let i = 1; i <= 8; i++) { const id = t[0] + i; og.appendChild(new Option(fpvLabel(id), id)); }
      sel.appendChild(og);
    });
    sel.onchange = function () { setFpvPlayer(sel.value); };

    // 既定は自チームのGK(home1)の視点
    sel.value = "home1";
    setFpvPlayer("home1");

    document.getElementById("fpvLeft").onclick = function () { nudgeYaw(-20); };
    document.getElementById("fpvRight").onclick = function () { nudgeYaw(20); };
    document.getElementById("fpvReset").onclick = function () { faceDefault(); };
    const yawSlider = document.getElementById("fpvYaw");
    yawSlider.oninput = function () { state.fpv.yaw = parseFloat(yawSlider.value); };

    // 在画面上拖动来环视
    let dragging = false, lastX = 0, lastY = 0;
    fpvCanvas.addEventListener("pointerdown", function (e) {
      if (!state.fpv.active) return;
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      fpvCanvas.setPointerCapture(e.pointerId);
    });
    fpvCanvas.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      state.fpv.yaw = (state.fpv.yaw + dx * 0.4 + 360) % 360;
      state.fpv.pitch = clamp(state.fpv.pitch - dy * 0.3, -35, 20);
      syncYawSlider();
    });
    fpvCanvas.addEventListener("pointerup", function () { dragging = false; });
    fpvCanvas.addEventListener("pointercancel", function () { dragging = false; });

    sizeFPV();
    window.addEventListener("resize", sizeFPV);
    requestAnimationFrame(fpvFrame);
  }

  function fpvFrame() { renderFPV(); requestAnimationFrame(fpvFrame); }

  function drawFpvOff(ctx, W, H) {
    ctx.fillStyle = "#0a1a10";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#5a6b7a";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("選手を選ぶと視点が表示されます", W / 2, H / 2);
  }

  function renderFPV() {
    if (!fpvCtx) return;
    const ctx = fpvCtx, W = fpvCssW, H = fpvCssH;
    const cam = getFpvCam();
    if (!state.fpv.active || !cam) { drawFpvOff(ctx, W, H); if (layers.fpvCone) layers.fpvCone.innerHTML = ""; return; }

    const S = FPV.S;
    const yaw = state.fpv.yaw * Math.PI / 180, pitch = state.fpv.pitch * Math.PI / 180;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const eye = { x: cam.x * S, y: FPV.EYE, z: cam.y * S };
    const f = { x: Math.sin(yaw) * cp, y: sp, z: -Math.cos(yaw) * cp };
    const rlen = Math.hypot(f.x, f.z) || 1e-6;
    const r = { x: -f.z / rlen, y: 0, z: f.x / rlen };
    const u = {
      x: r.y * f.z - r.z * f.y,
      y: r.z * f.x - r.x * f.z,
      z: r.x * f.y - r.y * f.x,
    };
    const focal = (W / 2) / Math.tan(FPV.FOV / 2);

    function camPt(sx, sy, h) {
      const rx = sx * S - eye.x, ry = h - eye.y, rz = sy * S - eye.z;
      return { x: rx * r.x + ry * r.y + rz * r.z, y: rx * u.x + ry * u.y + rz * u.z, z: rx * f.x + ry * f.y + rz * f.z };
    }
    function project(c) { return { x: W / 2 + focal * c.x / c.z, y: H / 2 - focal * c.y / c.z }; }

    // 天空 & 草地
    const dh = { x: f.x / rlen, z: f.z / rlen };
    const horizonY = H / 2 - focal * (dh.x * u.x + dh.z * u.z) / (dh.x * f.x + dh.z * f.z);
    const hY = clamp(horizonY, 0, H);
    let sky = ctx.createLinearGradient(0, 0, 0, hY);
    sky.addColorStop(0, "#0d1622"); sky.addColorStop(1, "#1b3550");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, hY);
    let grass = ctx.createLinearGradient(0, hY, 0, H);
    grass.addColorStop(0, "#2c8a43"); grass.addColorStop(1, "#1c5f30");
    ctx.fillStyle = grass; ctx.fillRect(0, hY, W, H - hY);

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();

    // 球场线
    ctx.lineCap = "round";
    FPV_LINES.forEach(function (s) { drawSeg(ctx, camPt, project, s[0], s[1], 0, s[2], s[3], 0, "rgba(255,255,255,.72)", 1.4); });
    FPV_GOALS.forEach(function (s) { drawSeg(ctx, camPt, project, s[0], s[1], s[2], s[3], s[4], s[5], "rgba(255,255,255,.95)", 2); });

    // 收集棋子 & 球, 由远及近绘制
    const items = [];
    state.pieces.forEach(function (p) {
      if (p.id === cam.id) return;
      const g = camPt(p.x, p.y, 0);
      if (g.z < FPV.NEAR) return;
      items.push({ z: g.z, type: "player", p: p, g: g });
    });
    const bg = camPt(state.ball.x, state.ball.y, 0);
    if (bg.z >= FPV.NEAR) items.push({ z: bg.z, type: "ball", g: bg });
    items.sort(function (a, b) { return b.z - a.z; });

    items.forEach(function (it) {
      if (it.type === "player") {
        const pg = project(it.g);
        const head = camPt(it.p.x, it.p.y, FPV.PLAYER_H);
        const ph = head.z >= FPV.NEAR ? project(head) : { x: pg.x, y: pg.y - 30 };
        const color = it.p.team === "home" ? "#e5484d" : "#2f7de1";
        drawFpvPlayer(ctx, pg.x, pg.y, ph.y, color, it.p.num);
      } else {
        const c = camPt(state.ball.x, state.ball.y, FPV.BALL_R);
        if (c.z < FPV.NEAR) return;
        const pc = project(c);
        const rad = Math.max(2.5, focal * FPV.BALL_R / c.z);
        drawFpvBall(ctx, pc.x, pc.y, rad);
      }
    });
    ctx.restore();

    // HUD
    ctx.fillStyle = "rgba(0,0,0,.5)";
    roundRect(ctx, 8, 8, 128, 24, 6); ctx.fill();
    ctx.fillStyle = cam.team === "home" ? "#ff8a8d" : "#7fb0f2";
    ctx.beginPath(); ctx.arc(22, 20, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "600 13px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(fpvLabel(cam.id) + " の視点", 34, 21);

    updateFpvCone(cam);
  }

  function drawSeg(ctx, camPt, project, a1, b1, h1, a2, b2, h2, color, width) {
    let A = camPt(a1, b1, h1), B = camPt(a2, b2, h2);
    const N = FPV.NEAR;
    if (A.z < N && B.z < N) return;
    if (A.z < N || B.z < N) {
      const t = (N - A.z) / (B.z - A.z);
      const M = { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, z: N };
      if (A.z < N) A = M; else B = M;
    }
    const pa = project(A), pb = project(B);
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  }

  function drawFpvPlayer(ctx, sx, groundY, headY, color, num) {
    const Hh = groundY - headY;
    if (Hh < 3) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(sx, groundY, 2, 0, 7); ctx.fill(); return; }
    const w = Hh * 0.36;
    ctx.fillStyle = "rgba(0,0,0,.30)";
    ctx.beginPath(); ctx.ellipse(sx, groundY, w * 0.7, w * 0.26, 0, 0, Math.PI * 2); ctx.fill();
    const headR = Hh * 0.15;
    const bodyTop = headY + headR * 1.7;
    ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = Math.max(1, Hh * 0.02);
    ctx.fillStyle = color;
    roundRect(ctx, sx - w / 2, bodyTop, w, groundY - bodyTop, w * 0.32); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(sx, headY + headR, headR, 0, Math.PI * 2);
    ctx.fillStyle = "#e9c9a8"; ctx.fill(); ctx.stroke();
    if (Hh > 24) {
      ctx.fillStyle = "#fff"; ctx.font = "700 " + (Hh * 0.26).toFixed(1) + "px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(num, sx, bodyTop + (groundY - bodyTop) * 0.5);
    }
  }

  function drawFpvBall(ctx, sx, sy, r) {
    ctx.fillStyle = "rgba(0,0,0,.25)";
    ctx.beginPath(); ctx.ellipse(sx, sy + r * 0.9, r * 1.1, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#f6f6f6"; ctx.fill();
    ctx.strokeStyle = "#333"; ctx.lineWidth = Math.max(1, r * 0.15); ctx.stroke();
    ctx.fillStyle = "#222"; ctx.beginPath(); ctx.arc(sx, sy, r * 0.32, 0, Math.PI * 2); ctx.fill();
  }

  function roundRect(ctx, x, y, w, h, rad) {
    rad = Math.min(rad, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  // 2D 盘上的视野扇形
  function updateFpvCone(cam) {
    if (!layers.fpvCone) return;
    layers.fpvCone.innerHTML = "";
    const yaw = state.fpv.yaw * Math.PI / 180;
    const half = FPV.FOV / 2;
    const R = 320;
    const p0 = { x: cam.x, y: cam.y };
    function pt(a) { return { x: p0.x + R * Math.sin(a), y: p0.y - R * Math.cos(a) }; }
    const a = pt(yaw - half), b = pt(yaw + half);
    const path = el("path", {
      d: "M " + p0.x + " " + p0.y + " L " + a.x + " " + a.y + " A " + R + " " + R + " 0 0 1 " + b.x + " " + b.y + " Z",
      fill: "rgba(255,209,102,.14)", stroke: "rgba(255,209,102,.45)", "stroke-width": 2,
    });
    layers.fpvCone.appendChild(path);
  }

  // ---------- 简易登录 (仅前端门禁, 非真正安全) ----------
  function initLogin() {
    const USER = "komabayashi", PASS = "1974";
    const overlay = document.getElementById("loginOverlay");
    const form = document.getElementById("loginForm");
    const err = document.getElementById("loginError");
    const userInput = document.getElementById("loginUser");

    if (localStorage.getItem("fv_auth") === "1") {
      overlay.classList.add("hidden");
    } else {
      setTimeout(function () { userInput.focus(); }, 50);
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const u = userInput.value.trim();
      const p = document.getElementById("loginPass").value;
      if (u === USER && p === PASS) {
        localStorage.setItem("fv_auth", "1");
        err.hidden = true;
        overlay.classList.add("hidden");
      } else {
        err.hidden = false;
        document.getElementById("loginPass").value = "";
      }
    });

    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) logoutBtn.onclick = function () {
      localStorage.removeItem("fv_auth");
      location.reload();
    };
  }

  // ---------- 启动 ----------
  function init() {
    initLogin();
    initDefs();
    drawPitch();
    layers.fpvCone = el("g", { class: "fpv-cone-layer" }); // 视野扇形 (球场线之上、棋子之下)
    layers.trails = el("g", { class: "trails-layer" });
    layers.arrows = el("g", { class: "arrows-layer" });
    layers.pieces = el("g", { class: "pieces-layer" });
    layers.arrowUI = el("g", { class: "arrow-ui-layer" }); // 删除按钮置于最上层
    pitch.appendChild(layers.fpvCone);
    pitch.appendChild(layers.trails);
    pitch.appendChild(layers.arrows);
    pitch.appendChild(layers.pieces);
    pitch.appendChild(layers.arrowUI);

    buildTeams();
    initArrowDrawing();
    initUI();
    initFPV();
    renderFrameList();
    syncSimUI();
  }

  init();
})();
