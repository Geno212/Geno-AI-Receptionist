// ===== Utilities =====
    const $ = sel => document.querySelector(sel);
    const chatLog = $('#chatLog');
    const aiContainer = $('#aiContainer');
    
    // The interface remains neutral; spoken language is detected per utterance.
    const translations = {
      "en-US": {
        "title": "AI Receptionist",
        "status_ready": "READY TO CONNECT",
        "status_connecting": "CONNECTING...",
        "status_incall": "CALL ACTIVE",
        "status_listening": "LISTENING...",
        "status_speaking": "SPEAKING...",
        "btn_call": "Start Call"
      }
    };

    function addChatMessage(text, type) {
      const div = document.createElement('div');
      div.className = `msg ${type}`;
      div.textContent = text;
      
      const time = document.createElement('span');
      time.className = 'msg-time';
      const now = new Date();
      time.textContent = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0');
      div.appendChild(time);

      chatLog.appendChild(div);
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    function clearChat() {
      chatLog.innerHTML = '';
    }

    // Whisper invents YouTube-style outros on silence/noise. Reject those only —
    // every real language remains acceptable for STT.
    function isSpuriousTranscript(text) {
      const t = (text || '').trim();
      if (!t) return true;
      const lower = t.toLowerCase();
      const hallucinations = [
        'thanks for watching', 'thank you for watching', 'thanks for listening',
        'дякую за перегляд', 'подписывайтесь', 'subscribe', 'please subscribe',
        'like and subscribe', 'see you next time', 'thanks for tuning in',
        'amara.org', 'www.youtube.com', 'ترجمة نانسي قنقر'
      ];
      return hallucinations.some(h => lower.includes(h));
    }
    
    function setStatus(key) {
      const t = translations["en-US"];
      const text = t[`status_${key}`] || key;
      $('#status').textContent = text;
    }

    function setVisualizerState(state) {
      aiContainer.classList.remove('state-listening', 'state-speaking', 'state-paused');
      if(state) aiContainer.classList.add(`state-${state}`);
    }

    function stopListening({ discard = true } = {}) {
      listeningPaused = true;
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        discardNextRecording = discard;
        try { mediaRecorder.stop(); } catch (e) {}
      } else {
        stopSTT();
      }
      setVisualizerState('paused');
      $('#status').textContent = 'TAP BALL TO LISTEN';
    }

    function resumeListening() {
      if (!ws || ws.readyState !== WebSocket.OPEN || isAiSpeaking || greetingPending) return;
      listeningPaused = false;
      discardNextRecording = false;
      if (!isRecording) startSTT();
    }

    // Red ball: tap to stop/start listening when VAD keeps running after you stop talking.
    aiContainer.title = 'Tap to stop or start listening';
    aiContainer.style.cursor = 'pointer';
    aiContainer.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (isAiSpeaking || greetingPending) return;
      if (isRecording && !listeningPaused) stopListening({ discard: true });
      else resumeListening();
    });

    // ===== Direct WebSocket Setup =====
    let ws;
    let recognition;
    let isRecording = false;
    // Whether to use server-side Whisper (/stt) instead of the browser engine.
    // Resolved from GET /config at load; flipped to false if /stt ever fails,
    // so a server outage degrades to browser recognition instead of silence.
    let useServerStt = false;
    let isAiSpeaking = false;
    let isCommitting = false;
    let ttsEndTimeout = null; // Store timeout to cancel it if new audio arrives
    // Don't open the mic until Geno's greeting finishes (or a short fallback).
    // Listening during/just-after silence is when Whisper invents fake phrases.
    let greetingPending = false;
    let greetingFallbackTimer = null;
    let listeningPaused = false;
    let discardNextRecording = false;
    // Hold LLM text until PCM actually starts so chat and speech appear together.
    let pendingReplyText = null;
    let pendingReplyTimer = null;

    function flushPendingReply() {
      if (pendingReplyTimer) {
        clearTimeout(pendingReplyTimer);
        pendingReplyTimer = null;
      }
      if (!pendingReplyText) return;
      const text = pendingReplyText;
      pendingReplyText = null;
      addChatMessage(text, 'ai');
    }

    function clearPendingReply() {
      if (pendingReplyTimer) {
        clearTimeout(pendingReplyTimer);
        pendingReplyTimer = null;
      }
      pendingReplyText = null;
    }
    
    // Audio Context & PCM Player & Analyzer
    let audioCtx;
    let analyser;
    let microphoneStream;
    let globalStream; // Store stream to stop tracks later
    let dataArray;
    let visualizerInterval;
    
    let nextStartTime = 0;
    const SAMPLE_RATE = 24000; // Must match server output_format=pcm_24000
    let pcmBufferQueue = new Uint8Array(0); // Buffer for split frames

    // VAD Parameters
    const VAD_THRESHOLD = 15; // Volume threshold (0-255)
    let silenceStart = null;
    let speechDetected = false;

    async function startCall(){
      if(isRecording) return;
      setStatus('connecting');
      
      // Initialize Audio Context on user gesture
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      nextStartTime = 0;
      pcmBufferQueue = new Uint8Array(0);

      // Start Microphone Analysis (Visualizer + VAD)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: { 
                echoCancellation: true, 
                noiseSuppression: true, 
                autoGainControl: true 
            } 
        });
        globalStream = stream; // Save reference
        microphoneStream = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        microphoneStream.connect(analyser);
        
        const bufferLength = analyser.frequencyBinCount;
        dataArray = new Uint8Array(bufferLength);
        
        startVisualizer();
      } catch (e) {
        console.error("Mic analysis failed:", e);
        // Continue anyway, just without visualizer/custom VAD
      }

      // 1. Connect WebSocket
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${window.location.host}/client-ws`);
      ws.binaryType = 'arraybuffer';

      ws.onopen = async () => {
        clearChat();
        addChatMessage("Connected to server", "system");
        setStatus('incall');
        $('#btnCall').disabled = true;
        $('#btnHangup').disabled = false;

        // Wait for the server greeting to finish before listening.
        greetingPending = true;
        if (greetingFallbackTimer) clearTimeout(greetingFallbackTimer);
        greetingFallbackTimer = setTimeout(() => {
          if (greetingPending && ws && ws.readyState === WebSocket.OPEN && !isRecording) {
            greetingPending = false;
            startSTT();
          }
        }, 8000);
      };

      ws.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          // New audio chunk received
          if (ttsEndTimeout) {
            clearTimeout(ttsEndTimeout);
            ttsEndTimeout = null;
          }

          if (!isAiSpeaking) {
            isAiSpeaking = true;
            stopSTT(); // Stop listening to avoid echo
            setVisualizerState('speaking');
            setStatus('speaking');
            // Reset timing for new utterance
            nextStartTime = audioCtx.currentTime + 0.05;
            // Reveal chat text when scheduled playback begins (not when TTS finished generating).
            if (pendingReplyText && !pendingReplyTimer) {
              const delayMs = Math.max(0, (nextStartTime - audioCtx.currentTime) * 1000);
              pendingReplyTimer = setTimeout(flushPendingReply, delayMs);
            }
          }
          playPCMChunk(event.data);
        } else {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'reply' && msg.text) {
              // Stash until first audio plays — don't show text early while TTS generates.
              clearPendingReply();
              pendingReplyText = msg.text;
            } else if (msg.type === 'tts_end') {
              // If TTS sent no audio at all, still show the text.
              if (pendingReplyText && !pendingReplyTimer) flushPendingReply();
              // We don't need to do anything special for PCM end, 
              // just wait for the queue to finish playing?
              // We can estimate when it finishes based on nextStartTime
              const remaining = nextStartTime - audioCtx.currentTime;
              
              // Clear any existing timeout just in case
              if (ttsEndTimeout) clearTimeout(ttsEndTimeout);

              const scheduleSTT = () => {
                   greetingPending = false;
                   if (greetingFallbackTimer) {
                     clearTimeout(greetingFallbackTimer);
                     greetingFallbackTimer = null;
                   }
                   isAiSpeaking = false;
                   if (listeningPaused) {
                     setVisualizerState('paused');
                     $('#status').textContent = 'TAP BALL TO LISTEN';
                   } else {
                     setVisualizerState('listening');
                     setStatus('listening');
                     if (!isRecording) startSTT();
                   }
                   ttsEndTimeout = null;
              };

              if (remaining > 0) {
                ttsEndTimeout = setTimeout(scheduleSTT, remaining * 1000);
              } else {
                 scheduleSTT();
              }
            }
          } catch(e) {}
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
        
        // Stop Mic Stream
        if(globalStream) {
            globalStream.getTracks().forEach(track => track.stop());
            globalStream = null;
        }
        if(visualizerInterval) clearInterval(visualizerInterval);

        setStatus('ready');
        setVisualizerState(null);
        $('#btnCall').disabled = false;
        $('#btnHangup').disabled = true;
        if (audioCtx) audioCtx.close().then(() => audioCtx = null);
      };
    }

    function playPCMChunk(arrayBuffer) {
        if (!audioCtx) return;
        
        // Append new data to queue
        const newChunk = new Uint8Array(arrayBuffer);
        const combined = new Uint8Array(pcmBufferQueue.length + newChunk.length);
        combined.set(pcmBufferQueue);
        combined.set(newChunk, pcmBufferQueue.length);
        
        // Process only complete 16-bit samples (multiples of 2)
        const remainder = combined.length % 2;
        const processableLength = combined.length - remainder;
        
        if (processableLength === 0) {
            pcmBufferQueue = combined;
            return;
        }
        
        const processBuffer = combined.slice(0, processableLength);
        pcmBufferQueue = combined.slice(processableLength); // Keep remainder for next chunk
        
        // Convert Int16Array (raw PCM) to Float32Array
        const int16Data = new Int16Array(processBuffer.buffer);
        const float32Data = new Float32Array(int16Data.length);
        
        for (let i = 0; i < int16Data.length; i++) {
            // Normalize to [-1.0, 1.0]
            float32Data[i] = int16Data[i] / 32768.0;
        }

        const buffer = audioCtx.createBuffer(1, float32Data.length, SAMPLE_RATE);
        buffer.getChannelData(0).set(float32Data);

        const source = audioCtx.createBufferSource();
        source.buffer = buffer;

        // Create a GainNode to boost volume (helpful for mobile devices)
        const gainNode = audioCtx.createGain();
        gainNode.gain.value = 2.5; // Boost volume by 2.5x

        // Connect: Source -> Gain -> Destination
        source.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        // Schedule playback
        if (nextStartTime < audioCtx.currentTime) {
            nextStartTime = audioCtx.currentTime;
        }
        
        source.start(nextStartTime);
        nextStartTime += buffer.duration;
    }

    function startVisualizer() {
        if (visualizerInterval) clearInterval(visualizerInterval);
        
        const r1 = $('.ring-1');
        const r2 = $('.ring-2');
        const r3 = $('.ring-3');
        const core = $('.ai-core');
        
        visualizerInterval = setInterval(() => {
            if (!analyser || isAiSpeaking) return; // Don't visualize mic when AI is speaking (echo safety)
            
            analyser.getByteFrequencyData(dataArray);
            
            // Calculate average volume
            let sum = 0;
            for(let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
            }
            const average = sum / dataArray.length;
            
            // Visualizer Logic
            if (isRecording && !isAiSpeaking) {
                // Boost the effect
                const scale = 1 + (average / 256) * 1.5; 
                const opacity = 0.3 + (average / 256);
                
                core.style.transform = `scale(${0.9 + (average/256)})`;
                
                r1.style.width = `${140 * scale}px`;
                r1.style.height = `${140 * scale}px`;
                r1.style.opacity = opacity;
                
                r2.style.width = `${200 * (scale * 0.8)}px`;
                r2.style.height = `${200 * (scale * 0.8)}px`;
                
                // VAD Logic for snappy endpointing
                if (average > VAD_THRESHOLD) {
                    silenceStart = null;
                    speechDetected = true;
                    setVisualizerState('listening');
                } else {
                    if (!silenceStart) silenceStart = Date.now();
                }
            }
        }, 50);
    }

    let silenceTimer;

    // ===== Server-side STT (Groq Whisper) =====
    // The browser Web Speech API is Chrome-only and weak on Egyptian dialect.
    // When the server reports STT_SERVER_SIDE=1 we record the utterance with
    // MediaRecorder, endpoint it with the SAME volume VAD the visualizer
    // already runs, then POST it to /stt.
    //
    // Falls back to the browser API automatically if MediaRecorder is missing
    // or the server is unreachable, so this can never make things worse than
    // the previous behaviour.
    let mediaRecorder = null;
    let recordedChunks = [];
    let serverSttActive = false;
    let serverSttPollTimer = null;

    function pickRecorderMime() {
      // Whisper handles all of these; prefer ogg/opus for size, then webm.
      const candidates = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      for (const m of candidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
      }
      return '';
    }

    function startServerSTT() {
      if (!globalStream || !window.MediaRecorder) return false;
      try {
        const mimeType = pickRecorderMime();
        mediaRecorder = new MediaRecorder(globalStream, mimeType ? { mimeType } : undefined);
      } catch (e) {
        console.warn('MediaRecorder unavailable, falling back to browser STT', e);
        return false;
      }

      recordedChunks = [];
      isCommitting = false;
      serverSttActive = true;
      let speechSeen = false;

      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        clearInterval(serverSttPollTimer);
        serverSttPollTimer = null;
        const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        recordedChunks = [];
        serverSttActive = false;

        if (discardNextRecording) {
          discardNextRecording = false;
          // User tapped the ball to stop — do not transcribe leftover audio.
          return;
        }

        // Ignore blips too short to contain speech.
        if (!speechSeen || blob.size < 4000) { if (isRecording && !listeningPaused) startSTT(); return; }

        setStatus('thinking');
        $('#status').textContent = 'TRANSCRIBING...';
        try {
          // Let Whisper detect Arabic vs English from every utterance. This also
          // permits natural code-switching without a frontend language switch.
          const res = await fetch('/stt?lang=auto', {
            method: 'POST',
            headers: { 'Content-Type': blob.type || 'audio/webm' },
            body: blob
          });
          const data = await res.json();
          if (data.ok && data.text) {
            if (isSpuriousTranscript(data.text)) {
              console.warn('Ignoring spurious STT transcript:', data.text);
              if (isRecording && !listeningPaused) startSTT();
            } else {
              commitSpeech(data.text, data.language || null);
            }
          } else {
            console.warn('server STT returned nothing', data);
            if (isRecording && !listeningPaused) startSTT();
          }
        } catch (e) {
          // Network/server failure: degrade to the browser engine rather than
          // leaving the visitor with a dead microphone.
          console.warn('server STT failed, falling back to browser STT', e);
          addChatMessage('Speech service unavailable, using browser recognition', 'system');
          useServerStt = false;
          if (isRecording && !listeningPaused) startSTT();
        }
      };

      mediaRecorder.start(250);
      setVisualizerState('listening');
      setStatus('listening');
      silenceStart = Date.now();

      // Endpointing: reuse the visualizer's rolling volume analysis. Commit
      // once we have heard speech followed by SILENCE_MS of quiet.
      const SILENCE_MS = 1200;
      const MAX_UTTERANCE_MS = 20000;
      const startedAt = Date.now();
      serverSttPollTimer = setInterval(() => {
        if (!analyser || !dataArray) return;
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        if (avg > VAD_THRESHOLD) { speechSeen = true; silenceStart = null; }
        else if (!silenceStart) silenceStart = Date.now();

        const quietLongEnough = speechSeen && silenceStart && (Date.now() - silenceStart > SILENCE_MS);
        const tooLong = Date.now() - startedAt > MAX_UTTERANCE_MS;
        if ((quietLongEnough || tooLong) && mediaRecorder && mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
        }
      }, 50);

      return true;
    }

    function startSTT() {
      // Prefer server-side Whisper when available; it is browser-independent
      // and materially better at Egyptian Arabic.
      if (useServerStt && startServerSTT()) return;

      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        addChatMessage("Browser does not support Speech Recognition", "system");
        return;
      }

      if (recognition) stopSTT();

      isCommitting = false; // Reset commit flag for new turn
      recognition = new SpeechRecognition();
      
      // Web Speech has no true auto-detect mode. This path is only an emergency
      // fallback when server-side Whisper fails, so use the browser locale.
      const browserLang = (navigator.language || 'en-US').toLowerCase();
      recognition.lang = browserLang.startsWith('ar') ? 'ar-EG' : 'en-US';
      console.log("Starting fallback browser STT with locale:", recognition.lang);

      recognition.continuous = true;
      recognition.interimResults = true; 
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setVisualizerState('listening');
        setStatus('listening');
        silenceStart = Date.now(); // Initialize
      };

      recognition.onresult = (event) => {
        // Clear old dumb timer
        clearTimeout(silenceTimer);
        
        const last = event.results.length - 1;
        const text = event.results[last][0].transcript;
        const isFinal = event.results[last].isFinal;

        // Visual feedback that we are hearing text
        $('#status').textContent = "HEARD: " + (text.length > 20 ? text.substring(0,20)+"..." : text);

        if (isFinal) {
            commitSpeech(text);
        } else {
            // Smart VAD check: If we have interim text, but audio has been silent for 2500ms, force commit
            // This relies on the visualizer loop updating 'silenceStart'
            if (speechDetected && silenceStart && (Date.now() - silenceStart > 2500)) {
                 // Force commit interim result
                 commitSpeech(text);
                 recognition.stop();
            } else {
                 // Fallback timer if VAD fails or mic level is weird
                 silenceTimer = setTimeout(() => {
                    commitSpeech(text);
                }, 3500);
            }
        }
      };

      recognition.onerror = (e) => {
        if (e.error !== 'no-speech' && e.error !== 'aborted') {
            console.log('STT Error: ' + e.error);
            // If network error, try to restart
            if (e.error === 'network') setTimeout(startSTT, 1000);
        }
      };

      recognition.onend = () => {
        if (isRecording) {
            setTimeout(() => {
                if (isRecording && recognition) {
                    try { recognition.start(); } catch(e){}
                }
            }, 100);
        } 
      };

      try { recognition.start(); } catch(e){}
      isRecording = true;
    }

    function commitSpeech(text, detectedLang = null) {
        if (isCommitting) return;
        if (!text || !text.trim()) return;
        if (isSpuriousTranscript(text)) {
          console.warn('Ignoring spurious transcript:', text);
          return;
        }
        if (isAiSpeaking || greetingPending || listeningPaused) {
          console.warn('Ignoring speech while Geno is speaking/paused:', text);
          return;
        }
        
        isCommitting = true;
        clearTimeout(silenceTimer);
        addChatMessage(text, "user");
        
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'text', text: text, language: detectedLang || undefined }));
        }
        
        stopSTT();
    }

    function stopSTT() {
      isRecording = false;
      clearTimeout(silenceTimer);
      if (serverSttPollTimer) { clearInterval(serverSttPollTimer); serverSttPollTimer = null; }
      if (mediaRecorder) {
        // Detach the handler first: an explicit stop (hangup) must not trigger
        // a transcription round-trip for audio nobody is waiting on.
        if (serverSttActive) mediaRecorder.onstop = null;
        try { if (mediaRecorder.state === 'recording') mediaRecorder.stop(); } catch (e) {}
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

    function hangup(){ 
      if(ws) ws.close(); 
      if(globalStream) {
        globalStream.getTracks().forEach(track => track.stop());
        globalStream = null;
      }
      if(visualizerInterval) clearInterval(visualizerInterval);
      setVisualizerState(null); // Reset UI
    }

    // Buttons & Shortcuts
    $('#btnCall').onclick = startCall;
    $('#btnHangup').onclick = hangup;
    
    window.addEventListener('keydown', (e)=>{
      if(e.target && (e.target.tagName==='INPUT' || e.target.tagName==='SELECT')) return;
      if(e.key.toLowerCase()==='c') $('#btnCall').click();
      if(e.key.toLowerCase()==='h') $('#btnHangup').click();
    });

    // Mic permission hint
    navigator.mediaDevices?.getUserMedia({ audio: true }).then(stream=>{
      stream.getTracks().forEach(t=>t.stop());
    }).catch(()=>{ addChatMessage("Please allow microphone access", "system"); });

    // Resolve the STT mode from the server. Server-side Whisper works in every
    // browser and handles Egyptian dialect far better than the Web Speech API,
    // but it needs MediaRecorder; without it we stay on the browser engine.
    fetch('/config')
      .then(r => r.json())
      .then(cfg => {
        const wanted = Boolean(cfg?.providers?.stt?.serverSide && cfg?.providers?.stt?.configured);
        useServerStt = wanted && Boolean(window.MediaRecorder);
        if (wanted && !window.MediaRecorder) {
          console.warn('Server STT requested but MediaRecorder is unavailable; using browser recognition.');
        }
        console.log(`STT mode: ${useServerStt ? 'server (' + cfg.providers.stt.model + ')' : 'browser Web Speech API'}`);
      })
      .catch(() => { /* keep the browser engine if /config is unreachable */ });
