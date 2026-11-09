// Copyright 2026 Milind Soni and OpenMausBot contributors
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE at the repo root)
// Modified by taskmote contributors
//
// Microphone capture and voice-activity detection for the hands-free call. Derived from the mic and endpointer parts
// of OpenMausBot's fish-speech.ts (RMS level, 3 loud frames = speech start). No audio ever leaves the page here: the
// words come from the browser's SpeechRecognition, this file only decides when somebody is talking.

const SPEECH_RMS = 0.015;
const SPEECH_FRAMES = 3;
const FRAME_MS = 32;
const FFT = 1024;

export function rms(frame: Float32Array): number {
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / (frame.length || 1));
}

export interface VadHandlers {
  onStart: () => void;
  onEnd: () => void;
}

/** Feeds one level per frame; calls onStart after SPEECH_FRAMES loud frames and onEnd after `quietMs` of quiet. */
export function createDetector(handlers: VadHandlers, quietMs = 300, frameMs = FRAME_MS) {
  let loud = 0;
  let quiet = 0;
  let speaking = false;
  let scale = 1;
  return {
    /** A louder threshold while our own voice plays, so the speaker does not trigger a barge-in. */
    setScale(next: number) {
      scale = next;
    },
    push(level: number) {
      if (level > SPEECH_RMS * scale) {
        quiet = 0;
        loud += 1;
        if (!speaking && loud >= SPEECH_FRAMES) {
          speaking = true;
          handlers.onStart();
        }
      } else {
        loud = 0;
        if (speaking) {
          quiet += frameMs;
          if (quiet >= quietMs) {
            speaking = false;
            quiet = 0;
            handlers.onEnd();
          }
        }
      }
    },
    get speaking() {
      return speaking;
    },
  };
}

export class MicError extends Error {
  reason: "blocked" | "missing" | "failed";
  constructor(reason: "blocked" | "missing" | "failed") {
    super(reason);
    this.reason = reason;
  }
}

export interface Vad {
  setScale: (scale: number) => void;
  close: () => void;
}

/** Opens the microphone (echo cancellation, noise suppression, auto gain) and starts detecting. */
export async function startVad(handlers: VadHandlers): Promise<Vad> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    throw new MicError(name === "NotAllowedError" ? "blocked" : name === "NotFoundError" ? "missing" : "failed");
  }
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new Ctx();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = FFT;
  source.connect(analyser);
  if (context.state === "suspended") void context.resume().catch(() => {});
  const detector = createDetector(handlers);
  const buffer = new Float32Array(FFT);
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(buffer);
    detector.push(rms(buffer));
  }, FRAME_MS);
  return {
    setScale: detector.setScale,
    close() {
      window.clearInterval(timer);
      source.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close().catch(() => {});
    },
  };
}
