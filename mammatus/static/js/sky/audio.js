// Optional weather sounds for the Sky view, synthesized (no audio files): rain, wind and thunder.

export class Ambience {
  constructor() {
    this.ctx = null;
    this.on = false;
  }

  async start() {
    if (this.on) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error("Sound isn't available in this browser");
    if (!this.ctx) this._build(new AC());
    await this.ctx.resume();
    this.on = true;
    this.master.gain.setTargetAtTime(0.9, this.ctx.currentTime, 0.6);
  }

  stop() {
    if (!this.on || !this.ctx) return;
    this.on = false;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    setTimeout(() => { if (!this.on) this.ctx?.suspend(); }, 1200);
  }

  _noise(ctx, seconds, brown = false) {
    const len = ctx.sampleRate * seconds;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    return buf;
  }

  _build(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    this.white = this._noise(ctx, 3);
    this.brown = this._noise(ctx, 4, true);
    // rain: hiss shaped toward the patter band, plus a low wash
    const rs = ctx.createBufferSource(); rs.buffer = this.white; rs.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 2600; bp.Q.value = 0.5;
    const hs = ctx.createBiquadFilter(); hs.type = "lowpass"; hs.frequency.value = 9000;
    this.rain = ctx.createGain(); this.rain.gain.value = 0;
    rs.connect(bp).connect(hs).connect(this.rain).connect(this.master);
    rs.start();
    // wind: brown noise through a lowpass that breathes
    const ws = ctx.createBufferSource(); ws.buffer = this.brown; ws.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 420; lp.Q.value = 0.7;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(lp.frequency);
    lfo.start();
    this.wind = ctx.createGain(); this.wind.gain.value = 0;
    ws.connect(lp).connect(this.wind).connect(this.master);
    ws.start();
  }

  // rain rate (mm/h), surface wind (m/s), is it snowing
  set({ rain = 0, wind = 0, snow = false } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const r = snow ? Math.min(0.05, rain * 0.01) : Math.min(0.55, Math.sqrt(Math.max(rain, 0)) * 0.16);
    this.rain.gain.setTargetAtTime(r, t, 1.5);
    this.wind.gain.setTargetAtTime(Math.min(0.5, 0.03 + Math.max(wind - 2, 0) * 0.022), t, 2.0);
  }

  // thunder from a flash `km` away: the crack arrives first when it is close, then the rumble
  thunder(km, power = 1) {
    if (!this.on || !this.ctx) return;
    const ctx = this.ctx;
    const delay = Math.min(km / 0.343, 40);
    const t0 = ctx.currentTime + delay;
    const loud = Math.min(1, power * 3.0 / (1 + km / 2.5));
    const src = ctx.createBufferSource(); src.buffer = this.brown;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass";
    lp.frequency.setValueAtTime(km < 3 ? 1800 : 600, t0);
    lp.frequency.exponentialRampToValueAtTime(90, t0 + 4 + km * 0.15);
    const g = ctx.createGain();
    const dur = 3 + Math.min(km, 15) * 0.35;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(loud * (km < 3 ? 1.0 : 0.5), t0 + (km < 3 ? 0.03 : 0.5));
    // rolling: a few swells as echoes arrive from farther parts of the channel
    for (let i = 1; i < 4; i++) g.gain.linearRampToValueAtTime(loud * (0.25 + Math.random() * 0.45), t0 + dur * i / 4);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t0, Math.random() * 2, dur + 0.5);
  }
}
