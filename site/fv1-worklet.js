// The FV-1 player on the audio thread: the input loop, the clock for _clk effects, the emulated
// chip (spinfv1 as WebAssembly) and the module's dry/wet crossfade, 128 frames at a time.
// Running here, off the page's main thread, drawing and scrolling can't starve the audio.

class Fv1Engine {
  constructor(bytes, rate) {
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    this.x = instance.exports; this.e = this.x.fv1_new(rate); this.block = this.x.fv1_block(); this.buf = null; this.views();
  }
  views() {
    if (this.buf === this.x.memory.buffer) return;
    this.buf = this.x.memory.buffer;
    this.inp = new Float32Array(this.buf, this.x.fv1_in_ptr(this.e), 2 * this.block);
    this.out = new Float32Array(this.buf, this.x.fv1_out_ptr(this.e), 2 * this.block);
  }
  load(bytes) {                                   // UTF-8 source bytes (worklets have no TextEncoder)
    const ptr = this.x.fv1_scratch(this.e, bytes.length);
    new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
    const n = this.x.fv1_assemble(this.e);
    this.views();
    if (n) throw new Error(String.fromCharCode(...new Uint8Array(this.x.memory.buffer, this.x.fv1_error_ptr(this.e), n)));
  }
  setPot(i, v) { this.x.fv1_set_pot(this.e, i, v); }
  process(inL, inR, outL, outR, n) {
    this.views();
    this.inp.set(inL.subarray(0, n), 0);
    this.inp.set(inR.subarray(0, n), this.block);
    this.x.fv1_process(this.e, n);
    outL.set(this.out.subarray(0, n));
    outR.set(this.out.subarray(this.block, this.block + n));
  }
}

class Fv1Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this.eng = null; this.L = null; this.R = null; this.playing = false;
    this.clocked = false; this.clockSamples = 12000; this.mul = 1; this.frame = 0;
    this.mix = 1; this.g = 1;
    const N = 128;
    this.inL = new Float32Array(N); this.inR = new Float32Array(N); this.dL = new Float32Array(N); this.dR = new Float32Array(N);
    this.oL = new Float32Array(N); this.oR = new Float32Array(N);
    this.port.onmessage = e => this.message(e.data);
  }
  message(m) {
    try {
      if (m.type === 'wasm') this.eng = new Fv1Engine(m.bytes, sampleRate);
      // a new loop plays from the same position in the bar: one transport and one clock, like a
      // sequencer and an effect on the same master clock (all loops are 8 s, 4 bars at 120 BPM)
      else if (m.type === 'loop') { this.L = m.L; this.R = m.R; }
      else if (m.type === 'load') {
        m.pots.forEach((v, i) => this.eng.setPot(i, v));
        this.eng.load(m.src);                          // bytes                      // a fresh chip, as on a slot change
        this.clocked = m.clk; this.clockSamples = m.clockSeconds * sampleRate; this.mul = m.mul;
        this.mix = this.g = m.mix; this.frame = 0; this.playing = true;   // a new effect starts the transport at bar 1
        this.port.postMessage({ type: 'loaded' });
      }
      else if (m.type === 'pot') this.eng.setPot(m.i, m.v);
      else if (m.type === 'mix') this.mix = m.v;
      else if (m.type === 'rate') this.mul = m.mul;
      else if (m.type === 'stop') this.playing = false;
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  }
  process(inputs, outputs) {
    const out = outputs[0], outL = out[0], outR = out[1] || out[0], n = outL.length;
    if (!this.playing || !this.eng || !this.L) { outL.fill(0); if (outR !== outL) outR.fill(0); return true; }
    const L = this.L, R = this.R, len = L.length, ticks = this.mul / this.clockSamples;
    for (let i = 0; i < n; i++) {
      const k = (this.frame + i) % len;            // the transport: position in the 4-bar loop
      if (this.clocked) {                          // _clk: mono audio on L, a square clock on R; dry never carries the clock
        const mono = 0.5 * (L[k] + R[k]);
        this.inL[i] = this.dL[i] = this.dR[i] = mono;
        // the clock is a division of the transport, not a free oscillator: every tick lands on the
        // same sample of the bar at x1, x2 or x4, and the loop's first sample is always a rising edge
        this.inR[i] = (k * ticks) % 1 < 0.5 ? 0.5 : -0.5;
      } else { this.inL[i] = this.dL[i] = L[k]; this.inR[i] = this.dR[i] = R[k]; }
    }
    this.eng.process(this.inL, this.inR, this.oL, this.oR, n);
    const g0 = this.g, g1 = this.mix;               // linear crossfade, ramped over the block
    for (let i = 0; i < n; i++) {
      const w = g0 + (g1 - g0) * (i / n), d = 1 - w;
      outL[i] = d * this.dL[i] + w * this.oL[i];
      if (outR !== outL) outR[i] = d * this.dR[i] + w * this.oR[i];
    }
    this.g = g1;
    this.frame = (this.frame + n) % len;
    return true;
  }
}
registerProcessor('fv1-player', Fv1Player);
