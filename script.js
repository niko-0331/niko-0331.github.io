/* =====================================================================
   script.js  —  『沈黙の五限目』 エンジン（演出・サウンド・進行）
   ほぼすべての音は Web Audio で合成しています。外部の効果音ファイルは不要です。
   ===================================================================== */
'use strict';
(() => {

/* ---------- 小道具 ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp  = (a, b, t) => a + (b - a) * t;
const rnd   = (a = 0, b = 1) => a + Math.random() * (b - a);
const pick  = a => a[Math.floor(Math.random() * a.length)];
const qs    = new URLSearchParams(location.search);
const FAST  = qs.has('fast');                       // ?fast … テスト用（文字送り即時）
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k)    { try { localStorage.removeItem(k); } catch (e) {} }
};
const reduced = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } })();
const cfg = Object.assign({ vol: 0.8, mild: reduced, blip: true }, store.get('ssg_cfg', {}));
const saveCfg = () => store.set('ssg_cfg', cfg);

/* ---------- キャンセル可能な待ち ---------- */
const CANCEL = { cancel: true };
let GEN = 0; const pend = new Set();
function pwait(setup) {
  return new Promise((res, rej) => {
    const e = { rej }; pend.add(e);
    setup(v => { pend.delete(e); res(v); }, e);
  });
}
function cancelAll() { GEN++; for (const e of pend) e.rej(CANCEL); pend.clear(); }
const sleep = ms => pwait(res => setTimeout(res, FAST ? Math.min(ms, 25) : ms));

/* =====================================================================
   Snd : 合成サウンド
   ===================================================================== */
const Snd = (() => {
  let ctx = null, master, comp, rev, revSend, amb;
  const noise = {}, L = {};
  const A = { tension: 0, preset: 'none', boost: 0, hushUntil: 0, silenced: false, nextBeat: 0, nextTick: 0, nextDrip: 0, nextMob: 0, nextBird: 0, nextTeach: 0, nextMusic: 0, musicOn: false };
  const mild = () => cfg.mild;

  const PRESET = {
    none:     { drone: 0,   room: 0,   wind: 0,   buzz: 0,    pad: 0,   clock: 0, drip: 0, birds: 0, teach: 0 },
    quiet:    { drone: .25, room: .5,  wind: 0,   buzz: 0,    pad: 0,   clock: 1, drip: 0, birds: 0, teach: 0 },
    class:    { drone: 1,   room: 1,   wind: 0,   buzz: 0,    pad: 0,   clock: 1, drip: 0, birds: 0, teach: 1 },
    corridor: { drone: 1,   room: .3,  wind: 1,   buzz: .5,   pad: 0,   clock: 0, drip: 0, birds: 0, teach: 0 },
    toilet:   { drone: .9,  room: .2,  wind: .2,  buzz: 1,    pad: 0,   clock: 0, drip: 1, birds: 0, teach: 0 },
    room:     { drone: .25, room: .6,  wind: 0,   buzz: 0,    pad: .6,  clock: .5, drip: 0, birds: 0, teach: 0 },
    dark:     { drone: 1.3, room: 0,   wind: .5,  buzz: 0,    pad: 0,   clock: 0, drip: .4, birds: 0, teach: 0 },
    dawn:     { drone: 0,   room: .3,  wind: 0,   buzz: 0,    pad: 1,   clock: 0, drip: 0, birds: 1, teach: 0 }
  };

  /* ----- バッファ生成 ----- */
  function mkNoise(type) {
    const len = ctx.sampleRate * 4, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (type === 'white') d[i] = w;
      else if (type === 'pink') {
        b0 = .99886 * b0 + w * .0555179; b1 = .99332 * b1 + w * .0750759; b2 = .969 * b2 + w * .153852;
        b3 = .8665 * b3 + w * .3104856; b4 = .55 * b4 + w * .5329522; b5 = -.7616 * b5 - w * .016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * .5362) * .11; b6 = w * .115926;
      } else { last = (last + .02 * w) / 1.02; d[i] = last * 3.5; }
    }
    return b;
  }
  function mkIR(sec, decay) {
    const len = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return b;
  }

  /* ----- 出力ヘルパー ----- */
  function out(node, pan = 0, wet = 0) {
    if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); node.connect(p); node = p; }
    node.connect(master);
    if (wet) { const w = ctx.createGain(); w.gain.value = wet; node.connect(w); w.connect(revSend); }
  }
  function tone(o) {
    const { f = 440, f2 = null, dur = .3, type = 'sine', gain = .2, att = .005, when = 0, pan = 0, wet = 0, lp = 0, detune = 0 } = o;
    const t = ctx.currentTime + when, osc = ctx.createOscillator();
    osc.type = type; osc.frequency.setValueAtTime(f, t);
    if (f2) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t + dur);
    osc.detune.value = detune;
    const g = ctx.createGain(); g.gain.setValueAtTime(.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(.0002, gain), t + att);
    g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    let n = osc;
    if (lp) { const f_ = ctx.createBiquadFilter(); f_.type = 'lowpass'; f_.frequency.value = lp; osc.connect(f_); n = f_; }
    n.connect(g); out(g, pan, wet); osc.start(t); osc.stop(t + dur + .05);
  }
  function burst(o) {
    const { type = 'white', dur = .2, gain = .3, ft = 'bandpass', f = 1000, q = 1, f2 = null, att = .002, when = 0, pan = 0, wet = 0 } = o;
    const t = ctx.currentTime + when, s = ctx.createBufferSource();
    s.buffer = noise[type]; s.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = ft; bp.frequency.setValueAtTime(f, t);
    if (f2) bp.frequency.exponentialRampToValueAtTime(f2, t + dur); bp.Q.value = q;
    const g = ctx.createGain(); g.gain.setValueAtTime(.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(.0002, gain), t + att); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    s.connect(bp); bp.connect(g); out(g, pan, wet); s.start(t, rnd(0, 2)); s.stop(t + dur + .05);
  }
  function loopNoise(type, ft, f, q, dest) {
    const s = ctx.createBufferSource(); s.buffer = noise[type]; s.loop = true;
    const fl = ctx.createBiquadFilter(); fl.type = ft; fl.frequency.value = f; fl.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0; s.connect(fl); fl.connect(g); g.connect(dest || amb); s.start(); return { g, fl };
  }

  /* ----- 環境音の構築 ----- */
  function buildAmbient() {
    amb = ctx.createGain(); amb.gain.value = 1; amb.connect(master);
    // ドローン
    const dg = ctx.createGain(); dg.gain.value = 0;
    const dl = ctx.createBiquadFilter(); dl.type = 'lowpass'; dl.frequency.value = 180; dl.Q.value = 1.2;
    [[45, 'sawtooth', .3], [45.7, 'sawtooth', .3], [90.4, 'sine', .5], [67.6, 'triangle', .3]].forEach(([f, t, v]) => {
      const o = ctx.createOscillator(); o.type = t; o.frequency.value = f; const g = ctx.createGain(); g.gain.value = v; o.connect(g); g.connect(dl); o.start();
    });
    dl.connect(dg); dg.connect(amb); L.drone = dg; L.droneF = dl;
    const lfo = ctx.createOscillator(); lfo.frequency.value = .07; const lg = ctx.createGain(); lg.gain.value = 70; lfo.connect(lg); lg.connect(dl.frequency); lfo.start();
    // 耳鳴り
    const th = ctx.createGain(); th.gain.value = 0;
    [6900, 7230].forEach(f => { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(th); o.start(); });
    th.connect(amb); L.tin = th;
    // 空気・風・蛍光灯・パッド
    L.room = loopNoise('pink', 'lowpass', 500, .5).g;
    const w = loopNoise('pink', 'bandpass', 650, .7); L.wind = w.g; L.windF = w.fl;
    const wl = ctx.createOscillator(); wl.frequency.value = .11; const wg = ctx.createGain(); wg.gain.value = 260; wl.connect(wg); wg.connect(w.fl.frequency); wl.start();
    const bz = ctx.createGain(); bz.gain.value = 0; const bf = ctx.createBiquadFilter(); bf.type = 'lowpass'; bf.frequency.value = 900;
    [100, 200.4, 300.3].forEach((f, i) => { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; const g = ctx.createGain(); g.gain.value = 1 / (i + 1); o.connect(g); g.connect(bf); o.start(); });
    bf.connect(bz); bz.connect(amb); L.buzz = bz;
    const pd = ctx.createGain(); pd.gain.value = 0; const pf = ctx.createBiquadFilter(); pf.type = 'lowpass'; pf.frequency.value = 1400;
    [174.6, 220, 261.6, 329.6, 349.2].forEach((f, i) => {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f; o.detune.value = rnd(-6, 6);
      const g = ctx.createGain(); g.gain.value = .2; const l = ctx.createOscillator(); l.frequency.value = rnd(.05, .15); const lgn = ctx.createGain(); lgn.gain.value = .12; l.connect(lgn); lgn.connect(g.gain); l.start();
      o.connect(g); g.connect(pf); o.start();
    });
    pf.connect(pd); pd.connect(amb); L.pad = pd;
  }

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    try { ctx = new AC(); } catch (e) { ctx = null; return; }
    master = ctx.createGain(); master.gain.value = cfg.vol;
    comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 10; comp.attack.value = .003; comp.release.value = .25;
    master.connect(comp); comp.connect(ctx.destination);
    noise.white = mkNoise('white'); noise.pink = mkNoise('pink'); noise.brown = mkNoise('brown');
    rev = ctx.createConvolver(); rev.buffer = mkIR(2.4, 2.6); revSend = ctx.createGain(); const ro = ctx.createGain(); ro.gain.value = .7;
    revSend.connect(rev); rev.connect(ro); ro.connect(master);
    buildAmbient();
    setInterval(update, 100);
    setTimeout(preloadVoices, 800);
  }
  function setVolume(v) { cfg.vol = v; if (master) master.gain.setTargetAtTime(v, ctx.currentTime, .05); }

  /* ----- 毎フレーム的な更新（100msごと） ----- */
  function update() {
    if (!ctx) return;
    const now = ctx.currentTime, P = PRESET[A.preset] || PRESET.none, t = A.tension;
    const hushed = now < A.hushUntil || A.silenced, k = hushed ? .06 : 1;
    const set = (g, v, tc = .5) => g.gain.setTargetAtTime(v, now, tc);
    set(L.drone, P.drone * (.03 + .17 * t) * k, .6);
    L.droneF.frequency.setTargetAtTime(110 + 520 * t, now, .8);
    set(L.tin, P.drone ? clamp((t - .7) * .035, 0, .02) * k : 0);
    set(L.room, P.room * .05 * k);
    set(L.wind, P.wind * (.03 + .07 * t) * k);
    set(L.buzz, P.buzz * .012 * k);
    set(L.pad, P.pad * .05, 1.2);
    // 心音
    if (t > .25 && !hushed && now >= A.nextBeat) {
      const bpm = 56 + 88 * t + A.boost * 30, v = clamp((t - .15) * .55 + A.boost * .15, 0, .65) * (mild() ? .7 : 1);
      thump(v); A.nextBeat = now + 60 / bpm;
    }
    // 時計
    if (P.clock && now >= A.nextTick && A.clockOn) {
      const loud = .035 + .06 * t; burst({ dur: .03, gain: loud * (P.clock), f: 3000, q: 1.5 });
      if (t > .65 && Math.random() < .25) burst({ dur: .03, gain: loud * .7, f: 2400, q: 1.5, when: .13 });
      A.nextTick = now + (t > .7 ? rnd(.7, 1.3) : 1);
    }
    // 水滴
    if (P.drip && now >= A.nextDrip) { drip(); A.nextDrip = now + rnd(2.4, 6) / P.drip; }
    // 先生の朗読（意味のない低いぼそぼそ声）
    if (P.teach && !hushed && now >= A.nextTeach) { babble(.05 + .04 * t, rnd(1.4, 2.6), { low: true, slow: true, voices: 2 }); A.nextTeach = now + rnd(2.2, 4.5); }
    // モブの不気味な声
    if (t > .6 && P.drone && !hushed && now >= A.nextMob) { vox('mob:ghost', .22); A.nextMob = now + rnd(9, 16); }
    // 鳥と音色
    if (P.birds && now >= A.nextBird) { birds(); A.nextBird = now + rnd(2.5, 6); }
    if (P.pad && A.preset === 'dawn' && now >= A.nextMusic) { musicbox(); A.nextMusic = now + rnd(.9, 1.7); }
    A.boost = Math.max(0, A.boost - .004);
  }

  /* ----- 各種サウンド ----- */
  function thump(v) {
    tone({ f: 72, f2: 38, dur: .16, gain: v, type: 'sine' });
    tone({ f: 66, f2: 36, dur: .15, gain: v * .75, type: 'sine', when: .17 });
    burst({ type: 'brown', dur: .08, gain: v * .25, f: 120, q: 1 });
  }
  function drip() { tone({ f: 1500, f2: 640, dur: .16, gain: .1, wet: .8, pan: rnd(-.5, .5) }); tone({ f: 3000, f2: 1400, dur: .06, gain: .03, wet: .6 }); }
  function birds() {
    const base = rnd(2600, 4200), n = Math.floor(rnd(2, 5));
    for (let i = 0; i < n; i++) tone({ f: base + rnd(-200, 200), f2: base * rnd(1.2, 1.5), dur: .09, gain: .018, when: i * .13, pan: rnd(-.8, .8), wet: .3 });
  }
  function musicbox() {
    const scale = [698.5, 880, 1046.5, 1318.5, 784, 1174.7];
    tone({ f: pick(scale), dur: 1.6, gain: .03, type: 'sine', pan: rnd(-.4, .4), wet: .6 });
    tone({ f: pick(scale) * 2, dur: .8, gain: .012, type: 'sine', pan: rnd(-.4, .4), wet: .6 });
  }
  function babble(level = .12, dur = 2.5, o = {}) {
    if (!ctx) return; const t0 = ctx.currentTime, n = o.voices || 4;
    for (let k = 0; k < n; k++) {
      const src = ctx.createBufferSource(); src.buffer = noise.white; src.loop = true; src.playbackRate.value = rnd(.8, 1.2);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = o.low ? rnd(380, 1100) : rnd(1400, 4800); bp.Q.value = o.low ? 2.5 : 5;
      const g = ctx.createGain(); g.gain.value = 0; src.connect(bp); bp.connect(g); out(g, rnd(-1, 1), .45);
      let t = t0 + rnd(0, .3); const end = t0 + dur, step = o.slow ? rnd(.14, .24) : rnd(.06, .14);
      g.gain.setValueAtTime(0, t0);
      while (t < end) { const a = rnd(.3, 1) * level / Math.sqrt(n); g.gain.linearRampToValueAtTime(a, t + .02); g.gain.linearRampToValueAtTime(a * rnd(.1, .6), t + step * .7); t += step * rnd(.8, 1.4); }
      g.gain.linearRampToValueAtTime(0, end + .1); src.start(t0); src.stop(end + .3);
    }
  }
  function bell(f, when, vol, len = 2.6, detune = 0) {
    [[1, 1], [2.76, .5], [5.4, .25], [8.93, .12]].forEach(([r, v]) => tone({ f: f * r, dur: len / (1 + r * .12), gain: vol * v, when, type: 'sine', detune, wet: .4, att: .004 }));
  }
  function stomach(big) {
    const t = ctx.currentTime, dur = big ? 3.4 : 1.7, vol = big ? .9 : .55;
    const s = ctx.createBufferSource(); s.buffer = noise.brown; s.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3.5;
    bp.frequency.setValueAtTime(80, t); bp.frequency.linearRampToValueAtTime(240, t + dur * .35); bp.frequency.linearRampToValueAtTime(95, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t);
    for (let x = 0; x < dur; x += rnd(.1, .26)) g.gain.linearRampToValueAtTime(rnd(.15, 1) * vol * Math.sin(Math.PI * x / dur + .2), t + x);
    g.gain.linearRampToValueAtTime(0, t + dur + .1);
    s.connect(bp); bp.connect(g); out(g, 0, big ? .7 : .25); s.start(t); s.stop(t + dur + .2);
    const g2 = ctx.createBufferSource(); g2.buffer = noise.pink; g2.loop = true;
    const b2 = ctx.createBiquadFilter(); b2.type = 'bandpass'; b2.Q.value = 6; b2.frequency.setValueAtTime(300, t); b2.frequency.linearRampToValueAtTime(720, t + dur * .6);
    const gg = ctx.createGain(); gg.gain.setValueAtTime(0, t);
    for (let x = 0; x < dur; x += rnd(.07, .2)) gg.gain.linearRampToValueAtTime(rnd(0, .5) * vol * .4, t + x);
    gg.gain.linearRampToValueAtTime(0, t + dur); g2.connect(b2); b2.connect(gg); out(gg, 0, big ? .8 : .3); g2.start(t); g2.stop(t + dur + .2);
    if (big) { tone({ f: 48, f2: 30, dur: 1.6, gain: .5, type: 'sine' }); }
  }
  function scare(soft) {
    const v = (soft ? .45 : 1) * (mild() ? .45 : 1);
    tone({ f: 58, f2: 28, dur: .9, gain: .9 * v, type: 'sine' });
    burst({ type: 'white', dur: .55, gain: .55 * v, ft: 'lowpass', f: 9000, att: .001 });
    if (!soft) {
      tone({ f: 520, f2: 2700, dur: .6, gain: .22 * v, type: 'sawtooth', lp: 5000, wet: .2 });
      tone({ f: 560, f2: 2300, dur: .6, gain: .18 * v, type: 'sawtooth', lp: 4500, detune: 40, wet: .2 });
      tone({ f: 880, f2: 3100, dur: .45, gain: .1 * v, type: 'square', lp: 3000 });
    } else {
      tone({ f: 300, f2: 900, dur: .5, gain: .12 * v, type: 'sawtooth', lp: 2500, wet: .3 });
    }
  }

  const SFX = {
    chair()  { burst({ type: 'brown', dur: .4, gain: .35, f: 160, f2: 90, q: 1.2 }); burst({ dur: .3, gain: .06, f: 1800, q: 4, when: .02 }); },
    tick()   { burst({ dur: .04, gain: .1, f: 3000, q: 1.5 }); },
    stomach() { stomach(false); }, stomachBig() { stomach(true); },
    door()   { tone({ f: 120, f2: 70, dur: .14, gain: .3 }); burst({ type: 'brown', dur: .2, gain: .25, f: 400, q: .8 }); burst({ dur: .05, gain: .08, f: 2500, q: 3, when: .12 }); },
    doorSlam() { tone({ f: 70, f2: 32, dur: .5, gain: .8 }); burst({ type: 'white', dur: .35, gain: .4, ft: 'lowpass', f: 3500 }); },
    creak()  { tone({ f: 110, f2: 230, dur: 1.1, type: 'sawtooth', gain: .05, lp: 900, wet: .4 }); tone({ f: 118, f2: 190, dur: 1.0, type: 'sawtooth', gain: .035, lp: 700, when: .1, pan: .4 }); },
    knock()  { [0, .3, .6].forEach(w => { tone({ f: 130, f2: 62, dur: .14, gain: .7, when: w, wet: .2 }); burst({ type: 'brown', dur: .1, gain: .4, f: 300, when: w }); }); },
    steps()  { for (let i = 0; i < 8; i++) { burst({ type: 'brown', dur: .1, gain: .5 - i * .02, f: 140, when: i * (.34 - i * .02), pan: i % 2 ? .3 : -.3, wet: .3 }); } },
    run()    { SFX.steps(); },
    stopRun() {},
    drip, latch() { tone({ f: 900, dur: .04, type: 'square', gain: .08, lp: 3000 }); tone({ f: 600, dur: .05, type: 'square', gain: .08, lp: 3000, when: .09 }); },
    page()   { burst({ dur: .2, gain: .07, f: 5200, q: 1.2 }); burst({ dur: .12, gain: .05, f: 4000, q: 1, when: .1 }); },
    swell()  { burst({ type: 'pink', dur: 2.6, gain: .3, f: 200, f2: 3200, q: 1.5, att: 1.6, wet: .3 }); tone({ f: 80, f2: 420, dur: 2.6, gain: .12, att: 1.8, type: 'sawtooth', lp: 1200 }); },
    static() { burst({ dur: .5, gain: .22, ft: 'highpass', f: 1200 }); },
    heart()  { A.boost = 1.2; },
    hush()   { A.hushUntil = ctx.currentTime + 2.4; },
    silence(){ A.silenced = true; },
    unsilence(){ A.silenced = false; },
    babble() { babble(.2, 3.2, { voices: 5 }); },
    giggle() { babble(.3, 2.4, { voices: 6 }); [0, .4, .9].forEach(w => tone({ f: rnd(900, 1500), f2: rnd(500, 800), dur: .12, gain: .02, when: w, wet: .6 })); },
    chime()  { [[349.2, 0], [440, .82], [392, 1.64], [261.6, 2.46]].forEach(([f, w], i) => bell(f, w, .16, i === 3 ? 4 : 2.6)); },
    chimeBad() { [[329.6, 0], [415.3, 1.1], [370, 2.3], [233, 3.6]].forEach(([f, w], i) => bell(f * .5, w, .2, 3.6, rnd(-30, 30))); burst({ type: 'pink', dur: 4, gain: .08, f: 300, f2: 90, q: 2 }); },
    crack()  { burst({ dur: .1, gain: .4, ft: 'highpass', f: 3000 }); tone({ f: 2400, f2: 900, dur: .06, gain: .1 }); },
    glass()  { burst({ dur: 1, gain: .5, ft: 'highpass', f: 2200, wet: .4 }); for (let i = 0; i < 12; i++) tone({ f: rnd(2500, 7000), dur: .12, gain: .04, when: rnd(0, .8), wet: .4, pan: rnd(-1, 1) }); },
    water()  { burst({ type: 'pink', dur: 1.2, gain: .1, ft: 'highpass', f: 1400 }); },
    scare()  { scare(false); }, scareSoft() { scare(true); },
    click()  { tone({ f: 1100, f2: 700, dur: .05, gain: .05 }); },
    blip()   { tone({ f: 460, dur: .018, gain: .012, type: 'triangle' }); },
    birds
  };
  function play(name) { if (!ctx || !SFX[name]) return; try { SFX[name](); } catch (e) { /* 音の失敗でゲームを止めない */ } }

  /* ----- ボイス ----- */
  const bufs = new Map(), loading = new Map(), recent = [];
  function loadClip(id) {
    if (bufs.has(id)) return Promise.resolve(bufs.get(id));
    if (loading.has(id)) return loading.get(id);
    const p = (async () => {
      try {
        const r = await fetch(VOICE_DIR + id + '.wav'); const ab = await r.arrayBuffer();
        const b = await new Promise((res, rej) => { const q = ctx.decodeAudioData(ab, res, rej); if (q && q.catch) q.catch(rej); });
        bufs.set(id, b); return b;
      } catch (e) { bufs.set(id, null); return null; }
    })();
    loading.set(id, p); return p;
  }
  function preloadVoices() {
    const ids = Object.values(VOICE_CAST).flat(); let i = 0;
    (function nxt() { if (i >= ids.length || !ctx) return; loadClip(ids[i++]).then(() => setTimeout(nxt, 40)); })();
  }
  async function vox(spec, vol = 1) {
    if (!ctx || !spec) return;
    const [who, mode = 'ghost'] = spec.split(':'), list = VOICE_CAST[who]; if (!list || !list.length) return;
    let id, tries = 0; do { id = pick(list); tries++; } while (recent.includes(id) && tries < 8);
    recent.push(id); if (recent.length > 6) recent.shift();
    const buf = await loadClip(id); if (!buf) return;
    const t = ctx.currentTime + .02, src = ctx.createBufferSource(); src.buffer = buf;
    const M = { door: { lp: 650, hp: 120, rate: 1, gain: .9, wet: .35 }, ghost: { lp: 3000, hp: 260, rate: .9, gain: .6, wet: .75 },
                close: { lp: 2600, hp: 80, rate: .85, gain: .85, wet: .3 }, near: { lp: 9000, hp: 60, rate: 1, gain: .75, wet: .15 } }[mode] || {};
    src.playbackRate.value = M.rate || 1;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = M.hp || 100;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = M.lp || 3000;
    const g = ctx.createGain(), len = Math.min(buf.duration / (M.rate || 1), mode === 'near' ? 20 : 4.2);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime((M.gain || .6) * vol, t + .12); g.gain.setValueAtTime((M.gain || .6) * vol, t + Math.max(.2, len - .5)); g.gain.linearRampToValueAtTime(0, t + len);
    src.connect(hp); hp.connect(lp); lp.connect(g); out(g, rnd(-.5, .5), M.wet || .3); src.start(t); src.stop(t + len + .05);
  }

  let lineSrc = null;
  function stopLine() { if (lineSrc) { try { lineSrc.stop(); } catch (e) {} lineSrc = null; } }
  async function line(id) {
    stopLine(); if (!ctx || !id) return;
    const buf = await loadClip('lines/' + id); if (!buf) return;
    stopLine();
    const src = ctx.createBufferSource(); src.buffer = buf; const g = ctx.createGain(); g.gain.value = 1.0;
    src.connect(g); out(g, 0, .12); src.start(ctx.currentTime + .02); lineSrc = src;
  }

  /* ----- 外部操作 ----- */
  function setPreset(name) {
    A.preset = PRESET[name] ? name : 'none'; A.silenced = false;
    A.clockOn = !!(PRESET[A.preset].clock);
    A.nextMusic = 0; A.nextBird = 0;
  }
  return {
    init, play, vox, line, stopLine, setVolume, setPreset, babble,
    get ctx() { return ctx; },
    setTension(t) { A.tension = t; },
    blip() { if (cfg.blip) play('blip'); },
    unlock() { init(); }
  };
})();

