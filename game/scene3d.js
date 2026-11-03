/* =========================================================
   scene3d.js  —  依存なしの小さな WebGL 3D 演出
   - 'corridor' : 無限に続く廊下。小窓から覗く顔、迫ってくる生徒たち。
   - 'ring'     : 教室の中心に立つ視点。背を向けていた生徒たちが、順番にこちらを向く。
   視点は マウス / ドラッグ / スマホの傾き で動かせる。
   WebGL が使えない環境では何もせず、従来の2D演出のままになる。
   ========================================================= */
window.Scene3D = (function () {
  'use strict';
  let cv, gl, prog, U = {}, A = {}, ok = false, mode = null, fade = 0, quadBuf;
  const tex = new Map();               // key -> WebGLTexture
  let T = 0, scroll = 0, camBob = 0;
  const inp = { mx: 0, my: 0, tx: 0, ty: 0, gyroYaw: 0, gyroPitch: 0, gyroOn: false, a0: null, yaw: 0, pitch: 0, drag: false, lx: 0 };
  const rnd = (a, b) => a + Math.random() * (b - a), clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const hash = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

  /* ---------- 行列 ---------- */
  const M = {
    id: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    mul(a, b) { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; },
    persp(fov, asp, n, f) { const t = 1 / Math.tan(fov / 2), o = new Float32Array(16); o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f); return o; },
    trans(x, y, z) { const o = M.id(); o[12] = x; o[13] = y; o[14] = z; return o; },
    rotY(a) { const o = M.id(), c = Math.cos(a), s = Math.sin(a); o[0] = c; o[2] = -s; o[8] = s; o[10] = c; return o; },
    rotX(a) { const o = M.id(), c = Math.cos(a), s = Math.sin(a); o[5] = c; o[6] = s; o[9] = -s; o[10] = c; return o; },
    scale(x, y, z) { const o = M.id(); o[0] = x; o[5] = y; o[10] = z; return o; }
  };

  /* ---------- シェーダ ---------- */
  const VS = `attribute vec2 aP; attribute vec2 aUv;
uniform vec3 uCam; uniform mat4 uVP, uM; uniform vec2 uRep, uOff; varying vec2 vUv; varying float vD;
void main(){ vec4 w = uM * vec4(aP, 0.0, 1.0); vD = length(w.xyz - uCam); gl_Position = uVP * w; vUv = aUv * uRep + uOff; }`;
  const FS = `precision mediump float; varying vec2 vUv; varying float vD;
uniform sampler2D uTex; uniform vec4 uTint; uniform float uEmit, uBright, uRange, uFog, uGlitch, uTime, uAmb; uniform vec3 uFogC;
void main(){
  vec2 uv = vUv;
  if (uGlitch > 0.01) { float row = floor(gl_FragCoord.y / 7.0); float n = fract(sin(row * 91.7 + floor(uTime * 18.0) * 13.3) * 43758.5); if (n > 0.93) uv.x += (n - 0.96) * 0.25 * uGlitch; }
  vec4 t = texture2D(uTex, uv); if (t.a < 0.06) discard;
  vec3 col = t.rgb * uTint.rgb;
  float lit = mix(uAmb, 1.0, clamp(1.0 - vD / uRange, 0.0, 1.0)); lit = mix(lit, 1.0, uEmit);
  col *= lit * uBright;
  float f = 1.0 - exp(-vD * uFog); f = clamp(f, 0.0, 1.0);
  col = mix(col, uFogC, f * (1.0 - uEmit * 0.6));
  if (uGlitch > 0.01) col.r += uGlitch * 0.08 * step(0.5, fract(sin(floor(gl_FragCoord.y / 3.0) + uTime) * 999.0));
  gl_FragColor = vec4(col, t.a * uTint.a);
}`;

  function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }

  /* ---------- テクスチャ（canvas で手作り） ---------- */
  function toTex(src, key, repeat) {
    if (tex.has(key)) return tex.get(key);
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    if (repeat) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    tex.set(key, t); return t;
  }
  function mk(w, h, fn) { const c = document.createElement('canvas'); c.width = w; c.height = h; fn(c.getContext('2d'), w, h); return c; }
  function noise(g, w, h, a) { const id = g.getImageData(0, 0, w, h), d = id.data; for (let i = 0; i < d.length; i += 4) { const v = (Math.random() - .5) * a; d[i] += v; d[i + 1] += v; d[i + 2] += v; } g.putImageData(id, 0, 0); }
  const PROC = {
    wall: () => mk(256, 256, (g, w, h) => {
      g.fillStyle = '#b9b79a'; g.fillRect(0, 0, w, h); g.fillStyle = '#5d6b5c'; g.fillRect(0, h * .55, w, h * .45);
      g.fillStyle = '#2b3029'; g.fillRect(0, h * .55 - 3, w, 6);
      for (let i = 0; i < 9; i++) { g.fillStyle = `rgba(60,50,30,${rnd(.04, .12)})`; g.beginPath(); g.ellipse(rnd(0, w), rnd(0, h * .5), rnd(10, 40), rnd(20, 70), 0, 0, 6.3); g.fill(); }
      noise(g, w, h, 26);
    }),
    floor: () => mk(256, 256, (g, w, h) => {
      g.fillStyle = '#6d6455'; g.fillRect(0, 0, w, h); g.fillStyle = '#5a5246';
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if ((x + y) % 2) g.fillRect(x * 64, y * 64, 64, 64);
      g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 2; for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, h); g.moveTo(0, i * 64); g.lineTo(w, i * 64); g.stroke(); }
      noise(g, w, h, 30);
    }),
    ceil: () => mk(256, 256, (g, w, h) => { g.fillStyle = '#4a4a48'; g.fillRect(0, 0, w, h); noise(g, w, h, 22); g.strokeStyle = 'rgba(0,0,0,.4)'; g.strokeRect(0, 0, w, h); }),
    door: () => mk(128, 256, (g, w, h) => {
      g.fillStyle = '#4a3322'; g.fillRect(0, 0, w, h); g.fillStyle = '#3a2819'; g.fillRect(8, 8, w - 16, h - 16);
      g.fillStyle = '#7f98a0'; g.fillRect(34, 36, w - 68, 74); g.strokeStyle = '#1b130c'; g.lineWidth = 5; g.strokeRect(34, 36, w - 68, 74);
      g.fillStyle = '#b6a36a'; g.beginPath(); g.arc(w - 18, h * .55, 5, 0, 6.3); g.fill(); noise(g, w, h, 18);
    }),
    lamp: () => mk(64, 64, (g, w, h) => { const r = g.createRadialGradient(32, 32, 2, 32, 32, 32); r.addColorStop(0, '#fffbe6'); r.addColorStop(.6, '#fff4c0'); r.addColorStop(1, 'rgba(255,240,170,0)'); g.fillStyle = r; g.fillRect(0, 0, w, h); }),
    body: () => mk(64, 128, (g, w, h) => { g.fillStyle = '#0a0a0e'; g.beginPath(); g.moveTo(0, h); g.lineTo(0, 30); g.quadraticCurveTo(w / 2, -6, w, 30); g.lineTo(w, h); g.fill(); }),
    back: () => mk(128, 128, (g, w, h) => { g.fillStyle = '#0c0c10'; g.beginPath(); g.ellipse(w / 2, h * .46, w * .36, h * .42, 0, 0, 6.3); g.fill(); g.fillStyle = '#16161c'; g.beginPath(); g.ellipse(w / 2, h * .94, w * .5, h * .26, 0, 0, 6.3); g.fill(); noise(g, w, h, 10); }),
    glass: () => mk(8, 8, (g, w, h) => { g.fillStyle = '#9fb7c0'; g.fillRect(0, 0, w, h); }),
    board: () => mk(256, 128, (g, w, h) => { g.fillStyle = '#6a4d2c'; g.fillRect(0, 0, w, h); g.fillStyle = '#1f3a2c'; g.fillRect(6, 6, w - 12, h - 12); g.fillStyle = 'rgba(255,255,255,.55)'; g.font = '34px serif'; g.textAlign = 'center'; g.fillText('静かに', w / 2, h / 2 + 8); noise(g, w, h, 20); }),
    win: () => mk(64, 64, (g, w, h) => { g.fillStyle = '#7a2a22'; g.fillRect(0, 0, w, h); g.strokeStyle = '#1d1210'; g.lineWidth = 4; g.strokeRect(2, 2, w - 4, h - 4); g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke(); }),
    wood: () => mk(256, 256, (g, w, h) => { g.fillStyle = '#4b3523'; g.fillRect(0, 0, w, h); for (let i = 0; i < 14; i++) { g.fillStyle = `rgba(0,0,0,${rnd(.1, .25)})`; g.fillRect(0, i * 18, w, 2); } noise(g, w, h, 28); })
  };
  const REPEAT = new Set(['wall', 'floor', 'ceil', 'wood']);
  const T_ = k => PROC[k] ? toTex(PROC[k](), 'p:' + k, REPEAT.has(k)) : null;
  function imgTex(im, key) { if (!im || !im.complete || !im.naturalWidth) return null; return toTex(im, 'i:' + key, false); }

  /* ---------- 描画ヘルパ ---------- */
  let VP, camPos = [0, 1.5, 0], S = { bright: 1, glitch: 0, range: 8, fog: .14, amb: .1, fogC: [.02, .01, .015] };
  function quad(t, x, y, z, sx, sy, o) {
    o = o || {}; if (!t) return;
    let m = M.mul(M.trans(x, y, z), M.mul(M.rotY(o.yaw || 0), M.mul(M.rotX(o.pitch || 0), M.scale(sx, sy, 1))));
    gl.uniformMatrix4fv(U.uM, false, m);
    gl.uniform2f(U.uRep, (o.rep && o.rep[0]) || 1, (o.rep && o.rep[1]) || 1); gl.uniform2f(U.uOff, (o.off && o.off[0]) || 0, (o.off && o.off[1]) || 0);
    const c = o.tint || [1, 1, 1, 1]; gl.uniform4f(U.uTint, c[0], c[1], c[2], c[3] === undefined ? 1 : c[3]);
    gl.uniform1f(U.uEmit, o.emit || 0); gl.bindTexture(gl.TEXTURE_2D, t); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // カメラの方を向く立て札（円柱ビルボード）
  const face = (x, z) => Math.atan2(camPos[0] - x, camPos[2] - z);

  /* ---------- 入力 ---------- */
  function bindInput() {
    const el = document;
    el.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse') { inp.mx = e.clientX / innerWidth - .5; inp.my = e.clientY / innerHeight - .5; }
      else if (inp.drag) { inp.tx = clamp(inp.tx - (e.clientX - inp.lx) * .006, -1.6, 1.6); inp.lx = e.clientX; }
    }, { passive: true });
    el.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') { inp.drag = true; inp.lx = e.clientX; } }, { passive: true });
    const up = () => { inp.drag = false; }; el.addEventListener('pointerup', up, { passive: true }); el.addEventListener('pointercancel', up, { passive: true });
    window.addEventListener('deviceorientation', e => {
      if (e.alpha == null) return; if (inp.a0 == null) inp.a0 = e.alpha;
      let d = e.alpha - inp.a0; d = ((d + 540) % 360) - 180; inp.gyroYaw = clamp(d * Math.PI / 180, -1.6, 1.6);
      inp.gyroPitch = clamp(((e.beta == null ? 60 : e.beta) - 60) * Math.PI / 180 * -.8, -.45, .45); inp.gyroOn = true;
    });
    // iOS は許可が必要
    const ask = () => { if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') { try { DeviceOrientationEvent.requestPermission().catch(() => {}); } catch (e) {} } document.removeEventListener('pointerdown', ask); };
    el.addEventListener('pointerdown', ask);
  }

  /* ---------- 初期化 ---------- */
  function init() {
    cv = document.getElementById('cv3'); if (!cv) return;
    try {
      gl = cv.getContext('webgl', { alpha: false, antialias: true, powerPreference: 'low-power' }) || cv.getContext('experimental-webgl');
      if (!gl) return;
      prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      ['uVP', 'uM', 'uRep', 'uOff', 'uCam', 'uTex', 'uTint', 'uEmit', 'uBright', 'uRange', 'uFog', 'uGlitch', 'uTime', 'uAmb', 'uFogC'].forEach(n => U[n] = gl.getUniformLocation(prog, n));
      A.p = gl.getAttribLocation(prog, 'aP'); A.uv = gl.getAttribLocation(prog, 'aUv');
      quadBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-.5, 0, 0, 0, .5, 0, 1, 0, -.5, 1, 0, 1, .5, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(A.p); gl.vertexAttribPointer(A.p, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(A.uv); gl.vertexAttribPointer(A.uv, 2, gl.FLOAT, false, 16, 8);
      gl.uniform1i(U.uTex, 0); gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      cv.addEventListener('webglcontextlost', e => { e.preventDefault(); ok = false; cv.classList.remove('on'); });
      bindInput(); resize(); window.addEventListener('resize', resize); ok = true;
    } catch (e) { ok = false; if (window.console) console.warn('3D disabled:', e.message); }
  }
  function resize() { if (!cv) return; const d = Math.min(window.devicePixelRatio || 1, 1.5); cv.width = Math.floor(innerWidth * d); cv.height = Math.floor(innerHeight * d); if (gl) gl.viewport(0, 0, cv.width, cv.height); }

  function setMode(m) {
    if (!ok) return; if (m === mode) return; mode = m || null; inp.a0 = null; inp.tx = 0;
    if (mode) { cv.classList.add('on'); scroll = 0; } else cv.classList.remove('on');
  }

  /* ---------- 廊下 ---------- */
  function drawCorridor(G, dt, IMG, cfg, MOBS) {
    const W = 1.7, H = 3.1, L = 64, P = 5;
    const speed = G.run ? 5.2 : .22; scroll += speed * dt;
    const off = scroll % P, idx0 = Math.floor(scroll / P);
    const rep = L / 2.5;
    quad(T_('floor'), 0, 0, 2, W * 2, L, { pitch: -Math.PI / 2, rep: [W * 2 / 2.5, rep], off: [0, scroll / 2.5], tint: [1, .95, .9, 1] });
    quad(T_('ceil'), 0, H, 2 - L, W * 2, L, { pitch: Math.PI / 2, rep: [2, rep], off: [0, -scroll / 2.5] });
    for (const s of [-1, 1]) quad(T_('wall'), s * W, 0, 2 - L / 2, L, H, { yaw: s * -Math.PI / 2, rep: [rep, 1], off: [-s * scroll / 2.5, 0] });
    quad(T_('wall'), 0, 0, 2 - L, W * 2, H, { rep: [2, 1] });
    // 扉・小窓・蛍光灯（5m 周期）
    const eyes = clamp(G.gaze), wob = G.tension;
    for (let k = 0; k < 14; k++) {
      const z = -(k * P - off) - 1.0, n = idx0 + k; if (z > 1.5) continue;
      const lampOn = hash(n * 3.1) > .12 * (1 + wob * 2) || Math.sin(T * 30 + n) > -.2 ? 1 : .25;
      quad(T_('lamp'), 0, H - .02, z - 1.2, .9, 1.2, { pitch: Math.PI / 2, emit: 1, tint: [1, 1, 1, lampOn] });
      for (const s of [-1, 1]) {
        const dz = z - (s > 0 ? 1.1 : 0); const wallX = s * (W - .01);
        quad(T_('door'), wallX, 0, dz, 1.0, 2.35, { yaw: -s * Math.PI / 2 });
        // 小窓の中の顔
        const who = hash(n * 7.7 + s * 13.1), show = who < eyes * 1.1 + .04 * wob;
        if (show) {
          const im = imgTex(IMG[MOBS[Math.floor(hash(n * 5.3 + s) * MOBS.length)]], 'mob' + Math.floor(hash(n * 5.3 + s) * MOBS.length));
          if (im) quad(im, wallX - s * .03, 1.34, dz, .5, .5, { yaw: -s * Math.PI / 2, tint: [.8, .8, .85, 1] });
        }
      }
    }
    // 追ってくる生徒たち
    const cnt = Math.round(G.gaze * 6);
    for (let i = cnt - 1; i >= 0; i--) {
      const sx = (i % 2 ? -1 : 1) * (.15 + (i * .37 % .9)) * .8, dist = Math.max(2.1, 6.2 + i * 1.9 - (G.chase || 0) * 3.2 - G.tension * 2 + Math.sin(T * .6 + i) * .4);
      const z = -dist, sway = Math.sin(T * .9 + i * 2) * .05, yaw = face(sx, z) + sway;
      mobFig(IMG, MOBS, i, sx, 0, z, yaw, 1.0, 1);
    }
  }

  // 1人分：顔(胸像) + 暗い体
  function mobFig(IMG, MOBS, i, x, y, z, yaw, size, front) {
    const key = MOBS[i % MOBS.length], im = imgTex(IMG[key], key);
    const w = .78 * size, hImg = .78 * size, bodyH = 1.05 * size;
    quad(T_('body'), x, y, z, w * .92, bodyH, { yaw, tint: [1, 1, 1, 1] });
    if (front && im) quad(im, x, y + bodyH - .12 * size, z + 0.0, w, hImg, { yaw, tint: [.92, .92, .96, 1] });
    else quad(T_('back'), x, y + bodyH - .12 * size, z, w, hImg, { yaw });
  }

  /* ---------- 教室（円陣） ---------- */
  const ring = { st: [], inited: false };
  function ringInit() {
    ring.st = []; const N = 14; for (let i = 0; i < N; i++) ring.st.push({ a: i / N * Math.PI * 2 + rnd(-.08, .08), r: 3.0 + rnd(-.3, .7), th: .06 + hash(i * 3.3) * .9, turn: 0, sway: rnd(0, 6), key: i });
    ring.inited = true;
  }
  function drawRing(G, dt, IMG, cfg, MOBS) {
    if (!ring.inited) ringInit();
    camPos = [0, 1.45, 0];
    const R = 6.2, H = 3.2;
    quad(T_('wood'), 0, 0, R, R * 2, R * 2, { pitch: -Math.PI / 2, rep: [4, 4], tint: [1, .9, .85, 1] });
    quad(T_('ceil'), 0, H, -R, R * 2, R * 2, { pitch: Math.PI / 2, rep: [3, 3] });
    const walls = [[0, -R, 0], [R, 0, -Math.PI / 2], [0, R, Math.PI], [-R, 0, Math.PI / 2]];
    walls.forEach(([x, z, yaw], k) => {
      quad(T_('wall'), x, 0, z, R * 2, H, { yaw, rep: [3, 1] });
      if (k === 0) { quad(T_('board'), 0, .9, -R + .03, 4.4, 1.7, {}); }
      if (k === 1 || k === 3) for (const dz of [-3, 0, 3]) quad(T_('win'), x - Math.sign(x) * .04, 1.2, dz, 1.7, 1.4, { yaw, emit: .6 });
    });
    // 生徒：近づきすぎない範囲でじわじわ迫る
    const near = G.gaze;
    const order = ring.st.map((s, i) => [s, i]).sort((a, b) => Math.hypot(b[0].r * Math.sin(b[0].a), b[0].r * Math.cos(b[0].a)) - Math.hypot(a[0].r * Math.sin(a[0].a), a[0].r * Math.cos(a[0].a)));
    for (const [s, i] of order) {
      const target = G.gaze > s.th ? 1 : 0; s.turn += (target - s.turn) * (target ? 2.6 : 3) * Math.min(dt, .05) * (.7 + s.th * .5);
      const rad = s.r - near * 1.1 * s.turn, x = Math.sin(s.a) * rad, z = -Math.cos(s.a) * rad;
      const sw = Math.sin(T * .8 + s.sway) * .04;
      const yaw = face(x, z) + sw, key = MOBS[i % MOBS.length], im = imgTex(IMG[key], key);
      quad(T_('body'), x, 0, z, .74, 1.05, { yaw });
      if (s.turn > .5 && im) quad(im, x, .93, z, Math.max(.04, .85 * (s.turn - .5) * 2), .82, { yaw, tint: [.9, .9, .95, 1] });
      else quad(T_('back'), x, .93, z, Math.max(.04, .85 * (1 - Math.min(1, s.turn * 2))), .82, { yaw });
    }
  }

  /* ---------- フレーム ---------- */
  function frame(G, dt, IMG, cfg, MOBS) {
    if (!ok) return;
    T += dt; const want = mode ? 1 : 0; fade += (want - fade) * Math.min(1, dt * 4);
    if (!mode) return;
    // 視点
    const yawMax = mode === 'ring' ? 1.5 : .7;
    let ty = -inp.mx * 1.4 + inp.tx + (inp.gyroOn ? inp.gyroYaw : 0), tp = -inp.my * .45 + (inp.gyroOn ? inp.gyroPitch : 0);
    if (!inp.gyroOn && !inp.drag) inp.tx *= Math.pow(mode === 'ring' ? .9 : .2, dt);
    inp.yaw += (clamp(ty, -yawMax, yawMax) - inp.yaw) * Math.min(1, dt * 6); inp.pitch += (clamp(tp, -.4, .4) - inp.pitch) * Math.min(1, dt * 6);
    const shake = cfg.mild ? 0 : G.shake * .02, jx = (Math.random() - .5) * shake, jy = (Math.random() - .5) * shake;
    const idleSway = cfg.mild ? 0 : Math.sin(T * .5) * .012;

    gl.viewport(0, 0, cv.width, cv.height);
    gl.clearColor(.02, .008, .01, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(prog); gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    const P = M.persp(1.15, cv.width / cv.height, .1, 90);
    // カメラ姿勢（位置は各 draw 内で決まるので 2 パスで確定）
    if (mode === 'corridor') { camBob += (G.run ? 9 : 1.2) * dt; const bob = cfg.mild ? 0 : (G.run ? Math.sin(camBob) * .07 : Math.sin(camBob) * .012); camPos = [cfg.mild ? 0 : Math.sin(camBob * .5) * (G.run ? .04 : .01), 1.5 + bob, 0]; }
    else camPos = [0, 1.45, 0];
    const Vyaw = inp.yaw + idleSway + jx, Vpitch = inp.pitch + jy;
    const viewFor = c => M.mul(M.rotX(-Vpitch), M.mul(M.rotY(-Vyaw), M.trans(-c[0], -c[1], -c[2])));
    // 先に環境値を決める
    const lightsK = clamp(G.lights); const flick = (G.tension > .6 && !cfg.mild) ? (.82 + .18 * Math.sin(T * 41) * Math.sin(T * 7.3)) : 1;
    // draw（camPos は draw 内で更新される）
    VP = M.mul(P, viewFor(camPos));
    gl.uniformMatrix4fv(U.uVP, false, VP);
    gl.uniform3f(U.uCam, camPos[0], camPos[1], camPos[2]);
    gl.uniform1f(U.uTime, T); gl.uniform1f(U.uGlitch, cfg.mild ? Math.min(G.glitch, .4) : G.glitch);
    const C = mode === 'corridor';
    gl.uniform1f(U.uBright, (.4 + .6 * lightsK) * flick); gl.uniform1f(U.uRange, (C ? 11 : 15) - G.tension * 3);
    gl.uniform1f(U.uFog, C ? .09 : .028 + G.tension * .02); gl.uniform1f(U.uAmb, (C ? .26 : .42) - G.tension * .08);
    gl.uniform3f(U.uFogC, (C ? .03 : .10) + G.tension * .05, C ? .012 : .025, C ? .014 : .03);
    mode === 'corridor' ? drawCorridor(G, dt, IMG, cfg, MOBS) : drawRing(G, dt, IMG, cfg, MOBS);
    // 赤い警告光（テンションが高いとき、画面端を赤く）は CSS 側(#redp / #vig) が担当
  }

  return { init, setMode, frame, ok: () => ok, mode: () => mode, resize, debug: () => ring.st.map(s => +s.turn.toFixed(2)) };
})();
