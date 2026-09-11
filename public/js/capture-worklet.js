/**
 * AudioWorklet processor: forwards raw mono Float32 frames to the main thread.
 *
 * Running capture on the audio render thread (rather than the deprecated
 * ScriptProcessorNode) keeps frames from being dropped when the main thread is
 * busy rendering the editor — which it is, constantly, during dictation.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      // Copy: the underlying buffer is reused by the audio engine after return.
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}

registerProcessor("speakdown-capture", CaptureProcessor);