/* =====================================================================
   Gfx : Canvas背景・視線・立ち絵・ジャンプスケア
   ===================================================================== */
const Gfx = (() => {
  const G = { bg: 'black', variant: '', t: 0, tension: 0, tT: 0, gaze: 0, gazeT: 0, eyes: 0, eyesT: 0, clock: 'run', secA: 0, backT: 0,
              lights: 1, lightsT: 1, scroll: 0, run: 0, stretch: 0, glitch: 0, shake: 0, flash: 0, black: 0, blackT: 0, cracked: 0, chase: 0, last: 0 };
  let cv, ctx, W = 0, H = 0, dpr = 1, grain, gctx, app;
  const students = [], eyeList = [], IMG = {};
  const rgb = (r, g, b, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
  const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const C = a => rgb(a[0], a[1], a[2]);

  function loadImages() {
    Object.entries(SPRITES).forEach(([k, src]) => { const im = new Image(); im.src = src; IMG[k] = im; });
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function init() {
    if (window.Scene3D) Scene3D.init();
    cv = $('#cv'); ctx = cv.getContext('2d'); grain = $('#grain'); gctx = grain.getContext('2d'); app = $('#app');
    grain.width = 200; grain.height = 200;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) students.push({ r, c, th: rnd(.05, .98), turn: 0, tilt: rnd(-.1, .1), sway: rnd(0, 6), img: MOBS[(r * 5 + c * 2 + r) % MOBS.length] });
    loadImages(); resize(); window.addEventListener('resize', resize);
    requestAnimationFrame(frame);
  }

  /* ---- 状態の操作 ---- */
  function setBg(id, variant) {
    if (id && id !== G.bg) { G.gaze = 0; G.gazeT = 0; G.eyes = 0; G.eyesT = 0; G.lightsT = 1; G.lights = Math.max(G.lights, .6); G.run = 0; G.stretch = 0; G.cracked = id === 'mirror' ? G.cracked : 0; students.forEach(s => s.turn = 0); eyeList.length = 0; }
    if (id) G.bg = id; G.variant = variant || '';
  }
  function set(o) {
    if ('tension' in o) G.tT = clamp(o.tension);
    if ('gaze' in o) G.gazeT = clamp(o.gaze);
    if ('eyes' in o) G.eyesT = o.eyes;
    if ('lights' in o) G.lightsT = o.lights === 'off' ? 0 : 1;
    if ('clock' in o) { G.clock = o.clock; if (o.clock === 'back') { G.backT = 2.4; } }
    if ('run' in o) G.run = o.run;
    if ('stretch' in o) G.stretch = o.stretch;
    if ('cracked' in o) G.cracked = o.cracked;
  }
  function turnAll() { G.gazeT = 1; G.gaze = 1; students.forEach(s => { s.turn = Math.max(s.turn, .75); }); }
  function shake(p) { if (cfg.mild) p *= .35; G.shake = Math.max(G.shake, p); }
  function flash(col) { if (cfg.mild) return; G.flash = 1; $('#flash').style.background = col || '#fff'; }
  function glitch(p) { G.glitch = Math.max(G.glitch, cfg.mild ? p * .5 : p); }
  function fade(kind) {
    if (kind === 'out') G.blackT = 1;
    else if (kind === 'blink') { G.blackT = 1; setTimeout(() => G.blackT = 0, 380); }
    else G.blackT = 0;
  }
  function reset() { G.blackT = 0; G.black = Math.min(G.black, .0); G.chase = 0; }

  /* ---- 立ち絵（DOM） ---- */
  function dropSprites(keys) {
    $$('.sprite', $('#sprites')).forEach(el => { if (keys.includes(el.dataset.key.split(':')[0]) && !el.classList.contains('leaving')) { el.classList.remove('show'); el.classList.add('leaving'); setTimeout(() => el.remove(), 520); } });
  }
  function setSprites(list) {
    const box = $('#sprites'); const want = (list || []).map(s => { const [k, pos = 'center', st = ''] = s.split(':'); return { k, pos, st, key: k + ':' + pos }; });
    $$('.sprite', box).forEach(el => {
      const w = want.find(x => x.key === el.dataset.key);
      if (!w && !el.classList.contains('leaving')) { el.classList.remove('show'); el.classList.add('leaving'); setTimeout(() => el.remove(), 520); }
    });
    want.forEach(w => {
      let el = $$('.sprite', box).find(e => e.dataset.key === w.key && !e.classList.contains('leaving'));
      if (!el) {
        el = document.createElement('img'); el.className = 'sprite'; el.dataset.key = w.key; el.alt = ''; el.draggable = false;
        el.src = SPRITES[w.k] || ''; box.appendChild(el); void el.offsetWidth; el.classList.add('show');
      }
      el.className = 'sprite show pos-' + w.pos + (w.k.endsWith('_full') ? ' full' : '') + (w.k.startsWith('mob') ? ' mob' : '') + (w.st ? ' st-' + w.st : '');
    });
  }
  function floatWords(words, n = 5) {
    const box = $('#whispers'); if (!box) return;
    for (let i = 0; i < n; i++) setTimeout(() => {
      const s = document.createElement('span'); s.className = 'wh'; s.textContent = pick(words);
      s.style.left = rnd(4, 82) + '%'; s.style.top = rnd(8, 62) + '%'; s.style.fontSize = rnd(15, 34) + 'px';
      s.style.setProperty('--dx', rnd(-30, 30) + 'px'); s.style.setProperty('--rot', rnd(-8, 8) + 'deg'); s.style.animationDuration = rnd(3.2, 5.5) + 's';
      box.appendChild(s); setTimeout(() => s.remove(), 6000);
    }, i * rnd(120, 380));
  }
  function scareFace(soft) {
    const box = $('#scare'), img = $('#scareImg'); if (!box) return;
    img.src = SPRITES[pick(MOBS)];
    box.className = 'on' + (soft ? ' soft' : '') + (cfg.mild ? ' mild' : '');
    glitch(soft ? .5 : 1); shake(soft ? .5 : 1.2); flash(soft ? '#fff' : '#b00');
    if (navigator.vibrate && !cfg.mild) try { navigator.vibrate(soft ? 80 : [120, 40, 160]); } catch (e) {}
    clearTimeout(scareFace.t); scareFace.t = setTimeout(() => { box.className = ''; }, cfg.mild ? 260 : (soft ? 320 : 520));
  }

  /* =================== 描画 =================== */
  function drawClock(x, y, r) {
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = rgb(225, 222, 208, 1 - G.tension * .25); ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.283); ctx.fill();
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = Math.max(2, r * .12); ctx.stroke();
    ctx.lineWidth = 1; for (let i = 0; i < 12; i++) { const a = i / 12 * 6.283; ctx.beginPath(); ctx.moveTo(Math.sin(a) * r * .8, -Math.cos(a) * r * .8); ctx.lineTo(Math.sin(a) * r * .92, -Math.cos(a) * r * .92); ctx.stroke(); }
    const hand = (a, l, w) => { ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.sin(a) * r * l, -Math.cos(a) * r * l); ctx.stroke(); };
    ctx.strokeStyle = '#111'; hand(55 / 180 * Math.PI, .5, r * .1); hand(300 / 180 * Math.PI, .78, r * .07);
    ctx.strokeStyle = '#a01010'; let sa = G.secA; if (G.tension > .7 && G.clock !== 'stop') sa += rnd(-.05, .05); hand(sa, .88, r * .035);
    ctx.restore();
  }
  function lightMul() { return G.lights; }

  function drawClassroom(dawn) {
    const tn = G.tension, hz = H * .47, asp = Math.min(1, W / H * 1.7);
    const wall = dawn ? [236, 206, 160] : mixc([66, 70, 66], [48, 24, 28], tn);
    const floor = dawn ? [168, 124, 90] : mixc([46, 40, 36], [30, 18, 20], tn);
    ctx.fillStyle = C(wall); ctx.fillRect(0, 0, W, hz + 2);
    let g = ctx.createLinearGradient(0, hz, 0, H); g.addColorStop(0, C(floor)); g.addColorStop(1, C(mixc(floor, [0, 0, 0], .6))); ctx.fillStyle = g; ctx.fillRect(0, hz, W, H - hz);
    ctx.strokeStyle = 'rgba(0,0,0,.22)'; ctx.lineWidth = 1;
    for (let i = -10; i <= 10; i++) { ctx.beginPath(); ctx.moveTo(W / 2 + i * W * .02, hz); ctx.lineTo(W / 2 + i * W * .24, H); ctx.stroke(); }
    const sky = dawn ? [255, 232, 178] : mixc([156, 164, 166], [136, 50, 42], clamp(tn * 1.1));
    [[.03, .17], [.83, .97]].forEach(([a, b]) => {
      const x = W * a, w = W * (b - a), y = H * .1, h = H * .3;
      ctx.fillStyle = C(sky); ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(18,18,18,.75)'; ctx.lineWidth = 3; ctx.strokeRect(x, y, w, h);
      ctx.beginPath(); ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + h); ctx.moveTo(x, y + h * .5); ctx.lineTo(x + w, y + h * .5); ctx.stroke();
    });
    ctx.fillStyle = dawn ? '#34503f' : '#1b2a24'; ctx.fillRect(W * .22, H * .13, W * .56, H * .25);
    ctx.strokeStyle = '#6a5238'; ctx.lineWidth = 5; ctx.strokeRect(W * .22, H * .13, W * .56, H * .25);
    if (!dawn) {
      ctx.fillStyle = rgb(235, 235, 225, .28 + .1 * Math.sin(G.t * 3) * tn); ctx.font = `${Math.floor(H * .07)}px "Shippori Mincho","Yu Mincho",serif`; ctx.textAlign = 'center';
      ctx.fillText(tn > .85 ? 'みんな' : '静かに', W * .5, H * .27); ctx.textAlign = 'left';
    }
    drawClock(W * .5, H * .075, H * .036);
    if (dawn) { // 差し込む朝の光
      const lg = ctx.createLinearGradient(W * .05, 0, W * .6, H); lg.addColorStop(0, 'rgba(255,236,190,.38)'); lg.addColorStop(1, 'rgba(255,236,190,0)');
      ctx.fillStyle = lg; ctx.beginPath(); ctx.moveTo(W * .03, H * .1); ctx.lineTo(W * .17, H * .1); ctx.lineTo(W * .78, H); ctx.lineTo(W * .2, H); ctx.fill();
      ctx.beginPath(); ctx.moveTo(W * .83, H * .1); ctx.lineTo(W * .97, H * .1); ctx.lineTo(W * 1.2, H); ctx.lineTo(W * .7, H); ctx.fill();
      for (let i = 0; i < 24; i++) { const px = (i * 137.5 % 100) / 100 * W, py = ((i * 61.8 + G.t * 8 * (1 + i % 3)) % 100) / 100 * H; ctx.fillStyle = 'rgba(255,245,210,.5)'; ctx.fillRect(px, py, 2, 2); }
    }
    // 机と生徒（奥→手前）
    const rowY = [.56, .63, .73, .89], rowU = [.044, .057, .074, .1], rowS = [.12, .15, .19, .24];
    const deskTop = dawn ? '#8a6a48' : C(mixc([88, 70, 52], [50, 30, 30], tn)), deskSide = dawn ? '#6a4e34' : C(mixc([54, 42, 32], [28, 16, 18], tn));
    const uni = dawn ? [60, 66, 110] : mixc([26, 32, 54], [20, 18, 30], tn);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) {
      const st = students[r * 5 + c], u = H * rowU[r] * asp, cx = W * (.5 + (c - 2) * rowS[r] * (asp < 1 ? 1.15 : 1)), yd = H * rowY[r];
      ctx.fillStyle = deskTop; ctx.fillRect(cx - 1.15 * u, yd - .05 * u, 2.3 * u, .22 * u);
      ctx.fillStyle = deskSide; ctx.fillRect(cx - 1.05 * u, yd + .17 * u, 2.1 * u, .85 * u);
      if (dawn) continue;
      if (r === 2 && c === 1) { ctx.fillStyle = rgb(10, 10, 12, .9); ctx.fillRect(cx - .7 * u, yd - .9 * u, 1.4 * u, .8 * u); continue; }   // 汐音の空席
      const target = G.gaze > st.th ? 1 : 0; st.turn += (target - st.turn) * (target ? .035 : .06) * (.6 + (st.th));
      const sw = Math.sin(G.t * .8 + st.sway) * .03 * u, hy = yd - 1.45 * u, hr = .52 * u;
      ctx.fillStyle = C(uni); ctx.beginPath(); ctx.ellipse(cx + sw, yd - .5 * u, .95 * u, .8 * u, 0, Math.PI, 0); ctx.fill(); ctx.fillRect(cx + sw - .95 * u, yd - .5 * u, 1.9 * u, .55 * u);
      ctx.save(); ctx.translate(cx + sw, hy);
      if (st.turn < .5) { ctx.scale(1 - st.turn * 1.2, 1); ctx.fillStyle = '#0d0d10'; ctx.beginPath(); ctx.arc(0, 0, hr, 0, 6.283); ctx.fill(); }
      else if (IMG[st.img] && IMG[st.img].complete && IMG[st.img].naturalWidth) {
        const im = IMG[st.img], ww = 1.75 * u, hh = ww * im.naturalHeight / im.naturalWidth;
        ctx.rotate(st.tilt * st.turn); ctx.scale(Math.min(1, (st.turn - .5) * 2.4), 1); ctx.globalAlpha = clamp((st.turn - .45) * 2.2) * (.55 + .12 * r);
        ctx.drawImage(im, -ww / 2, -hr * 1.15, ww, hh);
      } else { ctx.fillStyle = '#d8d4cc'; ctx.beginPath(); ctx.ellipse(0, 0, hr * .9, hr * 1.1, 0, 0, 6.283); ctx.fill(); }
      ctx.restore();
    }
    // 窓の外から差す冷たい光のムラ
    if (!dawn) { const a = .05 + .05 * Math.sin(G.t * 11) * tn; ctx.fillStyle = `rgba(0,0,0,${a})`; ctx.fillRect(0, 0, W, H); }
  }

  function drawCorridor() {
    const tn = G.tension, vx = W / 2 + Math.sin(G.t * .35) * W * .008, vy = H * .46, f = H * .95 * (W / H < .8 ? .85 : 1);
    const P = (x, y, z) => [vx + x * f / z, vy + y * f / z];
    ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, W, H);
    const XW = 1.7, YT = -1.55, YB = 1.25, SEG = 3, N = 15, off = ((G.scroll % SEG) + SEG) % SEG;
    const wallC = mixc([88, 84, 70], [60, 26, 28], tn), floorC = mixc([58, 52, 44], [36, 20, 22], tn), ceilC = mixc([74, 74, 68], [40, 24, 26], tn);
    const shade = (c, z, k = 1) => { const t = clamp(z / (26 + 12 * (1 - tn))); return C(mixc(c, [0, 0, 0], clamp(t * .95 + (1 - k)))); };
    const quad = (a, b, c, d, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...c); ctx.lineTo(...d); ctx.closePath(); ctx.fill(); };
    const stretchK = 1 + G.stretch * .6;
    for (let i = N - 1; i >= 0; i--) {
      const z0 = Math.max(.35, (i * SEG - off) * stretchK + .5), z1 = Math.max(.36, ((i + 1) * SEG - off) * stretchK + .5); if (z1 <= .4) continue;
      const zm = (z0 + z1) / 2, k = G.lights;
      quad(P(-XW, YB, z0), P(XW, YB, z0), P(XW, YB, z1), P(-XW, YB, z1), shade(floorC, zm, k));
      quad(P(-XW, YT, z0), P(XW, YT, z0), P(XW, YT, z1), P(-XW, YT, z1), shade(ceilC, zm, k));
      quad(P(-XW, YT, z0), P(-XW, YB, z0), P(-XW, YB, z1), P(-XW, YT, z1), shade(wallC, zm, k));
      quad(P(XW, YT, z0), P(XW, YB, z0), P(XW, YB, z1), P(XW, YT, z1), shade(wallC, zm, k));
      const za = z0 + (z1 - z0) * .2, zb = z0 + (z1 - z0) * .8;
      // 扉・窓
      [[-1, i % 2 === 0], [1, i % 2 === 1]].forEach(([side, door]) => {
        const x = XW * side * .995;
        if (door) {
          quad(P(x, -1.05, za), P(x, 1.25, za), P(x, 1.25, zb), P(x, -1.05, zb), shade([60, 40, 30], zm, k));
          quad(P(x, -.75, za + (zb - za) * .3), P(x, -.2, za + (zb - za) * .3), P(x, -.2, zb - (zb - za) * .3), P(x, -.75, zb - (zb - za) * .3), shade([200, 190, 160], zm, k * .5));
        } else {
          const sky = mixc([170, 120, 80], [130, 40, 50], tn);
          quad(P(x, -.8, za), P(x, .35, za), P(x, .35, zb), P(x, -.8, zb), shade(sky, zm, k));
        }
      });
      // 蛍光灯
      const fl = (i % 3 === 0 && Math.sin(G.t * 23 + i * 7) > (tn > .6 ? .2 : .9)) ? .25 : 1;
      quad(P(-.3, YT + .02, zm - .5), P(.3, YT + .02, zm - .5), P(.3, YT + .02, zm + .5), P(-.3, YT + .02, zm + .5), shade([250, 250, 230], zm, k * fl));
    }
    // 突き当たり（闇）
    const far = P(0, 0, 45 * stretchK); ctx.fillStyle = 'rgba(0,0,0,.9)'; ctx.beginPath(); ctx.arc(far[0], far[1], H * .04, 0, 6.283); ctx.fill();
    // 追ってくる影
    const n = Math.round(G.gaze * 5);
    for (let i = 0; i < n; i++) {
      const zz = Math.max(2.6, 9 + i * 2.8 - G.chase * 3 + Math.sin(G.t * .6 + i) * .5), sx = (i % 2 ? -1 : 1) * (.25 + (i * .37 % .9)) * (i === 0 ? .2 : 1), s = f / zz;
      const p = P(sx, 1.25, zz); ctx.fillStyle = rgb(8, 8, 12, .95);
      ctx.fillRect(p[0] - .38 * s, p[1] - 2.3 * s, .76 * s, 2.3 * s);
      const im = IMG[MOBS[i % MOBS.length]];
      if (im && im.complete && im.naturalWidth) { const ww = .72 * s, hh = ww * im.naturalHeight / im.naturalWidth; ctx.globalAlpha = .85; ctx.drawImage(im, p[0] - ww / 2, p[1] - 2.55 * s, ww, hh); ctx.globalAlpha = 1; }
    }
    if (G.run) G.scroll += G.run * 5.5 * G.dt;
  }

  function drawToilet() {
    const tn = G.tension, k = G.lights * (Math.sin(G.t * 31) > (tn > .6 ? .55 : .97) ? .45 : 1);
    ctx.fillStyle = C(mixc([86, 100, 104], [44, 28, 34], tn * .9)); ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1; const ts = Math.max(26, H * .05);
    for (let x = 0; x < W; x += ts) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); } for (let y = 0; y < H; y += ts) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.fillStyle = C(mixc([60, 66, 64], [30, 22, 26], tn)); ctx.fillRect(0, H * .84, W, H * .16);
    const sw = W / 5.4, y0 = H * .16, dh = H * .66;
    for (let i = 0; i < 5; i++) {
      const x = W * .04 + i * sw * 1.02, closed = i === 2, open = !closed && (G.tension > .5 || i % 2 === 0);
      ctx.fillStyle = '#04040a'; ctx.fillRect(x, y0, sw * .96, dh);               // 個室の中の闇
      if (closed) {
        ctx.fillStyle = C(mixc([112, 132, 144], [62, 44, 52], tn)); ctx.fillRect(x, y0, sw * .96, dh * .93);
        ctx.fillStyle = '#c33'; ctx.fillRect(x + sw * .4, y0 + dh * .42, sw * .1, dh * .03);
        const sh = Math.sin(G.t * 14) * 1.2; ctx.fillStyle = '#080808'; ctx.fillRect(x + sw * .3 + sh, y0 + dh * .93, sw * .13, dh * .07); ctx.fillRect(x + sw * .52 + sh, y0 + dh * .93, sw * .13, dh * .07);
      } else {
        const ang = open ? (.12 + .08 * Math.sin(G.t * .7 + i)) * (G.tension > .8 ? 2.2 : 1) : 0;
        ctx.fillStyle = C(mixc([128, 148, 160], [70, 50, 58], tn)); ctx.fillRect(x, y0, sw * .96 * (1 - ang * 2.4), dh * .93);
      }
      ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 2; ctx.strokeRect(x, y0, sw * .96, dh);
    }
    const dy = ((G.t * .9) % 2.2) / 2.2; ctx.fillStyle = 'rgba(180,200,220,.8)'; if (dy < .5) { ctx.beginPath(); ctx.ellipse(W * .93, H * .3 + dy * H * 1.0, 2.5, 4.5, 0, 0, 6.283); ctx.fill(); }
    ctx.fillStyle = `rgba(0,0,0,${(1 - k) * .75 + tn * .12})`; ctx.fillRect(0, 0, W, H);
  }

  function person(cx, by, h, col, glow, lag) {
    ctx.save(); ctx.translate(cx + (lag || 0), by); const hr = h * .13;
    ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(0, -h * .38, h * .22, h * .3, 0, Math.PI, 0); ctx.fill(); ctx.fillRect(-h * .22, -h * .38, h * .44, h * .4);
    ctx.fillStyle = '#0a0a0c'; ctx.beginPath(); ctx.ellipse(0, -h * .82, hr * 1.25, hr * 1.55, 0, 0, 6.283); ctx.fill();               // 髪
    ctx.fillRect(-hr * 1.25, -h * .82, hr * 2.5, h * .36);
    ctx.fillStyle = glow; ctx.beginPath(); ctx.ellipse(0, -h * .76, hr * .72, hr * 1, 0, 0, 6.283); ctx.fill();                           // 顔（髪の隙間）
    ctx.restore();
  }
  function drawMirror() {
    const tn = G.tension;
    ctx.fillStyle = '#07090a'; ctx.fillRect(0, 0, W, H);
    const mx = W * (W / H < .8 ? .12 : .3), mw = W - mx * 2, my = H * .06, mh = H * .68;
    ctx.fillStyle = '#2a2e2e'; ctx.fillRect(mx - 8, my - 8, mw + 16, mh + 16);
    let g = ctx.createLinearGradient(0, my, 0, my + mh); g.addColorStop(0, C(mixc([70, 90, 92], [50, 30, 36], tn))); g.addColorStop(1, C(mixc([30, 44, 46], [18, 10, 14], tn)));
    ctx.fillStyle = g; ctx.fillRect(mx, my, mw, mh);
    ctx.save(); ctx.beginPath(); ctx.rect(mx, my, mw, mh); ctx.clip();
    const lag = Math.sin(G.t * 1.7) * 14 * (.3 + tn);
    person(mx + mw * .36, my + mh, mh * .8, '#1a2038', 'rgba(210,205,200,.85)');
    person(mx + mw * .66, my + mh, mh * .84, '#0e0e14', tn > .75 ? 'rgba(235,232,228,.9)' : 'rgba(150,146,144,.6)', lag);
    if (tn > .7) { ctx.fillStyle = '#fff'; [-1, 1].forEach(s => { ctx.beginPath(); ctx.ellipse(mx + mw * .66 + s * mh * .035 + lag, my + mh - mh * .84 * .76, mh * .012, mh * .02 * (Math.sin(G.t * 3) > .96 ? .1 : 1), 0, 0, 6.283); ctx.fill(); }); }
    if (G.cracked > 0) { ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.5; const cx = mx + mw * .5, cy = my + mh * .45; for (let i = 0; i < 14; i++) { const a = i / 14 * 6.283 + .3, l = (80 + (i * 53 % 190)) * G.cracked; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * l * 1.3, cy + Math.sin(a) * l); ctx.stroke(); } }
    ctx.restore();
    ctx.fillStyle = '#3a3e3e'; ctx.fillRect(mx - 20, my + mh + 12, mw + 40, H * .06);
    ctx.fillStyle = `rgba(0,0,0,${(1 - G.lights) * .85})`; ctx.fillRect(0, 0, W, H);
  }

  const ROOMV = { kitchen: { wall: [150, 110, 70], sky: [255, 190, 120], lamp: 1 }, night: { wall: [40, 48, 78], sky: [20, 24, 50], lamp: 1.2 }, staff: { wall: [180, 178, 160], sky: [255, 170, 110], lamp: .6 } };
  function drawRoom() {
    const v = ROOMV[G.variant] || ROOMV.kitchen;
    ctx.fillStyle = C(v.wall); ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = C(v.sky); ctx.fillRect(W * .62, H * .12, W * .26, H * .34); ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 4; ctx.strokeRect(W * .62, H * .12, W * .26, H * .34);
    ctx.beginPath(); ctx.moveTo(W * .75, H * .12); ctx.lineTo(W * .75, H * .46); ctx.moveTo(W * .62, H * .29); ctx.lineTo(W * .88, H * .29); ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,.32)'; ctx.fillRect(0, H * .6, W, H * .4);
    ctx.fillStyle = '#4a3322'; ctx.fillRect(W * .08, H * .66, W * .84, H * .06); ctx.fillStyle = '#34231a'; ctx.fillRect(W * .12, H * .72, W * .76, H * .28);
    const lg = ctx.createRadialGradient(W * .3, H * .5, 4, W * .3, H * .5, H * .5 * v.lamp); lg.addColorStop(0, 'rgba(255,220,150,.55)'); lg.addColorStop(1, 'rgba(255,220,150,0)'); ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H);
    person(W * .36, H * .66, H * .52, '#241c28', 'rgba(220,200,180,.5)'); person(W * .58, H * .66, H * .4, '#1a2038', 'rgba(220,200,180,.5)');
    ctx.fillStyle = 'rgba(120,80,40,.16)'; ctx.fillRect(0, 0, W, H);
  }

  function drawEyes() {
    if (['dawn', 'room'].includes(G.bg)) { eyeList.length = 0; return; }
    const want = Math.round(G.eyes);
    while (eyeList.length < want) eyeList.push({ x: rnd(.04, .96), y: rnd(.1, .8), s: rnd(.6, 1.5), life: 0, max: rnd(3, 8), ph: rnd(0, 9) });
    for (let i = eyeList.length - 1; i >= 0; i--) {
      const e = eyeList[i]; e.life += G.dt; const a = Math.sin(clamp(e.life / e.max) * Math.PI) * .9;
      if (e.life > e.max) { eyeList.splice(i, 1); continue; }
      const bl = Math.sin(G.t * 1.3 + e.ph) > .97 ? .1 : 1, rx = H * .011 * e.s, ry = H * .005 * e.s * bl, dx = H * .03 * e.s;
      ctx.fillStyle = `rgba(255,252,235,${a})`; ctx.shadowColor = 'rgba(255,255,220,.8)'; ctx.shadowBlur = 8;
      [-1, 1].forEach(s => { ctx.beginPath(); ctx.ellipse(e.x * W + s * dx, e.y * H, rx, Math.max(.4, ry), 0, 0, 6.283); ctx.fill(); });
      ctx.shadowBlur = 0;
    }
  }

  /* =================== メインループ =================== */
  function frame(ts) {
    requestAnimationFrame(frame);
    const dt = Math.min(.05, (ts - (G.last || ts)) / 1000); G.last = ts; G.dt = dt; G.t += dt;
    G.tension += (G.tT - G.tension) * Math.min(1, dt * 1.6); G.gaze += (G.gazeT - G.gaze) * Math.min(1, dt * .9);
    G.eyes += (G.eyesT - G.eyes) * Math.min(1, dt * .8); G.lights += (G.lightsT - G.lights) * Math.min(1, dt * 3);
    G.black += (G.blackT - G.black) * Math.min(1, dt * (G.blackT ? 7 : 1.6));
    if (G.clock === 'run') { if (Math.floor(G.t) !== Math.floor(G.t - dt)) G.secA += 6 * Math.PI / 180; }
    else if (G.clock === 'back' || G.backT > 0) { G.secA -= dt * 9; G.backT -= dt; if (G.backT <= 0 && G.clock === 'back') G.clock = 'run'; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.clearRect(0, 0, W, H);
    switch (G.bg) {
      case 'classroom': drawClassroom(false); break; case 'dawn': drawClassroom(true); break;
      case 'corridor': drawCorridor(); break; case 'toilet': drawToilet(); break;
      case 'mirror': drawMirror(); break; case 'room': drawRoom(); break;
      default: ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    }
    if (G.bg !== 'toilet' && G.bg !== 'mirror') { const k = (1 - G.lights) * .85; if (k > .01) { ctx.fillStyle = `rgba(0,0,0,${k})`; ctx.fillRect(0, 0, W, H); } }
    drawEyes();
    if (window.Scene3D) Scene3D.frame(G, dt, IMG, cfg, MOBS);
    if (G.glitch > .02) {
      const n = Math.floor(3 + G.glitch * 8);
      for (let i = 0; i < n; i++) { const y = rnd(0, H), h = rnd(4, H * .07 * (.5 + G.glitch)), dx = rnd(-1, 1) * 60 * G.glitch; ctx.drawImage(cv, 0, y * dpr, W * dpr, h * dpr, dx * dpr, y * dpr, W * dpr, h * dpr); }
      ctx.fillStyle = `rgba(255,0,60,${.06 * G.glitch})`; ctx.fillRect(0, 0, W, H); G.glitch *= Math.pow(.02, dt);
    }
    // 画面効果（CSS側）
    const tn = G.tension, root = document.documentElement.style;
    root.setProperty('--ten', tn.toFixed(3));
    const beat = (Math.sin(G.t * (4 + tn * 8)) * .5 + .5);
    $('#vig').style.opacity = (G.bg === 'dawn' ? .25 : .45 + .5 * tn).toFixed(3);
    $('#redp').style.opacity = (cfg.mild ? 0 : Math.max(0, (tn - .5) * .5) * beat).toFixed(3);
    grain.style.opacity = (G.bg === 'dawn' ? .05 : .07 + .15 * tn).toFixed(3);
    if (Math.floor(ts / 60) % 2 === 0) { const id = gctx.createImageData(grain.width, grain.height), d = id.data; for (let i = 0; i < d.length; i += 4) { const v = Math.random() * 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; } gctx.putImageData(id, 0, 0); }
    $('#flash').style.opacity = G.flash.toFixed(3); G.flash *= Math.pow(.004, dt);
    $('#blackout').style.opacity = clamp(G.black).toFixed(3);
    if (G.shake > .01) { const s = G.shake * 14; app.style.transform = `translate(${rnd(-s, s).toFixed(1)}px,${rnd(-s, s).toFixed(1)}px)`; G.shake *= Math.pow(.02, dt); } else if (app.style.transform) app.style.transform = '';
  }

  return { init, setBg, set, turnAll, shake, flash, glitch, fade, reset, setSprites, dropSprites, floatWords, scareFace, G, hasSprite: k => !!SPRITES[k] };
})();

