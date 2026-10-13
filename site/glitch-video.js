// GlitchVideo: plays an MPEG-4 Part 2 mp4 on a canvas through mpeg4-glitch.wasm, a
// deliberately glitchable decoder (tools/mpeg4-glitch), so the picture smears and melts
// datamosh style, in bursts, with now and then a clean heal.
//
//   const v = GlitchVideo.create(canvas, { src: 'header-4d.mp4', wasm: 'mpeg4-glitch.wasm', intensity: 0.7 });
//   v.ready.then(ok => { ... });         // true once the first frame is drawn, false on any failure
//   v.play(); v.pause(); v.setIntensity(0.4); v.destroy();
//
// The canvas gets the video's size (scale it with CSS, e.g. object-fit: cover). It stays
// transparent until the first frame, and on any failure (fetch, wasm, unsupported stream) it
// simply stays transparent: create() never throws and ready never rejects.
// Decoding runs in a Web Worker drawing into an OffscreenCanvas where available, else on the
// main thread. It pauses while the canvas is off screen or the tab is hidden; with
// prefers-reduced-motion it draws one clean frame and never animates.
(function (root) {
  'use strict';

  // Everything a decoder thread needs. Stringified into the worker, so it must stay
  // self-contained (no references to the enclosing scope).
  function shared() {
    // ---- MP4 demuxer: the first video track's sample table and esds decoder config ----
    function demux(buf) {
      const d = new DataView(buf), n = buf.byteLength, u8 = new Uint8Array(buf);
      const u32 = o => d.getUint32(o), u16 = o => d.getUint16(o);
      const fourcc = o => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
      function boxes(s, e) {
        const out = [];
        e = Math.min(e, n);
        for (let p = s; p + 8 <= e;) {
          let size = u32(p), hdr = 8;
          if (size === 1) { size = u32(p + 8) * 4294967296 + u32(p + 12); hdr = 16; }
          else if (size === 0) size = e - p;
          if (size < hdr || p + size > e) break;
          out.push({ type: fourcc(p + 4), s: p + hdr, e: p + size });
          p += size;
        }
        return out;
      }
      const find = (s, e, t) => boxes(s, e).find(b => b.type === t);
      function descLen(st) {
        let v = 0;
        for (let i = 0; i < 4; i++) { const b = u8[st.p++]; v = (v << 7) | (b & 0x7f); if (!(b & 0x80)) break; }
        return v;
      }
      function esdsConfig(b) {
        const st = { p: b.s + 4 };
        while (st.p < b.e) {
          const tag = u8[st.p++], len = descLen(st);
          if (tag === 3) {
            const flags = u8[st.p + 2]; st.p += 3;
            if (flags & 0x80) st.p += 2;
            if (flags & 0x40) st.p += 1 + u8[st.p];
            if (flags & 0x20) st.p += 2;
          } else if (tag === 4) st.p += 13;
          else if (tag === 5) return u8.slice(st.p, st.p + len);
          else st.p += len;
        }
        return null;
      }
      const moov = find(0, n, 'moov');
      if (!moov) return null;
      for (const trak of boxes(moov.s, moov.e)) {
        if (trak.type !== 'trak') continue;
        const mdia = find(trak.s, trak.e, 'mdia'); if (!mdia) continue;
        const hdlr = find(mdia.s, mdia.e, 'hdlr');
        if (!hdlr || fourcc(hdlr.s + 8) !== 'vide') continue;
        const mdhd = find(mdia.s, mdia.e, 'mdhd');
        const timescale = mdhd ? u32(mdhd.s + (u8[mdhd.s] === 1 ? 20 : 12)) : 24;
        const minf = find(mdia.s, mdia.e, 'minf'), stbl = minf && find(minf.s, minf.e, 'stbl');
        if (!stbl) return null;
        const stsd = find(stbl.s, stbl.e, 'stsd'), es = stsd.s + 8;
        const codec = fourcc(es + 4), width = u16(es + 32), height = u16(es + 34);
        const esds = find(es + 86, Math.min(es + u32(es), stsd.e), 'esds');
        const config = esds ? esdsConfig(esds) : null;
        const stsz = find(stbl.s, stbl.e, 'stsz'), fixed = u32(stsz.s + 4), count = u32(stsz.s + 8);
        const sizes = new Array(count);
        for (let i = 0; i < count; i++) sizes[i] = fixed || u32(stsz.s + 12 + 4 * i);
        const stsc = find(stbl.s, stbl.e, 'stsc'), runs = [];
        for (let i = 0, m = u32(stsc.s + 4); i < m; i++) runs.push([u32(stsc.s + 8 + 12 * i), u32(stsc.s + 12 + 12 * i)]);
        const chunks = [], stco = find(stbl.s, stbl.e, 'stco'), co64 = find(stbl.s, stbl.e, 'co64');
        if (stco) for (let i = 0, m = u32(stco.s + 4); i < m; i++) chunks.push(u32(stco.s + 8 + 4 * i));
        else if (co64) for (let i = 0, m = u32(co64.s + 4); i < m; i++) chunks.push(u32(co64.s + 8 + 8 * i) * 4294967296 + u32(co64.s + 12 + 8 * i));
        let keys = null;
        const stss = find(stbl.s, stbl.e, 'stss');
        if (stss) { keys = new Set(); for (let i = 0, m = u32(stss.s + 4); i < m; i++) keys.add(u32(stss.s + 8 + 4 * i)); }
        const stts = find(stbl.s, stbl.e, 'stts');
        const delta = stts && u32(stts.s + 4) ? u32(stts.s + 12) : 0;
        const samples = [];
        for (let c = 0, si = 0; c < chunks.length; c++) {
          let per = 0;
          for (const r of runs) if (r[0] <= c + 1) per = r[1];
          for (let k = 0, o = chunks[c]; k < per && si < count; k++, si++) {
            if (o + sizes[si] <= n) samples.push({ off: o, size: sizes[si], key: keys ? keys.has(si + 1) : true });
            o += sizes[si];
          }
        }
        return { codec, width, height, config, samples, fps: delta ? timescale / delta : 24 };
      }
      return null;
    }

    // ---- the wasm decoder, fed one sample per displayed frame ----
    class Core {
      static async create(wasm, mp4, opts) {
        const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
        const x = (await WebAssembly.instantiate(module, {})).exports;
        const track = demux(mp4);
        if (!track || !track.samples.length) throw new Error('no video track');
        const c = new Core(x, mp4, track);
        let rc = track.config && track.config.length ? c.configure(track.config) : 1;
        if (rc !== 0) rc = c.configure(c.sample(0));          // VOL in-band instead
        if (rc !== 0) throw new Error('unsupported stream (' + rc + ')');
        c.w = x.mg_width(c.p); c.h = x.mg_height(c.p);
        if (!c.w || !c.h) throw new Error('no picture size');
        c.setIntensity(opts.intensity);
        x.mg_set_seed(c.p, opts.seed >>> 0);
        return c;
      }
      constructor(x, mp4, track) {
        this.x = x; this.mp4 = mp4; this.track = track; this.p = x.mg_new(); this.i = 0; this.errors = 0;
        this.fps = track.fps > 1 && track.fps < 121 ? track.fps : 24;
      }
      sample(i) { const s = this.track.samples[i]; return new Uint8Array(this.mp4, s.off, s.size); }
      write(bytes) {
        const ptr = this.x.mg_input(this.p, bytes.length);       // may grow memory: view after
        new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
      }
      configure(bytes) { this.write(bytes); return this.x.mg_configure(this.p, bytes.length); }
      // decode the next n samples (looping); clean = no glitches
      step(n, clean) {
        const ss = this.track.samples;
        for (let k = 0; k < n; k++) {
          const s = ss[this.i];
          this.write(this.sample(this.i));
          const st = this.x.mg_decode(this.p, s.size, this.i, (s.key ? 1 : 0) | (clean ? 2 : 0));
          if (st & 2) this.errors++;
          this.i = (this.i + 1) % ss.length;
        }
      }
      rgba() {
        const ptr = this.x.mg_rgba(this.p);
        return new Uint8ClampedArray(this.x.memory.buffer, ptr, this.w * this.h * 4);
      }
      setIntensity(v) { this.x.mg_set_intensity(this.p, Math.max(0, Math.min(1, +v || 0))); }
      trigger(kind) { this.x.mg_trigger(this.p, kind | 0); }
      state() { return this.x.mg_state(this.p); }
      free() { if (this.p) this.x.mg_free(this.p); this.p = 0; }
    }

    // ---- worker side: decode + convert + draw into a transferred OffscreenCanvas ----
    function workerMain(scope) {
      let core = null, ctx = null;
      scope.onmessage = async e => {
        const m = e.data;
        try {
          if (m.type === 'ping') scope.postMessage({ type: 'pong' });
          else if (m.type === 'init') {
            core = await Core.create(m.wasm, m.mp4, m.opts);
            m.canvas.width = core.w; m.canvas.height = core.h;
            ctx = m.canvas.getContext('2d');
            scope.postMessage({ type: 'ready', w: core.w, h: core.h, fps: core.fps });
          } else if (m.type === 'step' && core) {
            const t0 = performance.now();
            core.step(m.n, m.clean);
            const t1 = performance.now();
            const px = core.rgba();
            const t2 = performance.now();
            ctx.putImageData(new ImageData(px, core.w, core.h), 0, 0);
            const t3 = performance.now();
            scope.postMessage({ type: 'done', decode: t1 - t0, convert: t2 - t1, draw: t3 - t2, n: m.n, state: core.state(), errors: core.errors });
          } else if (m.type === 'intensity' && core) core.setIntensity(m.v);
          else if (m.type === 'trigger' && core) core.trigger(m.kind);
          else if (m.type === 'close') { if (core) core.free(); core = null; scope.close(); }
        } catch (err) {
          scope.postMessage({ type: 'fail', error: String(err && err.message || err) });
        }
      };
    }
    return { demux, Core, workerMain };
  }

  const { Core } = shared();
  let workerURL = null;
  function makeWorker() {
    if (!workerURL) {
      const src = '(' + shared.toString() + ')().workerMain(self);';
      workerURL = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    }
    return new Worker(workerURL);
  }
  function waitFor(worker, type, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { cleanup(); reject(new Error('worker timeout')); }, ms);
      const on = e => {
        if (e.data.type === type) { cleanup(); resolve(e.data); }
        else if (e.data.type === 'fail') { cleanup(); reject(new Error(e.data.error)); }
      };
      const err = e => { cleanup(); reject(e.error || new Error('worker error')); };
      function cleanup() { clearTimeout(t); worker.removeEventListener('message', on); worker.removeEventListener('error', err); }
      worker.addEventListener('message', on);
      worker.addEventListener('error', err);
    });
  }
  async function fetchBuf(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
    return r.arrayBuffer();
  }

  function create(canvas, options) {
    const o = Object.assign({
      src: 'header-4d.mp4', wasm: 'mpeg4-glitch.wasm', intensity: 0.7,
      seed: (Math.random() * 4294967296) >>> 0, worker: true, autoplay: true, still: 0,
      pauseHidden: true,                                // false: keep playing in a hidden tab (testing)
    }, options || {});
    const reduce = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    let core = null, worker = null, ctx = null, destroyed = false, ready = false;
    let playing = !!o.autoplay, onScreen = true, raf = 0, last = 0, acc = 0, busy = false;
    let frameMs = 1000 / 24, io = null;
    const stats = { backend: '', decode: 0, convert: 0, draw: 0, fps: 0, state: 0, errors: 0, frames: 0 };
    let fpsCount = 0, fpsT = 0;
    const ctl = {
      stats, onstats: null,
      debug() { return { ready, playing, onScreen, raf, busy, acc, hidden: document.hidden, reduce }; },
      advance(n) { if (ready && !busy && !destroyed) step(Math.max(1, n | 0)); },   // testing: decode n frames now
      play() { playing = true; update(); },
      pause() { playing = false; update(); },
      setIntensity(v) {
        o.intensity = Math.max(0, Math.min(1, +v || 0));
        if (worker) worker.postMessage({ type: 'intensity', v: o.intensity });
        else if (core) core.setIntensity(o.intensity);
      },
      trigger(kind) {                                   // start burst 1..8 now (testing)
        if (worker) worker.postMessage({ type: 'trigger', kind });
        else if (core) core.trigger(kind);
      },
      destroy() {
        destroyed = true; update();
        if (io) io.disconnect();
        document.removeEventListener('visibilitychange', update);
        if (worker) { worker.postMessage({ type: 'close' }); worker = null; }
        if (core) { core.free(); core = null; }
      },
    };

    function smooth(key, v) { stats[key] = stats[key] ? stats[key] * 0.9 + v * 0.1 : v; }
    function report(d) {                              // decode is per frame; convert and draw per drawn frame
      smooth('decode', d.decode / d.n); smooth('convert', d.convert); smooth('draw', d.draw);
      stats.state = d.state; stats.errors = d.errors; stats.frames += d.n;
      fpsCount += d.n;
      const now = performance.now();
      if (now - fpsT >= 1000) { stats.fps = fpsCount * 1000 / (now - fpsT); fpsCount = 0; fpsT = now; }
      if (ctl.onstats) try { ctl.onstats(stats); } catch (e) { /* ignore */ }
    }
    function drawMain(n, clean) {
      const t0 = performance.now();
      core.step(n, clean);
      const t1 = performance.now();
      const px = core.rgba();
      const t2 = performance.now();
      ctx.putImageData(new ImageData(px, core.w, core.h), 0, 0);
      const t3 = performance.now();
      report({ decode: t1 - t0, convert: t2 - t1, draw: t3 - t2, n, state: core.state(), errors: core.errors });
    }
    function step(n) {
      if (worker) { busy = true; worker.postMessage({ type: 'step', n }); }
      else if (core) drawMain(n, false);
    }
    function tick(now) {
      raf = requestAnimationFrame(tick);
      if (!last) { last = now; return; }
      let dt = now - last; last = now;
      if (dt > 250) dt = frameMs;                       // after a stall, don't race to catch up
      acc = Math.min(acc + dt, frameMs * 4);
      if (busy || acc < frameMs) return;
      const n = Math.min(3, Math.floor(acc / frameMs));
      acc -= n * frameMs;
      step(n);
    }
    function update() {
      const run = ready && playing && onScreen && !(o.pauseHidden && document.hidden) && !destroyed && !reduce;
      if (run && !raf) { last = 0; acc = 0; fpsT = performance.now(); fpsCount = 0; raf = requestAnimationFrame(tick); }
      else if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
    }

    async function start() {
      const alive = () => { if (destroyed) throw new Error('destroyed'); };
      const [wasmBuf, mp4] = await Promise.all([fetchBuf(o.wasm), fetchBuf(o.src)]);
      alive();
      const module = await WebAssembly.compile(wasmBuf);
      alive();
      // validate (and size the canvas) on this thread first: a canvas handed to a worker
      // can never be drawn from here again
      core = await Core.create(module, mp4, o);
      alive();
      frameMs = 1000 / core.fps;
      canvas.width = core.w; canvas.height = core.h;
      if (reduce) {
        ctx = canvas.getContext('2d');
        const k = Math.max(0, Math.min(core.track.samples.length - 1, o.still | 0));
        core.step(k + 1, true);
        ctx.putImageData(new ImageData(core.rgba(), core.w, core.h), 0, 0);
        stats.backend = 'still';
        return;
      }
      if (o.worker && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && canvas.transferControlToOffscreen) {
        let w = null;
        try {
          w = makeWorker();
          w.postMessage({ type: 'ping' });
          await waitFor(w, 'pong', 3000);
        } catch (e) { if (w) w.terminate(); w = null; }
        if (destroyed && w) w.terminate();
        alive();
        if (w) {
          const off = canvas.transferControlToOffscreen();
          worker = w;
          w.postMessage({ type: 'init', canvas: off, wasm: module, mp4, opts: { intensity: o.intensity, seed: o.seed } }, [off, mp4]);
          await waitFor(w, 'ready', 10000);
          alive();
          core.free(); core = null;
          worker.addEventListener('message', e => {
            if (e.data.type === 'done') { busy = false; report(e.data); }
            else if (e.data.type === 'fail') { busy = false; }
          });
          stats.backend = 'worker';
          worker.postMessage({ type: 'intensity', v: o.intensity });   // in case it changed meanwhile
          worker.postMessage({ type: 'step', n: 1, clean: true });   // first frame now
          busy = true;
          return;
        }
      }
      ctx = canvas.getContext('2d');
      drawMain(1, true);
      stats.backend = 'main';
    }

    ctl.ready = start().then(() => {
      if (destroyed) return false;
      ready = true;
      if (typeof IntersectionObserver !== 'undefined') {
        io = new IntersectionObserver(es => { onScreen = es[es.length - 1].isIntersecting; update(); });
        io.observe(canvas);
      }
      document.addEventListener('visibilitychange', update);
      update();
      return true;
    }, err => {
      if (!destroyed && root.console) console.warn('GlitchVideo:', err && err.message || err);
      if (worker) { worker.terminate(); worker = null; }
      if (core) { core.free(); core = null; }
      return false;
    });
    return ctl;
  }

  root.GlitchVideo = { create, demux: shared().demux, Core };
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);
