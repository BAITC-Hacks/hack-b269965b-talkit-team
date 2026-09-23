const OUTPUT_RATE = 16_000;
const FRAME_SAMPLES = 320;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capturing = false;
    this.captureId = 0;
    this.frame = new ArrayBuffer(FRAME_SAMPLES * 2);
    this.frameView = new DataView(this.frame);
    this.frameSamples = 0;
    this.inputIndex = -1;
    this.nextOutputPosition = 0;
    this.previous = 0;
    this.step = sampleRate / OUTPUT_RATE;
    // A short running average reduces aliasing when the device rate exceeds 16 kHz.
    this.filterLength = Math.max(1, Math.floor(this.step));
    this.filterValues = new Float32Array(this.filterLength);
    this.filterIndex = 0;
    this.filterCount = 0;
    this.filterSum = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === "start" && Number.isSafeInteger(event.data.captureId)) {
        this.captureId = event.data.captureId;
        this.capturing = true;
        this.resetSamples();
      } else if (event.data?.type === "stop") {
        this.capturing = false;
        this.frameSamples = 0;
      }
    };
  }

  resetSamples() {
    this.frameSamples = 0;
    this.inputIndex = -1;
    this.nextOutputPosition = 0;
    this.previous = 0;
    this.filterValues.fill(0);
    this.filterIndex = 0;
    this.filterCount = 0;
    this.filterSum = 0;
  }

  writeSample(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    const value = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
    this.frameView.setInt16(this.frameSamples * 2, value, true);
    this.frameSamples += 1;
    if (this.frameSamples === FRAME_SAMPLES) {
      const completed = this.frame;
      this.port.postMessage({ type: "pcm16-frame", captureId: this.captureId, buffer: completed }, [
        completed,
      ]);
      this.frame = new ArrayBuffer(FRAME_SAMPLES * 2);
      this.frameView = new DataView(this.frame);
      this.frameSamples = 0;
    }
  }

  process(inputs) {
    if (!this.capturing) return true;
    const channels = inputs[0];
    const first = channels?.[0];
    if (!first) return true;

    for (let index = 0; index < first.length; index += 1) {
      let sample = 0;
      for (let channel = 0; channel < channels.length; channel += 1) {
        sample += channels[channel][index] ?? 0;
      }
      sample /= channels.length;

      this.filterSum -= this.filterValues[this.filterIndex];
      this.filterValues[this.filterIndex] = sample;
      this.filterSum += sample;
      this.filterIndex = (this.filterIndex + 1) % this.filterLength;
      this.filterCount = Math.min(this.filterCount + 1, this.filterLength);
      const filtered = this.filterSum / this.filterCount;

      this.inputIndex += 1;
      if (this.inputIndex === 0) {
        this.previous = filtered;
        this.writeSample(filtered);
        this.nextOutputPosition += this.step;
        continue;
      }

      while (this.nextOutputPosition <= this.inputIndex) {
        const fraction = this.nextOutputPosition - (this.inputIndex - 1);
        this.writeSample(this.previous + (filtered - this.previous) * fraction);
        this.nextOutputPosition += this.step;
      }
      this.previous = filtered;
    }
    return true;
  }
}

registerProcessor("voice-pcm-capture", PcmCaptureProcessor);