/* =====================================================================
   UI・進行（診断 → 物語 → 結末）
   ===================================================================== */
const S = { type: null, own: false, scores: { e: 0, u: 0, a: 0 }, v: {}, sceneId: null, cp: null, log: [] };
const MAXQ = (() => { const m = [0, 0, 0]; QUIZ.slice(0, -1).forEach(q => { m[0] += Math.max(...q.o.map(o => o[1])); m[1] += Math.max(...q.o.map(o => o[2])); m[2] += Math.max(...q.o.map(o => o[3])); }); return m; })();
const PROTO = { empathy: [.85, .88, .85], bystander: [.75, .6, .25], indifferent: [.15, .15, .1], knowledge: [.45, .85, .6], own: [.7, .7, .6] };
let advanceResolve = null, typingSkip = null, keyHandler = null;

function show(id) { $$('.screen').forEach(s => s.classList.toggle('on', s.id === id)); document.body.dataset.screen = id; }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- パネル（メニュー・ログなど） ---------- */
function openPanel(html, mount) {
  const p = $('#panel'); $('#panel-body').innerHTML = html + '<button class="btn ghost close" data-close>閉じる</button>';
  p.classList.add('on'); document.body.classList.add('panel-open');
  $('#panel-body').scrollTop = 0;
  $$('[data-close]', p).forEach(b => b.onclick = closePanel);
  if (mount) mount($('#panel-body'));
}
function closePanel() { $('#panel').classList.remove('on'); document.body.classList.remove('panel-open'); }

