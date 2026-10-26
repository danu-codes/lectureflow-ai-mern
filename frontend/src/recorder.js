
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

      const session = await ai.live.connect({
        model: "gemini-3.5-transcribe-live",

        config: {
          responseModalities: [Modality.TEXT],

          inputAudioTranscription: {
            languageCodes: [],

            customVocabulary: [
              "microprocessor",
              "microcontroller",
              "CPU",
              "ALU",
              "Control Unit",
              "register file",
              "program counter",
              "instruction register",
              "Von Neumann",
              "Harvard architecture",
              "RISC",
              "CISC",
              "address bus",
              "data bus",
              "control bus",
              "UART",
              "SPI",
              "I2C",
            ],

            mode: "VERBATIM",
          },
        },

        callbacks: {
          onopen: () => { },

          onmessage: (message) => {
            const content = message.serverContent;

            // Tentative words appear while speaking.
            if (
              typeof content?.interimInputTranscription?.text
              === "string"
            ) {
              callbacks.interim(
                content.interimInputTranscription.text
              );
            }

            // Completed speech is added to the transcript.
            if (content?.inputTranscription?.text) {
              callbacks.interim("");

              callbacks.final(
                content.inputTranscription.text
              );
            }
          },

          onerror: (error) => {
            console.error("Gemini Live error:", error);
          },

          onclose: () => {
            console.log("Gemini session closed");
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
    this.finishing = true;

    clearInterval(this.rotationTimer);
    clearTimeout(this.retryTimer);

    // Ask Gemini to finalize the current utterance.
    try {
      this.live?.sendRealtimeInput({
        audioStreamEnd: true,
      });
    } catch { }

    // Still accept final transcript callbacks here.
    await new Promise((resolve) =>
      setTimeout(resolve, 1800)
    );

    this.stopped = true;
    ++this.version;

    try {
      this.live?.close();
    } catch { }

    this.live = null;

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

    this.source?.disconnect();
    this.worklet?.disconnect();
    this.silencer?.disconnect();

    await this.context?.close().catch(() => { });

    await Promise.allSettled([
      ...this.savedWrites,
      ...this.finalWrites,
    ]);

    this.callbacks.interim("");
    this.callbacks.status("Recording stopped");
  }
}
