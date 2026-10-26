
import { GoogleGenAI, Modality } from "@google/genai";
import { api } from "./api";
import { db } from "./db";

// Convert microphone Float32 samples
// into 16-bit, 16 kHz mono PCM.

function pcmBase64(samples, sampleRate) {
  const ratio = sampleRate / 16000;
  const count = Math.floor(samples.length / ratio);

  const pcm = new Int16Array(count);

  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(
      samples.length,
      Math.floor((i + 1) * ratio)
    );

    let total = 0;

    const actualEnd = Math.max(start + 1, end);

    for (let j = start; j < actualEnd; j++) {
      total += samples[j];
    }

    const sample = Math.max(
      -1,
      Math.min(
        1,
        total / (actualEnd - start)
      )
    );

    pcm[i] =
      sample < 0
        ? sample * 0x8000
        : sample * 0x7fff;
  }

  const bytes = new Uint8Array(pcm.buffer);

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

export class LectureRecorder {
  constructor(lectureId, callbacks) {
    this.lectureId = lectureId;
    this.callbacks = callbacks;

    this.stopping = false;
    this.paused = false;
    this.version = 0;

    this.media = null;
    this.live = null;
  }

  // ------------------------------
  // Start microphone and recording
  // ------------------------------

  async start() {
    if (
      !window.MediaRecorder ||
      !window.AudioWorkletNode ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      throw new Error(
        "Required audio features are unavailable. " +
        "Use HTTPS or localhost with updated Chrome."
      );
    }

    this.stream =
      await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });

    try {
      const mime = [
        "audio/webm;codecs=opus",
        "audio/mp4",
        "audio/webm",
      ].find((type) =>
        MediaRecorder.isTypeSupported(type)
      );

      this.media = new MediaRecorder(
        this.stream,
        mime ? { mimeType: mime } : undefined
      );

      // Save each recorded chunk locally.

      this.media.ondataavailable = (event) => {
        if (event.data.size > 0) {
          db.audioChunks
            .add({
              lectureId: this.lectureId,
              blob: event.data,
              mime: this.media.mimeType,
              createdAt: Date.now(),
            })
            .catch(() => {
              this.callbacks.error(
                "Could not save local audio. " +
                "Check available device storage."
              );
            });
        }
      };

      this.media.start(4000);

      // Configure audio processing.

      try {
        this.context = new AudioContext({
          sampleRate: 16000,
        });
      } catch {
        this.context = new AudioContext();
      }

      await this.context.audioWorklet.addModule(
        "/pcm-worklet.js"
      );

      this.source =
        this.context.createMediaStreamSource(
          this.stream
        );

      this.worklet = new AudioWorkletNode(
        this.context,
        "pcm-processor"
      );

      this.gain = this.context.createGain();
      this.gain.gain.value = 0;

      this.source.connect(this.worklet);
      this.worklet.connect(this.gain);
      this.gain.connect(this.context.destination);

      // Send PCM samples to Gemini Live.

      this.worklet.port.onmessage = (event) => {
        if (
          !this.live ||
          this.paused ||
          this.stopping
        ) {
          return;
        }

        try {
          const audio = pcmBase64(
            event.data,
            this.context.sampleRate
          );

          this.live.sendRealtimeInput({
            audio: {
              data: audio,
              mimeType: "audio/pcm;rate=16000",
            },
          });
        } catch {
          // Local recording continues.
        }
      };

      // Gemini Live has a session limit.
      // Start a new session before the limit.

      this.rotationTimer = setInterval(() => {
        if (!this.stopping) {
          this.connectLive();
        }
      }, 8 * 60 * 1000);

      await this.connectLive();
    } catch (error) {
      // Recording may continue locally even if
      // Gemini connection fails.

      this.callbacks.error(
        "Audio is recording locally, but " +
        "live transcription is unavailable: " +
        error.message
      );
    }
  }

  // ------------------------------
  // Connect Gemini Live
  // ------------------------------

  async connectLive() {
    if (this.stopping) return;

    const myVersion = ++this.version;

    if (this.live) {
      try {
        this.live.close();
      } catch {
        // Ignore an already closed session.
      }

      this.live = null;
    }

    this.callbacks.status(
      "Connecting to Gemini..."
    );

    try {
      // Get a temporary token from Express.
      // Never expose the real Gemini API key.

      const { token } = await api(
        "/ai/live-token",
        { method: "POST" }
      );

      if (
        this.stopping ||
        this.version !== myVersion
      ) {
        return;
      }

      const sdk = new GoogleGenAI({
        apiKey: token,
      });

      const session = await sdk.live.connect({
        model: "gemini-3.5-transcribe-live",

        config: {
          responseModalities: [Modality.TEXT],
          inputAudioTranscription: {
            languageCodes: [],
          },
        },

        callbacks: {
          onopen: () => {},

          onmessage: (message) => {
            if (
              this.stopping ||
              this.version !== myVersion
            ) {
              return;
            }

            const content = message.serverContent;

            // Update tentative live words.

            if (
              content?.interimInputTranscription?.text
            ) {
              this.callbacks.interim(
                content.interimInputTranscription.text
              );
            }

            // Save confirmed transcription text.

            if (
              content?.inputTranscription?.text
            ) {
              this.callbacks.interim("");

              this.callbacks.final(
                content.inputTranscription.text
              );
            }
          },

          onerror: () => {
            this.callbacks.status(
              "Transcription connection problem"
            );
          },

          onclose: () => {
            if (
              !this.stopping &&
              this.version === myVersion
            ) {
              this.live = null;

              this.callbacks.status(
                "Reconnecting transcription..."
              );

              this.retryTimer = setTimeout(
                () => this.connectLive(),
                3500
              );
            }
          },
        },
      });

      if (
        this.stopping ||
        this.version !== myVersion
      ) {
        session.close();
        return;
      }

      this.live = session;

      this.callbacks.status(
        this.paused
          ? "Paused"
          : "Transcribing live"
      );
    } catch (error) {
      if (
        this.stopping ||
        this.version !== myVersion
      ) {
        return;
      }

      this.callbacks.error(
        `Live transcription: ${error.message}`
      );
    }
  }

  // ------------------------------
  // Pause recording
  // ------------------------------

  pause() {
    this.paused = true;

    if (this.media?.state === "recording") {
      this.media.pause();
    }

    this.callbacks.status("Paused");
  }

  // ------------------------------
  // Resume recording
  // ------------------------------

  resume() {
    if (this.media?.state === "paused") {
      this.media.resume();
    }

    this.paused = false;

    this.callbacks.status(
      this.live
        ? "Transcribing live"
        : "Audio recording locally"
    );
  }

  // ------------------------------
  // Stop recording
  // ------------------------------

  async stop() {
    // Stop sending new PCM samples while allowing
    // the final transcript event to arrive.

    this.paused = true;

    clearInterval(this.rotationTimer);
    clearTimeout(this.retryTimer);

    if (
      this.media &&
      this.media.state !== "inactive"
    ) {
      await new Promise((resolve) => {
        this.media.addEventListener(
          "stop",
          resolve,
          { once: true }
        );

        this.media.stop();
      });
    }

    this.stream
      ?.getTracks()
      .forEach((track) => track.stop());

    this.worklet?.disconnect();
    this.source?.disconnect();

    if (this.live) {
      try {
        this.live.sendRealtimeInput({
          audioStreamEnd: true,
        });
      } catch {
        // Ignore if connection already ended.
      }

      // Give Gemini a short opportunity
      // to finalize its last utterance.

      await new Promise((resolve) =>
        setTimeout(resolve, 1500)
      );

      this.stopping = true;

      try {
        this.live.close();
      } catch {
        // Ignore closed session.
      }
    } else {
      this.stopping = true;
    }

    this.version++;

    try {
      await this.context?.close();
    } catch {
      // Ignore audio context cleanup errors.
    }

    this.callbacks.status(
      "Recording stopped"
    );
  }
}