/* ---------- 効果名 → 演出 ---------- */
const FXV = {
  shake: () => Gfx.shake(.45), shakeBig: () => Gfx.shake(1),
  flash: () => Gfx.flash(),
  glitch: () => { Gfx.glitch(.8); Snd.play('static'); },
  glitchBig: () => { Gfx.glitch(1.4); Snd.play('static'); Gfx.shake(.8); },
  scare: () => { Gfx.scareFace(false); Snd.play('scare'); },
  scareSoft: () => { Gfx.scareFace(true); Snd.play('scareSoft'); },
  blackout: () => Gfx.fade('blink'), fadeout: () => Gfx.fade('out'),
  turnAll: () => Gfx.turnAll(),
  stretch: () => Gfx.set({ stretch: 1 }),
  run: () => { Gfx.set({ run: 1 }); Snd.play('steps'); },
  stopRun: () => Gfx.set({ run: 0 }),
  crack: () => { Gfx.set({ cracked: 1 }); Snd.play('crack'); },
  glass: () => { Snd.play('glass'); Gfx.shake(.9); },
  doorSlam: () => { Snd.play('doorSlam'); Gfx.shake(.4); },
  stomachBig: () => { Snd.play('stomachBig'); },
  silence: () => { Snd.play('silence'); }
};
function runFx(name) { if (FXV[name]) FXV[name](); else Snd.play(name); }
function applyEff(e) { for (const k in (e || {})) { if (typeof e[k] === 'number') S.v[k] = (S.v[k] || 0) + e[k]; else S.v[k] = e[k]; } }
function applyOpts(o) {
  if (!o) return;
  if (o.bg) Gfx.setBg(o.bg, o.var);
  if (o.t !== undefined) { Gfx.set({ tension: o.t }); Snd.setTension(o.t); }
  if ('gaze' in o) Gfx.set({ gaze: o.gaze });
  if ('eyes' in o) Gfx.set({ eyes: o.eyes });
  if ('clock' in o) Gfx.set({ clock: o.clock });
  if ('lights' in o) Gfx.set({ lights: o.lights });
  if ('sp' in o) Gfx.setSprites(o.sp);
  if (o.set) applyEff(o.set);
  if (o.fx) [].concat(o.fx).forEach(runFx);
  if (o.vox) Snd.vox(o.vox);
  if (o.whisper) { Gfx.floatWords(o.whisper, Math.min(7, o.whisper.length + 2)); if (o.whisper.length > 3) Snd.babble(.1, 2, { voices: 3 }); }
}

