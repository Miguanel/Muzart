// AudioWorklet: przechwytywanie surowych próbek z mikrofonu.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.port.onmessage = (e) => { if (e.data === "flush") this.flush(); };
  }
  flush() {
    if (this.n > 0) {
      this.port.postMessage(this.buf.slice(0, this.n));
      this.n = 0;
    }
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const ch0 = input[0];
      const ch1 = input[1];
      for (let i = 0; i < ch0.length; i++) {
        this.buf[this.n++] = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
        if (this.n === this.buf.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor("muzart-recorder", RecorderProcessor);
