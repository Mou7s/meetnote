// Keep a continuous source-sample clock across process() calls, including 44.1 kHz input.
class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.step = sampleRate / 16000
    this.next = 0
    this.position = 0
    this.previous = 0
    this.packet = new Int16Array(4000)
    this.used = 0
    this.port.onmessage = ({ data }) => {
      if (data === 'flush') { this.send(); this.port.postMessage({ type: 'flushed' }) }
    }
  }
  send() {
    if (!this.used) return
    const bytes = this.packet.buffer.slice(0, this.used * 2)
    this.port.postMessage({ type: 'pcm', bytes }, [bytes])
    this.used = 0
  }
  process(inputs) {
    const input = inputs[0]?.[0]
    if (!input) return true
    for (let i = 0; i < input.length; i++, this.position++) {
      const value = input[i]
      while (this.next <= this.position) {
        const fraction = this.next - (this.position - 1)
        const interpolated = this.previous + (value - this.previous) * Math.max(0, Math.min(1, fraction))
        const sample = Math.max(-1, Math.min(1, interpolated))
        this.packet[this.used++] = sample < 0 ? sample * 32768 : sample * 32767
        this.next += this.step
        if (this.used === this.packet.length) this.send()
      }
      this.previous = value
    }
    return true
  }
}
registerProcessor('pcm-recorder', PCMRecorder)