/* ---------- 文字送り ---------- */
function typeText(el, text, speed) {
  return pwait((res, entry) => {
    let i = 0; el.textContent = '';
    if (FAST || speed <= 0) { el.textContent = text; return res(); }
    const iv = setInterval(() => { i++; el.textContent = text.slice(0, i); if (i % 3 === 0) Snd.blip(); if (i >= text.length) { clearInterval(iv); typingSkip = null; res(); } }, speed);
    typingSkip = () => { clearInterval(iv); typingSkip = null; el.textContent = text; res(); };
    const old = entry.rej; entry.rej = e => { clearInterval(iv); typingSkip = null; old(e); };
  });
}
function waitAdvance(autoMs) {
  return pwait((res, entry) => {
    const ind = $('#ind'); ind.classList.add('on');
    const done = () => { ind.classList.remove('on'); advanceResolve = null; res(); };
    advanceResolve = done;
    if (FAST) autoMs = 15;
    if (autoMs != null) { const t = setTimeout(done, autoMs); const old = entry.rej; entry.rej = e => { clearTimeout(t); ind.classList.remove('on'); advanceResolve = null; old(e); }; }
    else { const old = entry.rej; entry.rej = e => { ind.classList.remove('on'); advanceResolve = null; old(e); }; }
  });
}
function portraitFor(who) { if (who === 'me') return S.own ? 'sio_bust' : 'hinata_bust'; const c = CHARS[who]; return c && c.portrait || null; }

