import { GoogleGenAI, Modality } from '@google/genai';
import { api } from './api';
import { db } from './db';

const LIVE_MODEL = 'gemini-3.5-transcribe-live';
const VOCAB = ['microprocessor', 'microcontroller', 'CPU', 'ALU', 'Control Unit', 'register file',
  'program counter', 'instruction register', 'Von Neumann', 'Harvard architecture',
  'RISC', 'CISC', 'address bus', 'data bus', 'control bus', 'UART', 'SPI', 'I2C'];

export function browserRecognitionSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// Converts an AudioWorklet Float32 block to little-endian mono 16 kHz PCM.
function pcmBase64(samples, sampleRate) {
  const ratio = sampleRate / 16000;
  const count = Math.floor(samples.length / ratio);
  const pcm = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  // Chunk conversion avoids excessive per-character string allocations for large buffers.
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export class LectureRecorder {
  constructor(lectureId, callbacks, { mode = 'browser', language = 'en-US' } = {}) {
    this.lectureId = lectureId;
    this.callbacks = callbacks;
    this.mode = mode;
    this.language = language;
    this.paused = false;
    this.stopping = false;
    this.live = null;
    this.recognition = null;
    this.browserActive = false;
    this.version = 0;
    this.savedWrites = new Set();
    this.finalWrites = new Set();
    this.geminiRetries = 0;
    this.browserNetworkFailures = 0;
    this.browserLastError = '';
  }

  reportFinal(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || this.stopping) return;
    const task = Promise.resolve().then(() => this.callbacks.final(trimmed));
    this.finalWrites.add(task);
    task.catch(error => this.callbacks.error(`Transcript saving failed: ${error?.message || error}`))
      .finally(() => this.finalWrites.delete(task));
  }

  async start() {
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone recording requires an updated browser on localhost or HTTPS.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
    });
    try {
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find(type => MediaRecorder.isTypeSupported(type));
      this.media = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
      this.media.ondataavailable = event => {
        if (!event.data?.size) return;
        const task = db.audioChunks.add({
          lectureId: this.lectureId, blob: event.data, mime: this.media.mimeType, createdAt: Date.now()
        });
        this.savedWrites.add(task);
        task.catch(() => this.callbacks.error('Could not save recorded audio locally. Check browser storage.'))
          .finally(() => this.savedWrites.delete(task));
      };
      this.media.start(4000);
    } catch (error) {
      this.stream.getTracks().forEach(track => track.stop());
      throw error;
    }

    // The real audio recording does NOT depend on either speech-recognition provider.
    if (this.mode === 'gemini') {
      try {
        await this.prepareGeminiAudio();
        await this.connectGemini();
      } catch (error) {
        await this.fallbackToBrowser(`Gemini setup failed: ${error?.message || error}`);
      }
    } else {
      this.startBrowserRecognition();
    }
  }

  async prepareGeminiAudio() {
    if (!window.AudioWorkletNode) throw new Error('AudioWorklet is not supported in this browser');
    try { this.context = new AudioContext({ sampleRate: 16000 }); }
    catch { this.context = new AudioContext(); }
    await this.context.audioWorklet.addModule('/pcm-worklet.js');
    this.source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, 'pcm-processor');
    this.silentGain = this.context.createGain();
    this.silentGain.gain.value = 0;
    this.source.connect(this.worklet);
    this.worklet.connect(this.silentGain);
    this.silentGain.connect(this.context.destination);
    this.worklet.port.onmessage = event => {
      if (this.stopping || this.paused || !this.live) return;
      try {
        this.live.sendRealtimeInput({
          audio: { data: pcmBase64(event.data, this.context.sampleRate), mimeType: 'audio/pcm;rate=16000' }
        });
      } catch (error) {
        console.warn('Could not send audio to Gemini Live:', error);
      }
    };
    await this.context.resume();
  }

  async connectGemini() {
    if (this.stopping || this.mode !== 'gemini') return;
    const version = ++this.version;
    clearTimeout(this.geminiRetryTimer);
    this.callbacks.status('Connecting to Gemini transcription...');
    try {
      const { token } = await api('/ai/live-token', { method: 'POST' });
      if (this.stopping || version !== this.version) return;
      // Ephemeral Live API tokens require v1alpha with @google/genai 2.x.
      // The SDK may still log an informational experimental-feature warning.
      const sdk = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
      const session = await sdk.live.connect({
        model: LIVE_MODEL,
        config: {
          responseModalities: [Modality.TEXT],
          inputAudioTranscription: { languageCodes: [], customVocabulary: VOCAB, mode: 'VERBATIM' }
        },
        callbacks: {
          onopen: () => this.callbacks.status('Gemini live transcription connected'),
          onmessage: message => {
            if (this.stopping || this.paused || version !== this.version) return;
            const content = message.serverContent;
            if (typeof content?.interimInputTranscription?.text === 'string') {
              this.callbacks.interim(content.interimInputTranscription.text);
            }
            if (typeof content?.inputTranscription?.text === 'string' && content.inputTranscription.text.trim()) {
              this.callbacks.interim('');
              this.geminiRetries = 0;
              this.reportFinal(content.inputTranscription.text);
            }
          },
          onerror: event => {
            if (this.stopping || version !== this.version) return;
            console.error('Gemini Live socket error:', event);
            this.handleGeminiDisconnect('Gemini Live connection error');
          },
          onclose: event => {
            if (this.stopping || version !== this.version) return;
            console.warn('Gemini Live closed:', event?.reason || event?.code);
            this.handleGeminiDisconnect('Gemini Live connection closed');
          }
        }
      });
      if (this.stopping || version !== this.version) { session.close(); return; }
      this.live = session;
      this.callbacks.status(this.paused ? 'Paused' : 'Gemini transcribing live');
      // Live transcription sessions have a maximum lifetime; rotate ahead of it.
      clearTimeout(this.rotationTimer);
      this.rotationTimer = setTimeout(() => {
        if (this.stopping || this.mode !== 'gemini') return;
        try { this.live?.close(); } catch { /* already closed */ }
        this.live = null;
        this.connectGemini().catch(error => this.fallbackToBrowser(error.message));
      }, 8 * 60 * 1000);
    } catch (error) {
      if (this.stopping || version !== this.version) return;
      console.error('Gemini Live connection setup:', error);
      await this.fallbackToBrowser(`Gemini transcription unavailable: ${error?.message || error}`);
    }
  }

  handleGeminiDisconnect(reason) {
    if (this.stopping || this.mode !== 'gemini' || this.reconnecting) return;
    this.reconnecting = true;
    clearTimeout(this.rotationTimer);
    try { this.live?.close(); } catch { /* noop */ }
    this.live = null;
    this.callbacks.gap?.(`${reason}. Check for missing lines in transcript.`);
    if (++this.geminiRetries >= 2) {
      this.fallbackToBrowser(reason).catch(error => this.callbacks.error(error.message));
    } else {
      this.callbacks.status('Reconnecting to Gemini...');
      this.geminiRetryTimer = setTimeout(() => {
        this.reconnecting = false;
        this.connectGemini().catch(error => this.fallbackToBrowser(error.message));
      }, 1800);
    }
  }

  async fallbackToBrowser(reason) {
    if (this.stopping || this.mode === 'browser') return;
    this.mode = 'browser';
    ++this.version;
    clearTimeout(this.rotationTimer);
    clearTimeout(this.geminiRetryTimer);
    try { this.live?.close(); } catch { /* noop */ }
    this.live = null;
    this.callbacks.gap?.(`${reason}. Trying browser speech recognition.`);
    this.callbacks.interim('');
    this.startBrowserRecognition();
  }

  startBrowserRecognition() {
    if (this.stopping) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      this.callbacks.status('Recording locally (speech recognition unavailable)');
      this.callbacks.error('This browser does not support live speech recognition. Use Chrome or Edge, or select Gemini. Audio is still saved.');
      return;
    }
    this.mode = 'browser';
    if (!this.recognition) {
      const recognition = new SpeechRecognition();
      recognition.lang = this.language;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      this.recognition = recognition;
      recognition.onresult = event => {
        if (this.stopping || this.paused) return;
        let currentInterim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0]?.transcript?.trim() || '';
          if (!text) continue;
          if (result.isFinal) this.reportFinal(text);
          else currentInterim += ` ${text}`;
        }
        this.callbacks.interim(currentInterim.trim());
        this.browserNetworkFailures = 0;
        this.browserLastError = '';
      };
      recognition.onerror = event => {
        if (this.stopping || this.paused) return;
        console.warn('Browser speech recognition error:', event.error, event.message);
        this.browserLastError = event.error;
        if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(event.error)) {
          this.browserBlocked = true;
          this.callbacks.error(`Browser speech recognition unavailable: ${event.error}. Your audio is still being recorded.`);
          this.callbacks.status('Recording audio only');
        } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
          this.callbacks.status(`Browser transcription interrupted: ${event.error}`);
          this.callbacks.gap?.('Browser speech recognition was interrupted; some words may be missing.');
        }
      };
      recognition.onend = () => {
        this.browserActive = false;
        if (this.stopping || this.paused || this.browserBlocked || this.mode !== 'browser') return;
        // Chrome can end a recognition session after a pause: restart while recording.
        // Silence and natural browser recognition timeouts are not failures.
        // Only stop auto-restarting after repeated network/service errors.
        if (this.browserLastError === 'network') this.browserNetworkFailures++;
        else this.browserNetworkFailures = 0;
        this.browserLastError = '';
        if (this.browserNetworkFailures > 5) {
          this.callbacks.error('Browser recognition network errors continue. Audio remains safely recorded.');
          this.callbacks.status('Recording audio only');
          return;
        }
        const delay = this.browserNetworkFailures ? Math.min(this.browserNetworkFailures * 1000, 5000) : 650;
        this.browserRetryTimer = setTimeout(() => this.startBrowserRecognition(), delay);
      };
    }
    if (this.paused || this.browserActive) return;
    try {
      this.recognition.start();
      this.browserActive = true;
      this.callbacks.status(`Browser live captions (${this.language})`);
    } catch (error) {
      if (error?.name === 'InvalidStateError') return;
      this.callbacks.error(`Could not start browser speech recognition: ${error.message}`);
      this.callbacks.status('Recording audio only');
    }
  }

  pause() {
    this.paused = true;
    if (this.media?.state === 'recording') this.media.pause();
    if (this.recognition) {
      clearTimeout(this.browserRetryTimer);
      try { this.recognition.stop(); } catch { /* noop */ }
    }
    this.callbacks.interim('');
    this.callbacks.status('Paused');
  }

  resume() {
    if (this.media?.state === 'paused') this.media.resume();
    this.paused = false;
    if (this.mode === 'browser') {
      this.browserActive = false;
      this.startBrowserRecognition();
    } else {
      this.callbacks.status(this.live ? 'Gemini transcribing live' : 'Reconnecting Gemini...');
    }
  }

  async stop() {
    if (this.stopping) return;
    clearTimeout(this.rotationTimer);
    clearTimeout(this.geminiRetryTimer);
    clearTimeout(this.browserRetryTimer);
    // Allow pending Gemini final events before closing the socket.
    if (this.live) {
      try { this.live.sendRealtimeInput({ audioStreamEnd: true }); } catch { /* noop */ }
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    // Allow browser speech recognition to submit its last finalized phrase.
    if (this.recognition) {
      try { this.recognition.stop(); } catch { /* noop */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    this.stopping = true;
    ++this.version;
    try { this.live?.close(); } catch { /* noop */ }
    this.live = null;
    if (this.media && this.media.state !== 'inactive') {
      await new Promise(resolve => {
        this.media.addEventListener('stop', resolve, { once: true });
        this.media.stop();
      });
    }
    this.stream?.getTracks().forEach(track => track.stop());
    this.source?.disconnect();
    this.worklet?.disconnect();
    this.silentGain?.disconnect();
    await this.context?.close().catch(() => {});
    // New tasks may have been queued by the last transcription callbacks.
    await Promise.allSettled([...this.savedWrites, ...this.finalWrites]);
    this.callbacks.interim('');
    this.callbacks.status('Recording stopped');
  }
}
