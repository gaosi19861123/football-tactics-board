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
    // 記憶ゲーム
    game: {
      phase: "idle",     // idle | observe | answer | result
      difficulty: "normal",
      scope: "all",      // away | all | allball
      match: "pos",      // pos = 位置だけ合えばOK(チーム内で最適配対) / num = 背番号も一致必須
      camId: null,       // 視点選手 (答えフェーズでも盤上に残る基準点)
      truth: null,       // 出題時の配置 (正解)
      before: null,      // ゲーム開始前の盤面 (終了時に復元)
      beforeOwner: null,
      beforeFpv: null,
      targets: [],       // [{id, isBall, obj, trayX, trayY, placed}]
      nextIdx: 0,
      tEnd: 0,
      rafId: 0,
      timerId: 0,
    },
  };

  // 難易度 = 観察できる秒数
  const GAME_TIMES = { easy: 10, normal: 8, hard: 5, hell: 3 };
  const GAME_DIFF_LABEL = { easy: "簡単", normal: "普通", hard: "難しい", hell: "地獄" };
  const GAME_SCOPE_LABEL = { away: "相手のみ", all: "全員", allball: "全員+ボール" };
  const GAME_MATCH_LABEL = { pos: "位置のみ", num: "背番号も" };

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
      // ゲーム中: 観察/結果フェーズは動かせない。答えフェーズは出題対象の駒だけ動かせる
      // (視点選手や対象外の駒は基準点として正解位置に固定)
      const ph = state.game.phase;
      if (ph === "observe" || ph === "result") return;
      if (ph === "answer" && !isGameTarget(obj.id)) return;
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
      if (state.game.phase === "answer") {
        if (moved) markPlaced(obj.id); // 実際に動かしたら「配置済み」
        return;                        // ゲーム回答中はボールを選手にくっつけない
      }
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
    const locked = state.game.phase !== "idle"; // 記憶ゲーム中は操作させない
    const has2 = n >= 2 && !locked;
    const timeline = document.getElementById("timeline");
    const playBtn = document.getElementById("playBtn");
    const label = document.getElementById("curFrameLabel");

    // 播放/暂停按钮
    playBtn.textContent = state.playing ? "⏸" : "▶";

    // 需要 >=2 帧的控件
    ["firstBtn", "prevBtn", "playBtn", "nextBtn", "lastBtn", "timeline"].forEach(function (id) {
      document.getElementById(id).disabled = !has2;
    });
    document.getElementById("updateBtn").disabled = n === 0 || locked;
    document.getElementById("clearFramesBtn").disabled = n === 0 || locked;
    document.getElementById("captureBtn").disabled = locked;

    // 进度条
    if (n >= 2) {
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
  let gameCanvas, gameCtx, gameCssW = 640, gameCssH = 360;

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
  function syncYawSlider() {
    const v = Math.round(state.fpv.yaw);
    ["fpvYaw", "goYaw"].forEach(function (id) { const s = document.getElementById(id); if (s) s.value = v; });
  }
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

  // 画面をドラッグして見回す (サイドバー / ゲーム両方のキャンバスで使う)
  function attachLookDrag(canvas) {
    let dragging = false, lastX = 0, lastY = 0;
    canvas.addEventListener("pointerdown", function (e) {
      if (!state.fpv.active) return;
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      state.fpv.yaw = (state.fpv.yaw + dx * 0.4 + 360) % 360;
      state.fpv.pitch = clamp(state.fpv.pitch - dy * 0.3, -35, 20);
      syncYawSlider();
    });
    canvas.addEventListener("pointerup", function () { dragging = false; });
    canvas.addEventListener("pointercancel", function () { dragging = false; });
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

    attachLookDrag(fpvCanvas);

    sizeFPV();
    window.addEventListener("resize", sizeFPV);
    requestAnimationFrame(fpvFrame);
  }

  function fpvFrame() {
    renderFPV();
    if (state.game.phase === "observe") renderGameView();
    requestAnimationFrame(fpvFrame);
  }

  function drawFpvOff(ctx, W, H, msg) {
    ctx.fillStyle = "#0a1a10";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#5a6b7a";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(msg || "選手を選ぶと視点が表示されます", W / 2, H / 2);
  }

  function renderFPV() {
    if (!fpvCtx) return;
    const cam = getFpvCam();
    if (!state.fpv.active || !cam) {
      drawFpvOff(fpvCtx, fpvCssW, fpvCssH);
      if (layers.fpvCone) layers.fpvCone.innerHTML = "";
      return;
    }
    // 回答中は自分の解答が一人称で見えてしまうと答え合わせにならないので伏せる
    if (state.game.phase === "answer") {
      drawFpvOff(fpvCtx, fpvCssW, fpvCssH, "答え合わせのあとに戻ります");
      if (layers.fpvCone) layers.fpvCone.innerHTML = "";
      return;
    }
    drawFpvScene(fpvCtx, fpvCssW, fpvCssH, cam);
    updateFpvCone(cam);
  }

  // 大きなゲーム用キャンバスへの描画 (観察フェーズ)
  function renderGameView() {
    if (!gameCtx) return;
    const cam = state.pieces.find(function (p) { return p.id === state.game.camId; });
    if (cam) drawFpvScene(gameCtx, gameCssW, gameCssH, cam);
  }

  // 一人称シーンを任意のキャンバスに描く (サイドバー / ゲーム共用)
  function drawFpvScene(ctx, W, H, cam) {
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

  // ================= 記憶ゲーム =================
  // 一人称視点だけを制限時間内に見る → 上からの盤面で全員の位置を再現 → 正解と比較して採点

  const GAME_TRAY = { homeY: 470, awayY: 545, ballY: 620 };
  // この誤差(m)以上で0点。ピッチは約37×58mなので、
  // 3m→75点 / 6m→50点 / 9m→25点 くらいの手応えになる
  const SCORE_MAX_ERR = 12;

  function gameEl(id) { return document.getElementById(id); }
  function showGameSection(name) {
    gameEl("gameSetup").hidden = name !== "setup";
    gameEl("gameAnswer").hidden = name !== "answer";
    gameEl("gameResult").hidden = name !== "result";
  }

  // ---- ベストスコア ----
  function bestKey() { return state.game.difficulty + "_" + state.game.scope + "_" + state.game.match; }
  function loadBests() {
    try { return JSON.parse(localStorage.getItem("fv_game_best") || "{}"); } catch (e) { return {}; }
  }
  function saveBest(score) {
    const all = loadBests();
    const k = bestKey();
    if (!(k in all) || score > all[k]) { all[k] = score; localStorage.setItem("fv_game_best", JSON.stringify(all)); return true; }
    return false;
  }
  function renderBest() {
    const box = gameEl("gameBest");
    if (!box) return;
    const b = loadBests()[bestKey()];
    const cond = GAME_DIFF_LABEL[state.game.difficulty] + " / " + GAME_SCOPE_LABEL[state.game.scope] +
      " / " + GAME_MATCH_LABEL[state.game.match];
    box.innerHTML = b === undefined
      ? "ベスト: " + cond + " — まだ記録なし"
      : "ベスト: " + cond + " — <b>" + b + " 点</b>";
  }

  // ---- 出題 ----
  function randomScene() {
    const names = Object.keys(FORMATIONS);
    const hn = names[Math.floor(Math.random() * names.length)];
    const an = names[Math.floor(Math.random() * names.length)];
    detachBall();
    gameEl("formationHome").value = hn;
    gameEl("formationAway").value = an;
    applyFormation("home", hn);
    applyFormation("away", an);
    // 各選手を少し散らす(GKは控えめ)
    state.pieces.forEach(function (p) {
      const j = p.num === 1 ? 20 : 35;
      setPiecePos(p, clamp(p.x + (Math.random() * 2 - 1) * j, 45, W - 45), clamp(p.y + (Math.random() * 2 - 1) * j, 45, H - 45));
    });
    // ボールは誰かの近くに
    const holder = state.pieces[Math.floor(Math.random() * state.pieces.length)];
    setBallPos(state.ball, clamp(holder.x + (Math.random() * 2 - 1) * 40, 45, W - 45), clamp(holder.y + (Math.random() * 2 - 1) * 40, 45, H - 45));
  }

  function resolveCamId() {
    const v = gameEl("gameCam").value;
    if (v === "random") {
      const pool = state.pieces;
      return pool[Math.floor(Math.random() * pool.length)].id;
    }
    return v || "home1";
  }

  function startGame(useCurrent) {
    const g = state.game;
    g.difficulty = document.querySelector("#gameDiffs .dbtn.active").dataset.diff;
    g.scope = gameEl("gameScope").value;
    g.match = gameEl("gameMatch").value;

    // 開始前の盤面を保存 (終了時に元へ戻す)
    g.before = snapshot();
    g.beforeOwner = state.ballOwner;
    g.beforeFpv = state.fpv.playerId;
    g.beforeForm = { home: gameEl("formationHome").value, away: gameEl("formationAway").value };

    pause();
    hideArrowDelete();
    setMode("move");
    if (!useCurrent) randomScene();
    else detachBall();

    g.camId = resolveCamId();
    g.truth = snapshot();       // これが正解
    g.targets = [];
    g.nextIdx = 0;
    layers.gameGhosts.innerHTML = "";

    setGameUiLock(true);
    beginObserve();
  }

  // ---- 観察フェーズ ----
  function beginObserve() {
    const g = state.game;
    g.phase = "observe";
    // 視点をゲームの選手に切り替え、相手ゴール方向を向いてスタート
    setFpvPlayer(g.camId);
    gameEl("goWho").textContent = fpvLabel(g.camId) + " の視点 — " + GAME_DIFF_LABEL[g.difficulty];
    const overlay = gameEl("gameOverlay");
    overlay.hidden = false;
    sizeGameCanvas();
    const secs = GAME_TIMES[g.difficulty];
    g.tEnd = performance.now() + secs * 1000;
    // 表示は rAF で滑らかに。ただし rAF はタブが非表示だと止まるので、
    // フェーズ移行そのものは setTimeout で必ず起こるようにする
    clearGameTimers();
    g.timerId = setTimeout(function () {
      if (state.game.phase === "observe") startAnswerPhase();
    }, secs * 1000 + 60);
    observeTick();
  }

  function clearGameTimers() {
    const g = state.game;
    if (g.rafId) { cancelAnimationFrame(g.rafId); g.rafId = 0; }
    if (g.timerId) { clearTimeout(g.timerId); g.timerId = 0; }
  }

  function observeTick() {
    const g = state.game;
    if (g.phase !== "observe") return;
    const left = g.tEnd - performance.now();
    const total = GAME_TIMES[g.difficulty] * 1000;
    gameEl("goTime").textContent = Math.max(0, left / 1000).toFixed(1);
    gameEl("goBarFill").style.width = clamp(left / total, 0, 1) * 100 + "%";
    if (left <= 0) { startAnswerPhase(); return; }
    g.rafId = requestAnimationFrame(observeTick);
  }

  function sizeGameCanvas() {
    if (!gameCanvas) return;
    const rect = gameCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    gameCssW = rect.width; gameCssH = rect.height;
    gameCanvas.width = Math.round(gameCssW * dpr);
    gameCanvas.height = Math.round(gameCssH * dpr);
    gameCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---- 回答フェーズ ----
  function startAnswerPhase() {
    const g = state.game;
    clearGameTimers();
    g.phase = "answer";
    gameEl("gameOverlay").hidden = true;
    buildTargets();
    showGameSection("answer");
    renderChips();
  }

  // 対象の駒をトレイ(盤面中央)に並べる
  function buildTargets() {
    const g = state.game;
    const wantHome = g.scope !== "away";
    const rows = { home: [], away: [] };
    state.pieces.forEach(function (p) {
      if (p.id === g.camId) return;                 // 視点選手は基準点として残す
      if (p.team === "home" && !wantHome) return;
      rows[p.team].push(p);
    });

    g.targets = [];
    ["home", "away"].forEach(function (team) {
      const list = rows[team];
      const y = team === "home" ? GAME_TRAY.homeY : GAME_TRAY.awayY;
      list.forEach(function (p, i) {
        const x = W * (i + 1) / (list.length + 1);
        g.targets.push({ id: p.id, num: p.num, team: team, isBall: false, obj: p, trayX: x, trayY: y, placed: false });
        setPiecePos(p, x, y);
        p.el.classList.add("tray");
        p.el.classList.remove("has-ball");
      });
    });

    if (g.scope === "allball") {
      detachBall();
      g.targets.push({ id: "ball", num: "", team: "ball", isBall: true, obj: state.ball, trayX: W / 2, trayY: GAME_TRAY.ballY, placed: false });
      setBallPos(state.ball, W / 2, GAME_TRAY.ballY);
      state.ball.el.classList.add("tray");
    } else {
      // 対象外のボールは邪魔なので視点選手の位置ではなく正解位置のまま残す
      state.ball.el.classList.remove("tray");
    }

    // 視点選手を強調 & 固定
    const cam = state.pieces.find(function (p) { return p.id === g.camId; });
    if (cam) { cam.el.classList.remove("tray"); cam.el.classList.add("locked"); }
    g.nextIdx = 0;
  }

  function isGameTarget(id) {
    return state.game.targets.some(function (t) { return t.id === id; });
  }

  function nextTarget() {
    const g = state.game;
    if (g.targets[g.nextIdx] && !g.targets[g.nextIdx].placed) return g.targets[g.nextIdx];
    const i = g.targets.findIndex(function (t) { return !t.placed; });
    g.nextIdx = i;
    return i >= 0 ? g.targets[i] : null;
  }

  function markPlaced(id) {
    const g = state.game;
    const t = g.targets.find(function (x) { return x.id === id; });
    if (!t) return;
    if (!t.placed) {
      t.placed = true;
      t.obj.el.classList.remove("tray");
    }
    if (g.targets[g.nextIdx] === t) nextTarget();
    renderChips();
  }

  // 盤面タップで「次の駒」を置く
  function gameTapPlace(x, y) {
    const t = nextTarget();
    if (!t) return;
    if (t.isBall) setBallPos(t.obj, x, y); else setPiecePos(t.obj, x, y);
    markPlaced(t.id);
  }

  function targetLabel(t) {
    if (t.isBall) return "ボール";
    return (t.team === "home" ? "自" : "相") + t.num;
  }

  function renderChips() {
    const g = state.game;
    const box = gameEl("gameChips");
    box.innerHTML = "";
    const nxt = g.targets[g.nextIdx];
    g.targets.forEach(function (t, i) {
      const b = document.createElement("button");
      b.className = "chip " + t.team + (t.placed ? " done" : "") + (t === nxt ? " next" : "");
      b.textContent = targetLabel(t);
      b.onclick = function () { g.nextIdx = i; renderChips(); };
      box.appendChild(b);
    });
    const done = g.targets.filter(function (t) { return t.placed; }).length;
    gameEl("gamePlacedLabel").textContent = "配置 " + done + " / " + g.targets.length +
      (nxt ? "　次: " + targetLabel(nxt) : "　すべて配置済み");
    // 盤上でも「次に置く駒」を光らせる
    state.game.targets.forEach(function (t) { t.obj.el.classList.toggle("next-place", t === nxt); });
  }

  // ---- 採点 ----
  function submitAnswer() {
    const g = state.game;
    if (g.phase !== "answer") return;

    const base = g.targets.map(function (t) {
      return {
        t: t,
        guess: { x: t.obj.x, y: t.obj.y },
        truth: t.isBall ? g.truth.ball : g.truth.positions[t.id],
        placed: t.placed,
      };
    });
    // 「位置だけ合えばOK」なら、チーム内で合計点が最大になる組み合わせに割り当て直す
    if (g.match === "pos") reassignByPosition(base);

    const results = base.map(function (b) {
      const d = Math.hypot(b.guess.x - b.truth.x, b.guess.y - b.truth.y) * FPV.S;
      return {
        t: b.t, truth: b.truth, guess: b.guess, d: d, pt: b.placed ? pointsFor(d) : 0,
        placed: b.placed, isBall: b.t.isBall, num: b.t.num, team: b.t.team,
      };
    });
    g.phase = "result";
    state.pieces.forEach(function (p) { p.el.classList.remove("tray", "next-place"); });
    state.ball.el.classList.remove("tray");
    drawGameGhosts(results);
    showResult(results);
  }

  function pointsFor(d) { return Math.round(100 * clamp(1 - d / SCORE_MAX_ERR, 0, 1)); }

  // 背番号を問わない採点。チームごとに、合計点が最大になる
  // 「解答 ↔ 正解位置」の対応を総当たりで探す (1チーム最大8人なので 8!=40320 通り)
  function reassignByPosition(base) {
    ["home", "away"].forEach(function (team) {
      const grp = base.filter(function (b) { return !b.t.isBall && b.t.team === team; });
      if (grp.length < 2) return;
      const truths = grp.map(function (b) { return b.truth; });
      const perm = bestPairing(grp, truths);
      perm.forEach(function (ti, i) { grp[i].truth = truths[ti]; });
    });
    // ボールはボールとしか対応しないのでそのまま
  }

  function bestPairing(grp, truths) {
    const n = grp.length;
    // 事前に全組み合わせの点数表を作る (未配置は何に当てても0点)
    const pts = grp.map(function (b) {
      return truths.map(function (tr) {
        if (!b.placed) return 0;
        return pointsFor(Math.hypot(b.guess.x - tr.x, b.guess.y - tr.y) * FPV.S);
      });
    });
    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    let bestSum = -1, bestPerm = order.slice();
    (function search(k, sum) {
      if (k === n) {
        if (sum > bestSum) { bestSum = sum; bestPerm = order.slice(); }
        return;
      }
      for (let i = k; i < n; i++) {
        const tmp = order[k]; order[k] = order[i]; order[i] = tmp;
        search(k + 1, sum + pts[k][order[k]]);
        const t2 = order[k]; order[k] = order[i]; order[i] = t2;
      }
    })(0, 0);
    return bestPerm;
  }

  function errColor(d) { return d < 2 ? "#37d67a" : (d < 4 ? "#ffd166" : "#ff8a8d"); }

  function drawGameGhosts(results) {
    layers.gameGhosts.innerHTML = "";
    results.forEach(function (r) {
      const col = errColor(r.d);
      if (r.placed) {
        layers.gameGhosts.appendChild(el("line", {
          x1: r.guess.x, y1: r.guess.y, x2: r.truth.x, y2: r.truth.y,
          stroke: col, "stroke-width": 2.5, "stroke-dasharray": "5 4", opacity: .9,
        }));
      }
      layers.gameGhosts.appendChild(el("circle", {
        cx: r.truth.x, cy: r.truth.y, r: r.isBall ? 13 : 20,
        fill: "rgba(0,0,0,.25)", stroke: col, "stroke-width": 2.5, "stroke-dasharray": "5 4",
      }));
      const t = el("text", { x: r.truth.x, y: r.truth.y + 5, "text-anchor": "middle", fill: col, "font-size": 15, "font-weight": 700 });
      t.textContent = r.isBall ? "●" : r.num;
      layers.gameGhosts.appendChild(t);
    });
  }

  function rankOf(s) { return s >= 90 ? "S" : s >= 75 ? "A" : s >= 60 ? "B" : s >= 40 ? "C" : "D"; }

  function showResult(results) {
    const n = results.length || 1;
    const score = Math.round(results.reduce(function (a, r) { return a + r.pt; }, 0) / n);
    const avgErr = results.reduce(function (a, r) { return a + r.d; }, 0) / n;
    const rank = rankOf(score);
    const isBest = saveBest(score);

    const rk = gameEl("scoreRank");
    rk.textContent = rank;
    rk.className = "score-rank r-" + rank;
    gameEl("scoreValue").textContent = score;
    gameEl("scoreSub").innerHTML =
      "平均誤差 " + avgErr.toFixed(1) + " m ・ " + GAME_DIFF_LABEL[state.game.difficulty] +
      "(" + GAME_TIMES[state.game.difficulty] + "秒) ・ " + GAME_SCOPE_LABEL[state.game.scope] +
      "<br>採点: " + (state.game.match === "pos" ? "位置だけ(背番号は不問)" : "背番号も一致") +
      (isBest ? '<br><b style="color:#ffd166">🎉 ベスト更新!</b>' : "");

    const list = gameEl("errList");
    list.innerHTML = "";
    results.slice().sort(function (a, b) { return b.d - a.d; }).forEach(function (r) {
      const li = document.createElement("li");
      const col = r.team === "home" ? "#e5484d" : r.team === "away" ? "#2f7de1" : "#f4f4f4";
      const cls = r.pt >= 75 ? "good" : r.pt >= 40 ? "mid" : "bad";
      li.innerHTML =
        '<span class="e-name"><span class="e-dot" style="background:' + col + '"></span>' +
        (r.isBall ? "ボール" : (r.team === "home" ? "自" : "相手") + " " + r.num) + "</span>" +
        '<span class="e-val">' + (r.placed ? r.d.toFixed(1) + " m" : "未配置") + "</span>" +
        '<span class="e-pt ' + cls + '">' + r.pt + "</span>";
      list.appendChild(li);
    });

    showGameSection("result");
    renderBest();
  }

  // ---- 終了 / リセット ----
  function exitGame() {
    const g = state.game;
    clearGameTimers();
    g.phase = "idle";
    gameEl("gameOverlay").hidden = true;
    layers.gameGhosts.innerHTML = "";
    state.pieces.forEach(function (p) { p.el.classList.remove("tray", "next-place", "locked"); });
    state.ball.el.classList.remove("tray");

    // 開始前の盤面へ戻す
    if (g.before) {
      if (g.beforeForm) {
        gameEl("formationHome").value = g.beforeForm.home;
        gameEl("formationAway").value = g.beforeForm.away;
      }
      applySnapshot(g.before);
      detachBall();
      if (g.beforeOwner) {
        const o = state.pieces.find(function (p) { return p.id === g.beforeOwner; });
        if (o) attachBallTo(o);
      }
    }
    const sel = gameEl("fpvSelect");
    sel.value = g.beforeFpv || "";
    setFpvPlayer(g.beforeFpv || "");

    g.targets = [];
    g.truth = null;
    g.before = null;
    setGameUiLock(false);
    showGameSection("setup");
    renderBest();
  }

  function abortGame() {
    exitGame();
  }

  // ゲーム中は盤面を壊す操作を禁止
  function setGameUiLock(on) {
    ["formationHome", "formationAway", "modeMove", "modeDraw", "clearArrows", "resetBtn",
     "fpvSelect", "captureBtn", "updateBtn", "clearFramesBtn", "playBtn", "firstBtn",
     "prevBtn", "nextBtn", "lastBtn", "loopBtn", "trailsBtn", "timeline"].forEach(function (id) {
      const n = gameEl(id);
      if (n) n.disabled = on;
    });
    if (on) hideArrowDelete();
    else syncSimUI();
  }

  function initGame() {
    gameCanvas = gameEl("gameCanvas");
    gameCtx = gameCanvas.getContext("2d");
    attachLookDrag(gameCanvas);

    // 視点の選手セレクト
    const cam = gameEl("gameCam");
    cam.appendChild(new Option("ランダム", "random"));
    [["home", "自チーム"], ["away", "相手チーム"]].forEach(function (t) {
      const og = document.createElement("optgroup");
      og.label = t[1];
      for (let i = 1; i <= 8; i++) { const id = t[0] + i; og.appendChild(new Option(fpvLabel(id), id)); }
      cam.appendChild(og);
    });
    cam.value = "home1";

    // 難易度ボタン
    Array.prototype.forEach.call(document.querySelectorAll("#gameDiffs .dbtn"), function (b) {
      b.onclick = function () {
        document.querySelectorAll("#gameDiffs .dbtn").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        state.game.difficulty = b.dataset.diff;
        renderBest();
      };
    });
    gameEl("gameScope").onchange = function () { state.game.scope = this.value; renderBest(); };
    gameEl("gameMatch").onchange = function () { state.game.match = this.value; renderBest(); };

    gameEl("gameStartRandom").onclick = function () { startGame(false); };
    gameEl("gameStartCurrent").onclick = function () { startGame(true); };
    gameEl("gameSubmit").onclick = submitAnswer;
    gameEl("gameQuit").onclick = abortGame;
    gameEl("gameExit").onclick = exitGame;
    gameEl("gameAgain").onclick = function () {
      const useCurrent = false;
      layers.gameGhosts.innerHTML = "";
      // 前回の「開始前の盤面」を保ったまま再出題する
      const keep = { before: state.game.before, owner: state.game.beforeOwner, fpv: state.game.beforeFpv, form: state.game.beforeForm };
      startGame(useCurrent);
      state.game.before = keep.before;
      state.game.beforeOwner = keep.owner;
      state.game.beforeFpv = keep.fpv;
      state.game.beforeForm = keep.form;
    };
    gameEl("gameShowTruth").onclick = function () {
      if (state.game.truth) applySnapshot(state.game.truth);
    };

    // 観察オーバーレイの操作
    gameEl("goLeft").onclick = function () { nudgeYaw(-20); };
    gameEl("goRight").onclick = function () { nudgeYaw(20); };
    gameEl("goReset").onclick = function () { faceDefault(); };
    gameEl("goYaw").oninput = function () { state.fpv.yaw = parseFloat(this.value); syncYawSlider(); };
    gameEl("goAbort").onclick = abortGame;

    // 盤面タップで次の駒を置く (回答フェーズのみ)
    pitch.addEventListener("pointerdown", function (e) {
      if (state.game.phase !== "answer") return;
      if (e.target.closest && e.target.closest(".piece")) return; // 駒の上はドラッグ扱い
      const p = toSvg(clientX(e), clientY(e));
      gameTapPlace(p.x, p.y);
    });

    window.addEventListener("resize", function () { if (state.game.phase === "observe") sizeGameCanvas(); });

    showGameSection("setup");
    renderBest();
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
    layers.gameGhosts = el("g", { class: "game-ghost-layer" }); // 記憶ゲームの正解ゴースト
    layers.trails = el("g", { class: "trails-layer" });
    layers.arrows = el("g", { class: "arrows-layer" });
    layers.pieces = el("g", { class: "pieces-layer" });
    layers.arrowUI = el("g", { class: "arrow-ui-layer" }); // 删除按钮置于最上层
    pitch.appendChild(layers.fpvCone);
    pitch.appendChild(layers.gameGhosts);
    pitch.appendChild(layers.trails);
    pitch.appendChild(layers.arrows);
    pitch.appendChild(layers.pieces);
    pitch.appendChild(layers.arrowUI);

    buildTeams();
    initArrowDrawing();
    initUI();
    initFPV();
    initGame();
    renderFrameList();
    syncSimUI();
  }

  init();
})();