async function showLine(ln) {
  const [who, text, o] = ln; const opt = o || {};
  applyOpts(opt);
  if (opt.hold) await sleep(opt.hold);
  if (!text) { if (who === 'fx') await sleep(opt.hold ? 0 : 200); return; }
  const ch = CHARS[who] || CHARS.n, box = $('#textbox'), msg = $('#msg'), nm = $('#name'), pt = $('#portrait');
  box.className = 'on ' + ch.cls + (opt.cls ? ' ' + opt.cls : '');
  nm.textContent = ch.name; nm.style.display = ch.name ? '' : 'none';
  const pk = portraitFor(who);
  if (pk && SPRITES[pk]) { pt.src = SPRITES[pk]; pt.style.display = ''; box.classList.add('has-pt'); } else { pt.style.display = 'none'; }
  const speed = opt.speed != null ? opt.speed : (opt.cls && opt.cls.includes('slow') ? 85 : (who === 'cls' || who === 'all' ? 55 : 36));
  S.log.push({ name: ch.name, text });
  { const vid = typeof LINE_VOICE !== 'undefined' && LINE_VOICE[who + '|' + text]; if (vid && LINE_HAVE.has(vid)) Snd.line(vid); else Snd.stopLine(); }
  await typeText(msg, text, speed);
  await waitAdvance(opt.auto != null ? opt.auto : null);
}

