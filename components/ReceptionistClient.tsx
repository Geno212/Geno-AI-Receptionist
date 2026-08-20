"use client";

import { useEffect } from "react";

function wsUrl(lang?: string): string {
  const base = (() => {
    if (process.env.NEXT_PUBLIC_API_WS_URL) return process.env.NEXT_PUBLIC_API_WS_URL;
    if (typeof window === "undefined") return "ws://localhost:3001/client-ws";
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    if (window.location.port === "3000") {
      return `${proto}//${window.location.hostname}:3001/client-ws`;
    }
    return `${proto}//${window.location.host}/client-ws`;
  })();
  if (!lang || (lang !== "ar" && lang !== "en")) return base;
  const join = base.includes("?") ? "&" : "?";
  return `${base}${join}lang=${lang}`;
}

export default function ReceptionistClient() {
  useEffect(() => {
    const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
    const chatLogEl = $("#chatLog");
    const aiContainerEl = $("#aiContainer");
    if (!chatLogEl || !aiContainerEl) return;
    const chatLog = chatLogEl;
    const aiContainer = aiContainerEl;

    const translations: Record<string, Record<string, string>> = {
      "en-US": {
        title: "AI Receptionist",
        status_ready: "READY TO CONNECT",
        status_connecting: "CONNECTING...",
        status_incall: "CALL ACTIVE",
        status_listening: "LISTENING...",
        status_speaking: "SPEAKING...",
        btn_call: "Start Call",
      },
    };

    function addChatMessage(text: string, type: string) {
      const div = document.createElement("div");
      div.className = `msg ${type}`;
      div.textContent = text;
      const time = document.createElement("span");
      time.className = "msg-time";
      const now = new Date();
      time.textContent = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
      div.appendChild(time);
      chatLog.appendChild(div);
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    function clearChat() {
      chatLog.innerHTML = "";
    }

    function isSpuriousTranscript(text: string) {
      const t = (text || "").trim();
      if (!t) return true;
      const lower = t
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u064B-\u065F]/g, "")
        .replace(/\s+/g, " ");
      const hallucinations = [
        "дякую",
        "повторити",
        "спасибо",
        "thanks for watching",
        "thank you for watching",
        "thanks for listening",
        "дякую за перегляд",
        "подписывайтесь",
        "subscribe",
        "please subscribe",
        "like and subscribe",
        "see you next time",
        "thanks for tuning in",
        "amara.org",
        "www.youtube.com",
        "ترجمة نانسي",
        "مرحبا بكم في هذا الفيديو",
        "مرحباً بكم في هذا الفيديو",
        "اهلا بكم في هذا الفيديو",
        "شكرا للمشاهدة",
        "لا تنسوا الاشتراك",
        "اشتركوا في القناة",
        "a palavra é da bíblia",
        "a palavra e da biblia",
        "bíblia de roma",
        "biblia de roma",
        "inscreva-se no canal",
        "gracias por ver",
      ];
      if (/^[\u0400-\u04FF\s!?.,]+$/u.test(t) && t.length < 40) return true;
      return hallucinations.some((h) => lower.includes(h.replace(/[\u064B-\u065F]/g, "")));
    }

    function setStatus(key: string) {
      const t = translations["en-US"];
      const el = $("#status");
      if (el) el.textContent = t[`status_${key}`] || key;
    }

    function setVisualizerState(state: string | null) {
      aiContainer.classList.remove("state-listening", "state-speaking", "state-paused");
      if (state) aiContainer.classList.add(`state-${state}`);
    }

    let ws: WebSocket | null = null;
    let recognition: any = null;
    let isRecording = false;
    let useServerStt = false;
    let uiLang: "ar" | "en" = "en";
    const langSelect = $("#langSelect") as HTMLSelectElement | null;
    if (langSelect) {
      const saved = (localStorage.getItem("geno_lang") || "").toLowerCase();
      if (saved === "ar" || saved === "en") {
        uiLang = saved;
        langSelect.value = saved;
      } else {
        uiLang = langSelect.value === "ar" ? "ar" : "en";
      }
      langSelect.onchange = () => {
        uiLang = langSelect.value === "ar" ? "ar" : "en";
        localStorage.setItem("geno_lang", uiLang);
        document.documentElement.lang = uiLang === "ar" ? "ar" : "en";
        document.documentElement.dir = uiLang === "ar" ? "rtl" : "ltr";
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "set_language", language: uiLang }));
        }
      };
      document.documentElement.lang = uiLang === "ar" ? "ar" : "en";
      document.documentElement.dir = uiLang === "ar" ? "rtl" : "ltr";
    }
    let isAiSpeaking = false;
    let isCommitting = false;
    let ttsEndTimeout: ReturnType<typeof setTimeout> | null = null;
    let greetingPending = false;
    let greetingFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    /** True until Geno's first greeting has actually played (PCM), not just tts_end. */
    let greetingAudioHeard = false;
    let listeningPaused = false;
    let discardNextRecording = false;
    let forceCommitOnStop = false;
    let lastInterimText = "";
    let pendingReplyText: string | null = null;
    let pendingReplyTimer: ReturnType<typeof setTimeout> | null = null;

    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let microphoneStream: MediaStreamAudioSourceNode | null = null;
    let globalStream: MediaStream | null = null;
    let dataArray: Uint8Array | null = null;
    let visualizerInterval: ReturnType<typeof setInterval> | null = null;
    let nextStartTime = 0;
    const SAMPLE_RATE = 24000;
    let pcmBufferQueue = new Uint8Array(0);
    const VAD_THRESHOLD = 28;
    // Wait after Geno finishes so speaker echo / room ring doesn't become "speech".
    const POST_TTS_PAD_MS = 700;
    let silenceStart: number | null = null;
    let speechDetected = false;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let mediaRecorder: MediaRecorder | null = null;
    let recordedChunks: Blob[] = [];
    let serverSttActive = false;
    let serverSttPollTimer: ReturnType<typeof setInterval> | null = null;

    function flushPendingReply() {
      if (pendingReplyTimer) {
        clearTimeout(pendingReplyTimer);
        pendingReplyTimer = null;
      }
      if (!pendingReplyText) return;
      const text = pendingReplyText;
      pendingReplyText = null;
      addChatMessage(text, "ai");
    }

    function clearPendingReply() {
      if (pendingReplyTimer) {
        clearTimeout(pendingReplyTimer);
        pendingReplyTimer = null;
      }
      pendingReplyText = null;
    }

    function stopSTT() {
      isRecording = false;
      if (silenceTimer) clearTimeout(silenceTimer);
      if (serverSttPollTimer) {
        clearInterval(serverSttPollTimer);
        serverSttPollTimer = null;
      }
      if (mediaRecorder) {
        if (serverSttActive) mediaRecorder.onstop = null;
        try {
          if (mediaRecorder.state === "recording") mediaRecorder.stop();
        } catch {}
        mediaRecorder = null;
        serverSttActive = false;
        recordedChunks = [];
      }
      if (recognition) {
        recognition.onresult = null;
        recognition.onend = null;
        recognition.onerror = null;
        recognition.abort();
        recognition = null;
      }
    }

    function stopListening({ discard = true } = {}) {
      listeningPaused = true;
      if (mediaRecorder && mediaRecorder.state === "recording") {
        discardNextRecording = discard;
        try {
          mediaRecorder.stop();
        } catch {}
      } else {
        stopSTT();
      }
      setVisualizerState("paused");
      const el = $("#status");
      if (el) el.textContent = "TAP BALL TO LISTEN";
    }

    function resumeListening() {
      if (!ws || ws.readyState !== WebSocket.OPEN || isAiSpeaking || greetingPending) return;
      listeningPaused = false;
      discardNextRecording = false;
      forceCommitOnStop = false;
      if (!isRecording) startSTT();
    }

    function commitUtterance() {
      if (isAiSpeaking || greetingPending) return;
      if (mediaRecorder && mediaRecorder.state === "recording") {
        listeningPaused = false;
        discardNextRecording = false;
        forceCommitOnStop = true;
        if (serverSttPollTimer) {
          clearInterval(serverSttPollTimer);
          serverSttPollTimer = null;
        }
        setStatus("thinking");
        const el = $("#status");
        if (el) el.textContent = "TRANSCRIBING...";
        try {
          mediaRecorder.stop();
        } catch {}
        return;
      }
      if (recognition && isRecording) {
        const text = (lastInterimText || "").trim();
        if (text) {
          commitSpeech(text);
          try {
            recognition.stop();
          } catch {}
        } else {
          stopListening({ discard: true });
        }
      }
    }

    function commitSpeech(text: string, detectedLang: string | null = null) {
      if (isCommitting) return;
      if (!text || !text.trim()) return;
      if (isSpuriousTranscript(text)) {
        console.warn("Ignoring spurious transcript:", text);
        return;
      }
      if (isAiSpeaking || greetingPending || listeningPaused) {
        console.warn("Ignoring speech while Geno is speaking/paused:", text);
        return;
      }
      isCommitting = true;
      if (silenceTimer) clearTimeout(silenceTimer);
      addChatMessage(text, "user");
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "text", text, language: uiLang }));
        }
      stopSTT();
    }

    function playPCMChunk(arrayBuffer: ArrayBuffer) {
      if (!audioCtx) return;
      const newChunk = new Uint8Array(arrayBuffer);
      const combined = new Uint8Array(pcmBufferQueue.length + newChunk.length);
      combined.set(pcmBufferQueue);
      combined.set(newChunk, pcmBufferQueue.length);
      const remainder = combined.length % 2;
      const processableLength = combined.length - remainder;
      if (processableLength === 0) {
        pcmBufferQueue = combined;
        return;
      }
      const processBuffer = combined.slice(0, processableLength);
      pcmBufferQueue = combined.slice(processableLength);
      const int16Data = new Int16Array(processBuffer.buffer);
      const float32Data = new Float32Array(int16Data.length);
      for (let i = 0; i < int16Data.length; i++) float32Data[i] = int16Data[i] / 32768.0;
      const buffer = audioCtx.createBuffer(1, float32Data.length, SAMPLE_RATE);
      buffer.getChannelData(0).set(float32Data);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = 2.5;
      source.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      if (nextStartTime < audioCtx.currentTime) nextStartTime = audioCtx.currentTime;
      source.start(nextStartTime);
      nextStartTime += buffer.duration;
    }

    function startVisualizer() {
      if (visualizerInterval) clearInterval(visualizerInterval);
      const r1 = $(".ring-1") as HTMLElement;
      const r2 = $(".ring-2") as HTMLElement;
      const r3 = $(".ring-3") as HTMLElement;
      const core = $(".ai-core") as HTMLElement;
      visualizerInterval = setInterval(() => {
        if (!analyser || !dataArray || isAiSpeaking) return;
        analyser.getByteFrequencyData(dataArray as Uint8Array<ArrayBuffer>);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const average = sum / dataArray.length;
        if (isRecording && !isAiSpeaking && core && r1 && r2) {
          const scale = 1 + (average / 256) * 1.5;
          const opacity = 0.3 + average / 256;
          core.style.transform = `scale(${0.9 + average / 256})`;
          r1.style.width = `${140 * scale}px`;
          r1.style.height = `${140 * scale}px`;
          r1.style.opacity = String(opacity);
          r2.style.width = `${200 * (scale * 0.8)}px`;
          r2.style.height = `${200 * (scale * 0.8)}px`;
          if (average > VAD_THRESHOLD) {
            silenceStart = null;
            speechDetected = true;
            setVisualizerState("listening");
          } else if (!silenceStart) silenceStart = Date.now();
        }
      }, 50);
    }

    function pickRecorderMime() {
      const candidates = [
        "audio/ogg;codecs=opus",
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ];
      for (const m of candidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
      }
      return "";
    }

    function startServerSTT() {
      if (!globalStream || !window.MediaRecorder) return false;
      try {
        const mimeType = pickRecorderMime();
        mediaRecorder = new MediaRecorder(globalStream, mimeType ? { mimeType } : undefined);
      } catch (e) {
        console.warn("MediaRecorder unavailable, falling back to browser STT", e);
        return false;
      }
      recordedChunks = [];
      isCommitting = false;
      serverSttActive = true;
      isRecording = true;
      forceCommitOnStop = false;
      let speechSeen = false;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size) recordedChunks.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        if (serverSttPollTimer) {
          clearInterval(serverSttPollTimer);
          serverSttPollTimer = null;
        }
        const blob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
        recordedChunks = [];
        serverSttActive = false;
        const forced = forceCommitOnStop;
        forceCommitOnStop = false;

        if (discardNextRecording) {
          discardNextRecording = false;
          isRecording = false;
          return;
        }
        if ((!speechSeen && !forced) || blob.size < 6000) {
          if (isRecording && !listeningPaused) startSTT();
          return;
        }
        // Manual tap with no real speech energy → don't bother Whisper.
        if (forced && !speechSeen) {
          if (isRecording && !listeningPaused) startSTT();
          return;
        }
        isRecording = false;
        setStatus("thinking");
        const st = $("#status");
        if (st) st.textContent = "TRANSCRIBING...";
        try {
          const res = await fetch(`/stt?lang=${uiLang}`, {
            method: "POST",
            headers: { "Content-Type": blob.type || "audio/webm" },
            body: blob,
          });
          const data = await res.json();
          if (data.ok && data.text) {
            if (isSpuriousTranscript(data.text)) {
              console.warn("Ignoring spurious STT transcript:", data.text);
              if (!listeningPaused) startSTT();
            } else {
              commitSpeech(data.text, uiLang);
            }
          } else {
            console.warn("server STT returned nothing", data);
            if (!listeningPaused) startSTT();
          }
        } catch (e) {
          console.warn("server STT failed, falling back to browser STT", e);
          addChatMessage("Speech service unavailable, using browser recognition", "system");
          useServerStt = false;
          if (!listeningPaused) startSTT();
        }
      };

      mediaRecorder.start();
      setVisualizerState("listening");
      setStatus("listening");
      silenceStart = Date.now();
      const SILENCE_MS = 1200;
      const MAX_UTTERANCE_MS = 20000;
      const startedAt = Date.now();
      serverSttPollTimer = setInterval(() => {
        if (!analyser || !dataArray) return;
        analyser.getByteFrequencyData(dataArray as Uint8Array<ArrayBuffer>);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        if (avg > VAD_THRESHOLD) {
          speechSeen = true;
          silenceStart = null;
        } else if (!silenceStart) silenceStart = Date.now();
        const quietLongEnough =
          speechSeen && silenceStart && Date.now() - silenceStart > SILENCE_MS;
        const tooLong = Date.now() - startedAt > MAX_UTTERANCE_MS;
        if ((quietLongEnough || tooLong) && mediaRecorder && mediaRecorder.state === "recording") {
          mediaRecorder.stop();
        }
      }, 50);
      return true;
    }

    function startSTT() {
      if (greetingPending || isAiSpeaking || listeningPaused) return;
      if (useServerStt && startServerSTT()) return;
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SpeechRecognition) {
        addChatMessage("Browser does not support Speech Recognition", "system");
        return;
      }
      if (recognition) stopSTT();
      isCommitting = false;
      recognition = new SpeechRecognition();
      recognition.lang = uiLang === "ar" ? "ar-EG" : "en-US";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => {
        setVisualizerState("listening");
        setStatus("listening");
        silenceStart = Date.now();
      };
      recognition.onresult = (event: any) => {
        if (silenceTimer) clearTimeout(silenceTimer);
        const last = event.results.length - 1;
        const text = event.results[last][0].transcript;
        const isFinal = event.results[last].isFinal;
        lastInterimText = text;
        const st = $("#status");
        if (st)
          st.textContent =
            "HEARD: " + (text.length > 20 ? text.substring(0, 20) + "..." : text);
        if (isFinal) {
          lastInterimText = "";
          commitSpeech(text);
        } else if (speechDetected && silenceStart && Date.now() - silenceStart > 2500) {
          lastInterimText = "";
          commitSpeech(text);
          recognition.stop();
        } else {
          silenceTimer = setTimeout(() => {
            lastInterimText = "";
            commitSpeech(text);
          }, 3500);
        }
      };
      recognition.onerror = (e: any) => {
        if (e.error !== "no-speech" && e.error !== "aborted") {
          console.log("STT Error: " + e.error);
          if (e.error === "network") setTimeout(startSTT, 1000);
        }
      };
      recognition.onend = () => {
        if (isRecording) {
          setTimeout(() => {
            if (isRecording && recognition) {
              try {
                recognition.start();
              } catch {}
            }
          }, 100);
        }
      };
      try {
        recognition.start();
      } catch {}
      isRecording = true;
      lastInterimText = "";
    }

    async function startCall() {
      if (isRecording) return;
      setStatus("connecting");
      if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      if (audioCtx.state === "suspended") await audioCtx.resume();
      nextStartTime = 0;
      pcmBufferQueue = new Uint8Array(0);

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        globalStream = stream;
        microphoneStream = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        microphoneStream.connect(analyser);
        dataArray = new Uint8Array(analyser.frequencyBinCount);
        startVisualizer();
      } catch (e) {
        console.error("Mic analysis failed:", e);
      }

      ws = new WebSocket(wsUrl(uiLang));
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        clearChat();
        addChatMessage("Connected to server", "system");
        ws?.send(JSON.stringify({ type: "set_language", language: uiLang }));
        setStatus("incall");
        const btnCall = $("#btnCall") as HTMLButtonElement | null;
        const btnHangup = $("#btnHangup") as HTMLButtonElement | null;
        if (btnCall) btnCall.disabled = true;
        if (btnHangup) btnHangup.disabled = false;
        if (langSelect) langSelect.disabled = true;
        greetingPending = true;
        greetingAudioHeard = false;
        if (greetingFallbackTimer) clearTimeout(greetingFallbackTimer);
        // Only open the mic if greeting audio never arrived (TTS hard-fail).
        greetingFallbackTimer = setTimeout(() => {
          if (greetingPending && !greetingAudioHeard && ws && ws.readyState === WebSocket.OPEN && !isRecording) {
            console.warn("Greeting audio missing — allowing listen after fallback");
            greetingPending = false;
            startSTT();
          }
        }, 20000);
      };

      ws.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          if (ttsEndTimeout) {
            clearTimeout(ttsEndTimeout);
            ttsEndTimeout = null;
          }
          if (!isAiSpeaking) {
            isAiSpeaking = true;
            if (greetingPending) greetingAudioHeard = true;
            stopSTT();
            setVisualizerState("speaking");
            setStatus("speaking");
            nextStartTime = (audioCtx?.currentTime || 0) + 0.05;
            if (pendingReplyText && !pendingReplyTimer) {
              const delayMs = Math.max(
                0,
                (nextStartTime - (audioCtx?.currentTime || 0)) * 1000
              );
              pendingReplyTimer = setTimeout(flushPendingReply, delayMs);
            }
          }
          playPCMChunk(event.data);
        } else {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === "reply" && msg.text) {
              clearPendingReply();
              pendingReplyText = msg.text;
            } else if (msg.type === "tts_end") {
              if (pendingReplyText && !pendingReplyTimer) flushPendingReply();
              const remaining = nextStartTime - (audioCtx?.currentTime || 0);
              if (ttsEndTimeout) clearTimeout(ttsEndTimeout);

              // Do not open the mic until the greeting has actually been heard.
              if (greetingPending && !greetingAudioHeard) {
                console.warn("tts_end before greeting audio — keeping mic closed");
                isAiSpeaking = false;
                ttsEndTimeout = null;
                return;
              }

              const scheduleSTT = () => {
                greetingPending = false;
                if (greetingFallbackTimer) {
                  clearTimeout(greetingFallbackTimer);
                  greetingFallbackTimer = null;
                }
                isAiSpeaking = false;
                if (listeningPaused) {
                  setVisualizerState("paused");
                  const el = $("#status");
                  if (el) el.textContent = "TAP BALL TO LISTEN";
                } else {
                  setVisualizerState("listening");
                  setStatus("listening");
                  if (!isRecording) {
                    setTimeout(() => {
                      if (!isAiSpeaking && !listeningPaused && !isRecording && !greetingPending) startSTT();
                    }, POST_TTS_PAD_MS);
                  }
                }
                ttsEndTimeout = null;
              };
              if (remaining > 0) ttsEndTimeout = setTimeout(scheduleSTT, remaining * 1000);
              else scheduleSTT();
            }
          } catch {}
        }
      };

      ws.onclose = () => {
        greetingPending = false;
        listeningPaused = false;
        discardNextRecording = false;
        clearPendingReply();
        if (greetingFallbackTimer) {
          clearTimeout(greetingFallbackTimer);
          greetingFallbackTimer = null;
        }
        addChatMessage("Call ended", "system");
        stopSTT();
        if (globalStream) {
          globalStream.getTracks().forEach((t) => t.stop());
          globalStream = null;
        }
        if (visualizerInterval) clearInterval(visualizerInterval);
        setStatus("ready");
        setVisualizerState(null);
        const btnCall = $("#btnCall") as HTMLButtonElement | null;
        const btnHangup = $("#btnHangup") as HTMLButtonElement | null;
        if (btnCall) btnCall.disabled = false;
        if (btnHangup) btnHangup.disabled = true;
        if (langSelect) langSelect.disabled = false;
        if (audioCtx) {
          audioCtx.close().then(() => {
            audioCtx = null;
          });
        }
      };
    }

    function hangup() {
      if (ws) ws.close();
      if (globalStream) {
        globalStream.getTracks().forEach((t) => t.stop());
        globalStream = null;
      }
      if (visualizerInterval) clearInterval(visualizerInterval);
      setVisualizerState(null);
    }

    aiContainer.title = "Tap to finish speaking and transcribe";
    aiContainer.style.cursor = "pointer";
    const onBallClick = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (isAiSpeaking || greetingPending) return;
      const recordingNow =
        (mediaRecorder && mediaRecorder.state === "recording") ||
        (recognition && isRecording && !listeningPaused);
      if (recordingNow) commitUtterance();
      else resumeListening();
    };
    aiContainer.addEventListener("click", onBallClick);

    const btnCall = $("#btnCall") as HTMLButtonElement | null;
    const btnHangup = $("#btnHangup") as HTMLButtonElement | null;
    if (btnCall) btnCall.onclick = () => {
      void startCall();
    };
    if (btnHangup) btnHangup.onclick = hangup;

    const onKey = (e: KeyboardEvent) => {
      if (e.target && ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT"))
        return;
      if (e.key.toLowerCase() === "c") btnCall?.click();
      if (e.key.toLowerCase() === "h") btnHangup?.click();
    };
    window.addEventListener("keydown", onKey);

    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((stream) => stream.getTracks().forEach((t) => t.stop()))
      .catch(() => addChatMessage("Please allow microphone access", "system"));

    fetch("/config")
      .then((r) => r.json())
      .then((cfg) => {
        const wanted = Boolean(cfg?.providers?.stt?.serverSide && cfg?.providers?.stt?.configured);
        useServerStt = wanted && Boolean(window.MediaRecorder);
        console.log(
          `STT mode: ${useServerStt ? "server (" + cfg.providers.stt.model + ")" : "browser Web Speech API"}`
        );
      })
      .catch(() => {});

    return () => {
      window.removeEventListener("keydown", onKey);
      aiContainer.removeEventListener("click", onBallClick);
      hangup();
      stopSTT();
    };
  }, []);

  return (
    <>
      <header className="header">
        <div className="brand">
          <img src="/logo.svg" alt="El Sewedy Electric Logo" />
        </div>
      </header>

      <main className="main-container">
        <section className="visualizer-section">
          <div className="ai-core-container" id="aiContainer">
            <div className="ai-ring ring-3" />
            <div className="ai-ring ring-2" />
            <div className="ai-ring ring-1" />
            <div className="ai-core" />
          </div>
          <div className="status-display">
            <h2 className="status-title" id="ui-title">
              AI Receptionist
            </h2>
            <div className="status-sub" id="status">
              READY TO CONNECT
            </div>
          </div>
        </section>

        <section className="interaction-section">
          <div className="chat-container" id="chatLog" />
          <div className="controls-container">
            <select id="langSelect" className="lang-select" defaultValue="en" aria-label="Language">
              <option value="en">English</option>
              <option value="ar">العربية (Egyptian)</option>
            </select>
            <div className="control-row">
              <button id="btnCall" className="btn btn-primary" type="button">
                <span className="icon">📞</span> <span id="btnCallText">Start Call</span>
              </button>
              <button id="btnHangup" className="btn btn-danger" disabled title="End Call" type="button">
                <span className="icon">✕</span>
              </button>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