/* ---------- 選択肢 ---------- */
function askChoice(sc) {
  const all = sc.choices, vis = all.filter(c => !c.hidden && (!c.show || c.show(S)));
  const timer = typeof sc.timer === 'function' ? sc.timer(S) : (sc.timer || 0);
  return pwait((res, entry) => {
    const box = $('#choices'), bar = $('#timer'), fill = $('#timer i'); let done = false, iv = null, keyFn;
    box.innerHTML = ''; box.classList.add('on');
    const finish = (c, timedOut) => {
      if (done) return; done = true; clearInterval(iv); document.removeEventListener('keydown', keyFn);
      bar.classList.remove('on', 'hot'); box.classList.remove('on'); box.innerHTML = ''; res({ c, timedOut });
    };
    vis.forEach((c, i) => {
      const b = document.createElement('button'); b.className = 'choice'; b.innerHTML = '<span class="n"></span><span class="t"></span>';
      $('.n', b).textContent = i + 1; $('.t', b).textContent = c.t;
      b.addEventListener('click', e => { e.stopPropagation(); Snd.play('click'); finish(c, false); });
      box.appendChild(b); setTimeout(() => b.classList.add('in'), 60 + i * 110);
    });
    keyFn = e => { const n = parseInt(e.key, 10); if (n >= 1 && n <= vis.length) { Snd.play('click'); finish(vis[n - 1], false); } };
    document.addEventListener('keydown', keyFn);
    if (timer) {
      let left = timer; bar.classList.add('on'); fill.style.transition = 'none'; fill.style.width = '100%'; void fill.offsetWidth;
      fill.style.transition = `width ${timer}s linear`; fill.style.width = '0%';
      iv = setInterval(() => {
        if (document.body.classList.contains('panel-open')) return;
        left -= .25; if (left <= 3) bar.classList.add('hot'); if (Math.abs(left % 1) < .13) Snd.play('heart');
        if (left <= 0) { const tc = all.find(x => x.id === sc.timeout) || vis[vis.length - 1]; finish(tc, true); }
      }, 250);
    }
    const old = entry.rej; entry.rej = e => { done = true; clearInterval(iv); document.removeEventListener('keydown', keyFn); bar.classList.remove('on', 'hot'); box.classList.remove('on'); box.innerHTML = ''; old(e); };
  });
}

/* ---------- 呼吸ミニゲーム ---------- */
async function breathGame() {
  if (FAST) { S.v.breathOk = true; return; }
  const ov = $('#breath'), circ = $('#bcircle'), ring = $('#bring'), txt = $('#btext'), dots = $('#bdots'), skip = $('#bskip');
  ov.classList.add('on'); skip.classList.remove('on');
  const res = await pwait((resolve, entry) => {
    let p = 0, pressing = false, ph = 0, good = 0, frames = 0, ok = 0, cyc = 0, last = performance.now(), raf, tSkip, startT = last, done = false;
    const IN = 4, OUT = 6, CYC = IN + OUT;
    const down = () => { pressing = true; }, up = () => { pressing = false; };
    const kd = e => { if (e.code === 'Space') { e.preventDefault(); pressing = true; } }, ku = e => { if (e.code === 'Space') pressing = false; };
    ov.addEventListener('pointerdown', down); window.addEventListener('pointerup', up); window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
    const cleanup = () => { done = true; cancelAnimationFrame(raf); clearTimeout(tSkip); ov.removeEventListener('pointerdown', down); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); };
    skip.onclick = e => { e.stopPropagation(); cleanup(); resolve(false); };
    tSkip = setTimeout(() => skip.classList.add('on'), 22000);
    const old = entry.rej; entry.rej = e => { cleanup(); old(e); };
    function step(now) {
      if (done) return; const dt = Math.min(.05, (now - last) / 1000); last = now; ph += dt;
      const c = ph % CYC, target = c < IN ? c / IN : 1 - (c - IN) / OUT;
      p = clamp(p + (pressing ? dt / IN : -dt / OUT)); frames++; if (Math.abs(p - target) < .2) good++;
      circ.style.transform = `scale(${.45 + .55 * p})`; ring.style.transform = `scale(${.45 + .55 * target})`;
      txt.textContent = c < IN ? '吸う（長押し）' : '吐く（はなす）';
      const cur = Math.floor(ph / CYC);
      if (cur > cyc) {
        cyc = cur; const acc = good / Math.max(1, frames); if (acc > .55) ok++; good = 0; frames = 0;
        dots.textContent = '●'.repeat(Math.min(3, ok)) + '○'.repeat(3 - Math.min(3, ok));
        const tt = clamp(.62 - ok * .14); Snd.setTension(tt); Gfx.set({ tension: tt });
        if (ok >= 3) { cleanup(); return resolve(true); }
      }
      raf = requestAnimationFrame(step);
    }
    dots.textContent = '○○○'; raf = requestAnimationFrame(step);
  });
  ov.classList.remove('on'); S.v.breathOk = !!res;
}

/* ---------- 保存 ---------- */
function saveGame() { store.set('ssg_save', { id: S.sceneId, type: S.type, own: S.own, v: S.v, scores: S.scores, cp: S.cp }); }
function hasSave() { const s = store.get('ssg_save', null); return !!(s && s.id && SCENES[s.id]); }
function unlockEnding(id) { const u = store.get('ssg_end', {}); u[id] = 1; store.set('ssg_end', u); store.set('ssg_cleared', 1); }

/* ---------- シーン実行 ---------- */
async function runScene(id) {
  const sc = SCENES[id]; if (!sc) throw new Error('scene not found: ' + id);
  S.sceneId = id; if (sc.cp) S.cp = { id, v: JSON.parse(JSON.stringify(S.v)) };
  Gfx.reset(); Snd.play('unsilence'); Gfx.setSprites([]);
  if (sc.bg) Gfx.setBg(sc.bg, sc.var);
  if (window.Scene3D) Scene3D.setMode(sc.v3 || null);
  Gfx.dropSprites(['mom_bust', 'tea_bust', 'dr_bust']); // 登場人物が場面をまたいで残らないように
  Gfx.set({ tension: sc.t || 0 }); Snd.setTension(sc.t || 0); Snd.setPreset(sc.amb || 'none');
  if (sc.clock) Gfx.set({ clock: sc.clock });
  if (!sc.ending) saveGame();
  closeBoxes(false);
  const lines = typeof sc.lines === 'function' ? sc.lines(S) : (sc.lines || []);
  for (const ln of lines) await showLine(ln);
  if (sc.breath) { closeBoxes(true); await breathGame(); }
  if (sc.ending) { closeBoxes(true); return await showEnding(sc.ending); }
  if (sc.choices) {
    const { c, timedOut } = await askChoice(sc);
    if (timedOut && sc.timeoutLine) await showLine(['n', sc.timeoutLine, { auto: 1100 }]);
    applyEff(c.eff); return c.next;
  }
  return sc.go ? sc.go(S) : sc.next;
}
function closeBoxes(hide) { if (hide) $('#textbox').className = ''; }

let playing = false;
async function play(startId) {
  cancelAll(); const my = GEN; playing = true; show('s-game'); closeBoxes(true);
  let id = startId;
  try {
    while (id && my === GEN) {
      const r = await runScene(id);
      if (r && typeof r === 'object') {
        if (r.action === 'retry' && S.cp) { S.v = JSON.parse(JSON.stringify(S.cp.v)); id = S.cp.id; continue; }
        if (r.action === 'route') { openRouteChooser(); return; }
        goTitle(); return;
      }
      id = r;
    }
  } catch (e) { if (e !== CANCEL) { console.error(e); showError(e); } }
}
function showError(e) { openPanel(`<h2>エラー</h2><p>${esc(e && e.message || e)}</p><p>タイトルに戻ってもう一度お試しください。</p><button class="btn" id="err-title">タイトルへ</button>`, b => $('#err-title', b).onclick = () => { closePanel(); goTitle(); }); }

/* ---------- 結末 ---------- */
function reflection(kind) {
  const T = TYPES[S.type] || TYPES.bystander;
  if (S.type === 'own') return 'あなたの経験が、この物語を動かしました。伝えること、頼ることは、弱さではありません。';
  if (kind === 'true' || kind === 'good') return `あなたは最初、${T.tend}。しかし、最後には彼女の声に耳を傾けられました。`;
  return `あなたは最初、${T.tend}。そして最後まで、彼女の声に耳を傾けきれませんでした。——でも、これは物語。やり直せます。`;
}
function axesOf() {
  const sc = S.scores || {}; let r = [(sc.e || 0) / MAXQ[0], (sc.u || 0) / MAXQ[1], (sc.a || 0) / MAXQ[2]];
  if (!sc.fromQuiz) r = PROTO[S.type] || r; return r.map(x => clamp(x));
}
function showEnding(id) {
  const E = ENDINGS[id]; unlockEnding(id); store.del('ssg_save');
  const T = TYPES[S.type] || TYPES.bystander, ax = axesOf(), got = Object.keys(store.get('ssg_end', {})).length;
  const el = $('#s-end');
  el.innerHTML = `<div class="end-card ${E.kind}">
    <p class="tag">${esc(E.tag)}</p><h2>${esc(E.title)}</h2><p class="sum">${esc(E.summary)}</p>
    <div class="result"><h3>診断結果</h3>
      <p class="type">${esc(T.name)}<small>${esc(T.short)}</small></p>
      ${[['共感性', '他人の苦しみを想像する力'], ['理解姿勢', '知らないことを知ろうとする姿勢'], ['行動性', '理解したことを行動に移せるか']].map((a, i) => `<div class="axis"><span>${a[0]}<small>${a[1]}</small></span><b><i style="width:${Math.round(ax[i] * 100)}%"></i></b></div>`).join('')}
      <p class="refl">${esc(reflection(E.kind))}</p>
    </div>
    <p class="learn">${esc(E.learn)}</p>
    <p class="count">エンディング ${got} / ${ENDING_ORDER.length}</p>
    <div class="btns">
      ${E.retry && S.cp ? '<button class="btn" data-a="retry">直前の分岐からやり直す</button>' : ''}
      <button class="btn" data-a="route">別の物語を体験する</button>
      <button class="btn ghost" data-a="about">IBSについて・相談先</button>
      <button class="btn ghost" data-a="title">タイトルへ</button>
    </div></div>`;
  el.dataset.kind = E.kind; show('s-end'); Snd.setPreset(E.kind === 'bad' ? 'quiet' : 'dawn'); Gfx.fade('in'); Gfx.reset();
  el.scrollTop = 0;
  return pwait((res, entry) => {
    $$('[data-a]', el).forEach(b => b.onclick = () => {
      const a = b.dataset.a; if (a === 'about') return openAbout();
      res({ action: a });
    });
  });
}

/* ---------- タイトル・診断 ---------- */
function goTitle() {
  cancelAll(); playing = false; closePanel(); show('s-title'); if (window.Scene3D) Scene3D.setMode(null); Gfx.setSprites([]); Gfx.reset(); Gfx.setBg('classroom'); Gfx.set({ tension: .18, gaze: 0, eyes: 0, lights: 'on', clock: 'run' });
  Snd.setTension(.18); Snd.setPreset('class'); $('#btn-continue').style.display = hasSave() ? '' : 'none';
  $('#textbox').className = ''; $('#choices').classList.remove('on'); $('#breath').classList.remove('on');
}
let qi = 0;
function startQuiz() {
  S.scores = { e: 0, u: 0, a: 0, fromQuiz: true }; S.own = false; S.type = null; qi = 0;
  show('s-quiz'); Gfx.setBg('classroom'); Snd.setPreset('class'); renderQ();
}
function renderQ() {
  const q = QUIZ[qi], t = .14 + qi * .028; Gfx.set({ tension: t }); Snd.setTension(t);
  $('#quiz-prog').textContent = `診断質問　${qi + 1} / ${QUIZ.length}`; $('#quiz-bar i').style.width = ((qi) / QUIZ.length * 100) + '%';
  $('#quiz-q').textContent = q.q; $('#quiz-sub').textContent = q.sub;
  const box = $('#quiz-opts'); box.innerHTML = '';
  q.o.forEach(o => {
    const b = document.createElement('button'); b.className = 'opt'; b.textContent = o[0];
    b.onclick = () => { if (box.dataset.lock) return; box.dataset.lock = 1; b.classList.add('sel'); Snd.play('click'); S.scores.e += o[1]; S.scores.u += o[2]; S.scores.a += o[3]; if (o[4] === 'own') S.own = true; setTimeout(() => { delete box.dataset.lock; qi++; if (qi < QUIZ.length) renderQ(); else finishQuiz(); }, 420); };
    box.appendChild(b);
  });
  const card = $('#quiz-card'); card.classList.remove('in'); void card.offsetWidth; card.classList.add('in');
}
function finishQuiz() {
  S.type = S.own ? 'own' : classify(S.scores.e / MAXQ[0], S.scores.u / MAXQ[1], S.scores.a / MAXQ[2]);
  startStory();
}
function startStory(type) {
  if (type) { S.type = type; S.own = type === 'own'; S.scores = { e: 0, u: 0, a: 0 }; }
  S.v = { kind: 0, harm: 0, watch: 0, hope: 0, despair: 0 }; S.cp = null; S.log = [];
  Gfx.setBg('black'); play('intro');
}

/* ---------- パネル各種 ---------- */
function openAbout() {
  openPanel($('#tpl-about').innerHTML);
}
function openGallery() {
  const u = store.get('ssg_end', {});
  openPanel(`<h2>エンディング一覧</h2><div class="gal">${ENDING_ORDER.map(k => { const E = ENDINGS[k], on = u[k]; return `<div class="gal-i ${on ? 'on' : ''} ${E.kind}"><b>${on ? esc(E.title) : '？？？'}</b><small>${esc(E.tag)}</small><p>${on ? esc(E.summary) : '未到達'}</p></div>`; }).join('')}</div>`);
}
function openSettings() {
  openPanel(`<h2>設定</h2>
    <label class="row">音量<input type="range" id="set-vol" min="0" max="1" step=".05" value="${cfg.vol}"></label>
    <label class="row chk"><input type="checkbox" id="set-mild" ${cfg.mild ? 'checked' : ''}> マイルドモード（光の点滅・強い揺れ・大音量を弱める）</label>
    <label class="row chk"><input type="checkbox" id="set-blip" ${cfg.blip ? 'checked' : ''}> 文字送りの小さな音</label>`, b => {
    $('#set-vol', b).oninput = e => { Snd.setVolume(+e.target.value); saveCfg(); };
    $('#set-mild', b).onchange = e => { cfg.mild = e.target.checked; saveCfg(); };
    $('#set-blip', b).onchange = e => { cfg.blip = e.target.checked; saveCfg(); };
  });
}
function openVoiceCheck() {
  const names = { sio: '汐音（仮）', koh: '小春（仮）', hinata: '日向（仮）', mob: 'モブ（eerie voices）' };
  openPanel(`<h2>ボイス確認</h2><p class="note">ファイル名がランダムだったため、声の高さで仮に振り分けています。違うキャラのところにあれば、story.js の VOICE_CAST でファイル名を入れ替えてください。</p>` +
    Object.entries(VOICE_CAST).map(([k, list]) => `<h3>${names[k] || k}</h3><div class="vgrid">${list.map(id => `<button class="vbtn" data-id="${id}">▶ ${id}</button>`).join('')}</div>`).join(''), b => {
    let cur = null; $$('.vbtn', b).forEach(btn => btn.onclick = () => { if (cur) cur.pause(); cur = new Audio(VOICE_DIR + btn.dataset.id + '.wav'); cur.play().catch(() => {}); });
  });
}
function openRouteChooser() {
  const cleared = store.get('ssg_cleared', 0);
  openPanel(`<h2>どの物語を体験する？</h2><p class="note">診断の結果とは別に、好きな始まり方を選べます。</p><div class="routes">${['empathy', 'bystander', 'indifferent', 'knowledge', 'own'].map(k => `<button class="route" data-t="${k}"><b>${esc(TYPES[k].name)}</b><small>${esc(TYPES[k].short)}</small></button>`).join('')}</div><button class="btn" id="re-quiz">診断をやり直す</button>`, b => {
    $$('.route', b).forEach(r => r.onclick = () => { closePanel(); startStory(r.dataset.t); });
    $('#re-quiz', b).onclick = () => { closePanel(); startQuiz(); };
  });
}
function openMenu() {
  openPanel(`<h2>メニュー</h2><div class="menu">
    <button class="btn" data-m="log">これまでの会話</button><button class="btn" data-m="set">設定</button>
    <button class="btn" data-m="about">IBSについて・相談先</button><button class="btn" data-m="voice">ボイス確認</button>
    <button class="btn ghost" data-m="title">タイトルへ戻る</button></div>`, b => {
    $$('[data-m]', b).forEach(x => x.onclick = () => { const m = x.dataset.m; if (m === 'log') openLog(); else if (m === 'set') openSettings(); else if (m === 'about') openAbout(); else if (m === 'voice') openVoiceCheck(); else goTitle(); });
  });
}
function openLog() { openPanel(`<h2>これまでの会話</h2><div class="log">${S.log.slice(-60).map(l => `<p>${l.name ? `<b>${esc(l.name)}</b>` : ''}${esc(l.text)}</p>`).join('') || '<p>まだありません</p>'}</div>`, b => { const l = $('.log', b); l.scrollTop = l.scrollHeight; }); }

/* ---------- 起動 ---------- */
function init() {
  Gfx.init();
  document.addEventListener('pointerdown', () => { Snd.unlock(); }, { passive: true });
  $('#s-game').addEventListener('pointerdown', e => {
    if (e.target.closest('#hud,#choices,#breath,.choice')) return;
    if (typingSkip) typingSkip(); else if (advanceResolve) advanceResolve();
  });
  document.addEventListener('keydown', e => {
    if (document.body.classList.contains('panel-open')) { if (e.key === 'Escape') closePanel(); return; }
    if (document.body.dataset.screen !== 's-game') return;
    if (['Enter', ' ', 'ArrowRight'].includes(e.key) && !$('#breath').classList.contains('on')) { e.preventDefault(); if (typingSkip) typingSkip(); else if (advanceResolve) advanceResolve(); }
  });
  $('#btn-menu').onclick = e => { e.stopPropagation(); openMenu(); };
  $('#btn-log').onclick = e => { e.stopPropagation(); openLog(); };
  $('#btn-start').onclick = () => { Snd.unlock(); show('s-warn'); $('#opt-mild').checked = cfg.mild; $('#opt-vol').value = cfg.vol; };
  $('#btn-continue').onclick = () => {
    Snd.unlock(); const s = store.get('ssg_save', null); if (!s) return;
    S.type = s.type; S.own = s.own; S.v = s.v || {}; S.scores = s.scores || S.scores; S.cp = s.cp || null; S.log = []; Gfx.setBg('black'); play(s.id);
  };
  $('#btn-endings').onclick = openGallery; $('#btn-about').onclick = openAbout; $('#btn-settings').onclick = openSettings; $('#btn-voice').onclick = openVoiceCheck;
  $('#btn-agree').onclick = () => { cfg.mild = $('#opt-mild').checked; cfg.vol = +$('#opt-vol').value; saveCfg(); Snd.unlock(); Snd.setVolume(cfg.vol); startQuiz(); };
  $('#opt-vol').oninput = e => { Snd.unlock(); Snd.setVolume(+e.target.value); };
  $('#btn-warn-back').onclick = goTitle;
  $('#panel').addEventListener('pointerdown', e => { if (e.target.id === 'panel') closePanel(); });
  window.__ssg = { S, SCENES, play, Gfx, Snd, startStory, goTitle };
  goTitle();
  // 開発用: ?jump=シーンID&type=empathy
  if (qs.get('jump')) { S.type = qs.get('type') || 'empathy'; S.own = S.type === 'own'; S.v = { kind: 0, harm: 0, watch: 0, hope: 0, despair: 0 }; S.scores = { e: 0, u: 0, a: 0 }; play(qs.get('jump')); }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

})();
