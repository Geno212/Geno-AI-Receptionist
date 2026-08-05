// ============================================================================
// LEGACY CODE - NOT LOADED BY THE APPLICATION
// ============================================================================
//
// Commented-out implementations extracted from server.js on 2026-07-29.
// Kept for reference only: none of this runs, and none of it is required.
//
// What is here:
//   * Twilio Media Streams telephony (bidirectional mu-law WebSocket audio)
//   * Azure Speech STT/TTS (SSML building, voice fallback, mu-law formats)
//   * Google Cloud Speech references from the original scaffold
//
// Why it was removed from server.js: it was ~462 lines of dead comments
// interleaved with live code, which made the actual request flow hard to read.
// The live pipeline is documented in docs/ARCHITECTURE.md.
//
// If telephony is ever revived, prefer rebuilding on the current provider
// layer (lib/providers.js) rather than restoring this verbatim - it predates
// the provider abstraction, the lean prompt, and the PCM/tts_end contract.
// ============================================================================

// Telephony
// const TWILIO_MEDIA_WS_PATH = "/ws";
// const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
// const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
// const TWILIO_NUMBER = process.env.TWILIO_NUMBER || "";
// const twilioRest = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;
// const SYSTEM_PROMPT = `أنت موظف استقبال لشركة السويدي إليكتريك.
// تكلّم بلهجة مصرية مهذبة واحترافية.
// جاوب على الأسئلة عن المنتجات والخدمات (كابلات، محولات، عدادات، مشاريع).
// لا تكرر الترحيب في كل رد.
// `;

// app.post("/voice", (req, res) => {
//   const wsUrl = (PUBLIC_URL.replace(/^http/, "ws") + TWILIO_MEDIA_WS_PATH);
//   console.log(`[TwiML] /voice requested from ${req.ip}. Opening stream → ${wsUrl}`);
//   const twiml = new twilio.twiml.VoiceResponse();
//   const connect = twiml.connect();
//   // Use inbound_track to receive caller audio only (avoids 31941 on accounts without bidirectional)
//   connect.stream({ url: wsUrl, track: "inbound_track", name: "ai-eg-reception" });
//   res.type("text/xml").send(twiml.toString());
// });

// app.post("/client-voice", (req, res) => {
//   const wsUrl = (PUBLIC_URL.replace(/^http/, "ws") + TWILIO_MEDIA_WS_PATH);
//   console.log(`[TwiML] /client-voice requested from ${req.ip}. Opening stream → ${wsUrl}`);
//   const twiml = new twilio.twiml.VoiceResponse();
//   const connect = twiml.connect();
//   connect.stream({ url: wsUrl, track: "inbound_track", name: "ai-eg-reception" });
//   res.type("text/xml").send(twiml.toString());
// });

// Approval Mock Route (In production, this would be a Teams Button click handler)
    // tts_voice: AZURE_TTS_VOICE,
    // tts_style: AZURE_TTS_STYLE || null,
    // tts_rate: AZURE_TTS_RATE || null,
    // tts_pitch: AZURE_TTS_PITCH || null,
    // stt_region: AZURE_SPEECH_REGION || null,
    // stt_enabled: Boolean(AZURE_SPEECH_KEY && AZURE_SPEECH_REGION)
// List available voices for current region/key
// app.get("/voices", async (req, res) => {
//   try {
//     const endpoint = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
//     const resp = await fetch(endpoint, {
//       headers: {
//         "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
//         "User-Agent": "ai-receptionist-egypt"
//       }
//     });
//     if (!resp.ok) {
//       let detail = ""; try { detail = await resp.text(); } catch {}
//       return res.status(500).json({ ok: false, error: `Azure voices ${resp.status} ${detail}` });
//     }
//     const voices = await resp.json();
//     const ar = voices.filter(v => (v.Locale || v.LocaleName || "").toString().toLowerCase().includes("ar-eg"));
//     res.json({ ok: true, count: voices.length, ar_eg: ar });
//   } catch (e) {
//     res.status(500).json({ ok: false, error: e?.message || String(e) });
//   }
// });

// XML escape helper (top-level for routes that build SSML)
// function escapeXml(s) {
//   return String(s).replace(/[<>&'\"]/g, (c) => ({
//     "<": "&lt;",
//     ">": "&gt;",
//     "&": "&amp;",
//     "'": "&apos;",
//     '"': "&quot;",
//   })[c]);
// }

// function detectMainLanguage(text) {
//   const arabicPattern = /[\u0600-\u06FF]/;
//   return arabicPattern.test(text) ? "ar-EG" : "en-US";
// }

// function processTextForSSML(text, mainLang) {
//   let escaped = escapeXml(text);
//   if (mainLang === "ar-EG") {
//     // Wrap emails in en-US to ensure correct pronunciation
//     const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
//     escaped = escaped.replace(emailRegex, '<lang xml:lang="en-US">$1</lang>');
    
//     // Wrap "El Sewedy Electric" to ensure English pronunciation
//     escaped = escaped.replace(/(El Sewedy Electric)/gi, '<lang xml:lang="en-US">$1</lang>');
//   }
//   return escaped;
// }

// Top-level Azure TTS (robust): tries style on/off and multiple μ-law formats with voice + fallback
// async function synthesizeWithAzureStandalone(text) {
//   const endpoint = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
//   const mainLang = detectMainLanguage(text);

//   function buildSsml(voiceName, includeStyle) {
//     const prosodyAttrs = [
//       AZURE_TTS_RATE ? `rate=\"${AZURE_TTS_RATE}\"` : "",
//       AZURE_TTS_PITCH ? `pitch=\"${AZURE_TTS_PITCH}\"` : "",
//     ].filter(Boolean).join(" ");
//     // Only apply style if language is Arabic (styles are voice-specific)
//     const useStyle = includeStyle && AZURE_TTS_STYLE && mainLang === "ar-EG";
//     const styleOpen = useStyle ? `<mstts:express-as style=\"${AZURE_TTS_STYLE}\">` : "";
//     const styleClose = useStyle ? `</mstts:express-as>` : "";
//     return `
//       <speak version=\"1.0\" xml:lang=\"${mainLang}\" xmlns:mstts=\"https://www.w3.org/2001/mstts\">\n        <voice xml:lang=\"${mainLang}\" name=\"${voiceName}\">\n          <prosody ${prosodyAttrs}>\n            ${styleOpen}${processTextForSSML(text, mainLang)}${styleClose}\n          </prosody>\n        </voice>\n      </speak>
//     `.trim();
//   }

//   async function postTts(ssml, format) {
//     const res = await fetch(endpoint, {
//       method: "POST",
//       headers: {
//         "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
//         "X-Microsoft-OutputFormat": format,
//         "Content-Type": "application/ssml+xml",
//         "User-Agent": "ai-receptionist-egypt"
//       },
//       body: ssml
//     });
//     if (!res.ok) {
//       let detail = ""; try { detail = await res.text(); } catch {}
//       throw new Error(`Azure TTS ${res.status} ${detail}`);
//     }
//     const ab = await res.arrayBuffer();
//     return Buffer.from(ab);
//   }

//   let voices;
//   if (mainLang === "en-US") {
//     voices = [AZURE_TTS_VOICE_EN];
//   } else {
//     voices = Array.from(new Set([AZURE_TTS_VOICE, AZURE_TTS_FALLBACK_VOICE].filter(Boolean)));
//   }

//   const formats = ["raw-8khz-8bit-mono-mulaw", "audio-8khz-8bit-mono-mulaw", "riff-8khz-8bit-mono-mulaw"];
//   for (const v of voices) {
//     for (const includeStyle of [Boolean(AZURE_TTS_STYLE), false]) {
//       const ssml = buildSsml(v, includeStyle);
//       for (const fmt of formats) {
//         try { return await postTts(ssml, fmt); } catch { /* try next */ }
//       }
//     }
//   }
//   throw new Error("Azure TTS failed for all combinations");
// }

// Quick TTS check (validates Azure TTS creds/voice; returns size only)
// app.get("/tts-test", async (req, res) => {
//   const text = (req.query.text || "اختبار الصوت").toString();
//   try {
//     const buf = await synthesizeWithAzureStandalone(text);
//     res.json({ ok: true, bytes: buf.length, voice: AZURE_TTS_VOICE, region: AZURE_SPEECH_REGION });
//   } catch (e) {
//     res.status(500).json({ ok: false, error: e?.message || String(e) });
//   }
// });

// Extract raw μ-law payload from possible RIFF container
// STT self-test: synthesize μ-law sample, convert to PCM16, and recognize once
// app.get("/stt-test", async (req, res) => {
//   const text = (req.query.text || "اختبار الصوت الآن").toString();
//   try {
//     const ttsBuf = await synthesizeWithAzureStandalone(text);
//     const mulawBuf = extractMulawPayload(ttsBuf);
//     const u8 = new Uint8Array(mulawBuf.buffer, mulawBuf.byteOffset, mulawBuf.byteLength);
//     const linear16 = mulawToLinear16(u8);
//     const pcm = Buffer.from(linear16.buffer);

//     const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
//     speechConfig.speechRecognitionLanguage = "ar-EG";
//     speechConfig.setProperty(sdk.PropertyId.SpeechServiceResponse_PostProcessingOption, "TrueText");

//     const pushStream = sdk.AudioInputStream.createPushStream(
//       sdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1)
//     );
//     pushStream.write(pcm);
//     pushStream.close();
//     const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
//     const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
//     const result = await new Promise((resolve, reject) => {
//       recognizer.recognizeOnceAsync(
//         r => { try { recognizer.close(); } catch {} resolve(r); },
//         err => { try { recognizer.close(); } catch {} reject(err); }
//       );
//     });
//     res.json({ ok: true, provided_text: text, recognized_text: result?.text || null });
//   } catch (e) {
//     res.status(500).json({ ok: false, error: e?.message || String(e) });
//   }
// });

// app.get("/token", (req, res) => {
//   if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET || !TWILIO_TWIML_APP_SID) {
//     return res.status(500).json({ error: "Twilio client env vars missing" });
//   }
//   const identity = (req.query.identity || TWILIO_CLIENT_IDENTITY).toString();
//   const AccessToken = twilio.jwt.AccessToken;
//   const VoiceGrant = AccessToken.VoiceGrant;
//   const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { identity, ttl: 3600 });
//   const voiceGrant = new VoiceGrant({ outgoingApplicationSid: TWILIO_TWIML_APP_SID, incomingAllow: true });
//   token.addGrant(voiceGrant);
//   res.json({ identity, token: token.toJwt() });
// });

// Trigger an outbound call so Twilio calls your phone and connects to the AI stream
// Body: { "to": "+2010..." }
// app.post("/call", async (req, res) => {
//   try {
//     const to = (req.body?.to || "").toString();
//     if (!to) return res.status(400).json({ error: "Missing 'to' E.164 number" });
//     if (!twilioRest || !TWILIO_NUMBER) return res.status(500).json({ error: "Twilio outbound env vars missing" });
//     const call = await twilioRest.calls.create({
//       to,
//       from: TWILIO_NUMBER,
//       // When the call is answered, Twilio fetches TwiML from here, which opens the media stream
//       url: `${PUBLIC_URL.replace(/\/$/, "")}/voice`
//     });
//     res.json({ sid: call.sid, to });
//   } catch (e) {
//     res.status(500).json({ error: e.message });
//   }
// });
// μ-law decode table
// const MULAW_DECODE_TABLE = (() => {
//   const BIAS = 0x84;
//   const table = new Int16Array(256);
//   for (let i = 0; i < 256; i++) {
//     let mu = ~i & 0xff;
//     let t = ((mu & 0x0F) << 3) + BIAS;
//     t <<= ((mu & 0x70) >> 4);
//     let s = (mu & 0x80) ? (BIAS - t) : (t - BIAS);
//     table[i] = s;
//   }
//   return table;
// })();

// function mulawToLinear16(u8arr) {
//   const out = new Int16Array(u8arr.length);
//   for (let i = 0; i < u8arr.length; i++) out[i] = MULAW_DECODE_TABLE[u8arr[i]];
//   return out;
// }
        // For second part (00-99), we can rely on TTS reading "thirty-eight" for "38"
        // So "nineteen 38" works for most TTS engines to say "nineteen thirty eight"
        // BUT to be safe, we can convert small numbers too if we want, or just let it be.
        // Azure usually handles "nineteen 38" correctly.
        
        // However, we must be careful not to break logic.
        // Let's return words if we are sure.
// function handleTwilioConnection(ws) {
//   console.log("Twilio connected");
//   const db = loadDB();
//   const convo = [ { role: "system", content: SYSTEM_PROMPT } ];
//   const caller = { phone: null };
//   let streamSid = null; // Twilio stream identifier needed for outbound audio

//   let azurePushStream = null; // Azure STT push stream
//   let azureRecognizer = null; // Azure STT recognizer
//   const useAzureSTT = false;

//   async function startSpeechStream() {
    // if (useAzureSTT) {
    //   if (azureRecognizer) return;
    //   try {
    //     const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
    //     speechConfig.speechRecognitionLanguage = "ar-EG";
    //     speechConfig.setProperty(sdk.PropertyId.SpeechServiceResponse_PostProcessingOption, "TrueText");

    //     azurePushStream = sdk.AudioInputStream.createPushStream(
    //       sdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1)
    //     );
    //     const audioConfig = sdk.AudioConfig.fromStreamInput(azurePushStream);
    //     // Use the configured speechConfig so properties (e.g., TrueText) apply
    //     azureRecognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    //     azureRecognizer.speechRecognitionLanguage = "ar-EG";

    //     azureRecognizer.recognizing = async (_s, e) => {
    //       const text = e?.result?.text?.trim();
    //       if (!text) return;
    //       if (process.env.LOG_TRANSCRIPTS) console.log("STT PART", text);
    //     };

    //     azureRecognizer.recognized = async (_s, e) => {
    //       const text = e?.result?.text?.trim();
    //       if (!text) return;
    //       if (process.env.LOG_TRANSCRIPTS) console.log("STT FINAL", text);
    //       await handleFinalTranscript(text);
    //     };

    //     azureRecognizer.canceled = (_s, e) => {
    //       console.error("Azure STT canceled", e?.errorDetails || e?.reason || "");
    //     };
    //     azureRecognizer.sessionStopped = () => {
    //       if (process.env.LOG_TRANSCRIPTS) console.log("Azure STT session stopped");
    //     };

    //     azureRecognizer.startContinuousRecognitionAsync();
    //   } catch (err) {
    //     console.error("Azure STT init error", err?.message || err);
    //   }
    // }
  // }

  // async function handleFinalTranscript(text) {
  //   convo.push({ role: "user", content: text });
  //   const llm = await callLLM(convo);
  //   let reply = llm || "تمام، تحت أمرك";

  //   // Parse optional <tool>{...}</tool>
  //   const m = reply.match(/<tool>([\s\S]*?)<\/tool>/);
  //   if (m) {
  //     try {
  //       const action = JSON.parse(m[1]);
  //       if (action?.name === "place_reservation") {
  //         const { name, phone, party_size, iso_datetime } = action.args || {};
  //         const when = Date.parse(iso_datetime);
  //         const r = placeReservation(db, { phone_e164: phone || caller.phone || "+201000000000", name: name || "ضيف", party_size: Number(party_size)||2, reserved_at: when || (Date.now()+3600000) });
  //         reply = reply.replace(m[0], "");
  //         reply = `اتأكد الحجز. ${reply.trim()}`;
  //         if (process.env.LOG_TRANSCRIPTS) console.log("Reservation stored", r);
  //       }
  //     } catch (e) { console.warn("Bad tool JSON"); }
  //   }

  //   convo.push({ role: "assistant", content: reply });
  //   await speak(reply);
  // }

  // async function speak(text) {
  //   try {
  //     if (!streamSid) {
  //       console.warn("No streamSid yet; cannot send audio to Twilio.");
  //       return;
  //     }
  //     // const buf = await synthesizeWithAzureRobust(text);

  //     // Optional: clear any pending audio on Twilio side
  //     try { ws.send(JSON.stringify({ event: "clear", streamSid })); } catch {}

  //     // Send μ-law 8k audio back in small frames; chunk on binary boundaries then base64-encode per frame
  //     // const frameSizeBytes = 160; // 20ms at 8kHz μ-law
  //     // for (let i = 0; i < buf.length; i += frameSizeBytes) {
  //     //   const frame = buf.subarray(i, i + frameSizeBytes);
  //     //   const b64 = frame.toString("base64");
  //     //   ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
  //     // }
  //     ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts_done" } }));
  //   } catch (e) {
  //     console.error("TTS error", e.message);
  //   }
  // }

  // Robust TTS: tries with/without style and multiple mulaw formats
  // async function synthesizeWithAzureRobust(text) {
  //   const endpoint = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  //   const mainLang = detectMainLanguage(text);

  //   function buildSsml(voiceName, includeStyle) {
  //     const prosodyAttrs = [
  //       AZURE_TTS_RATE ? `rate=\"${AZURE_TTS_RATE}\"` : "",
  //       AZURE_TTS_PITCH ? `pitch=\"${AZURE_TTS_PITCH}\"` : "",
  //     ].filter(Boolean).join(" ");
  //     const useStyle = includeStyle && AZURE_TTS_STYLE && mainLang === "ar-EG";
  //     const styleOpen = useStyle ? `<mstts:express-as style=\"${AZURE_TTS_STYLE}\">` : "";
  //     const styleClose = useStyle ? `</mstts:express-as>` : "";
  //     return `
  //       <speak version=\"1.0\" xml:lang=\"${mainLang}\" xmlns:mstts=\"https://www.w3.org/2001/mstts\">\n          <voice xml:lang=\"${mainLang}\" name=\"${voiceName}\">\n            <prosody ${prosodyAttrs}>\n              ${styleOpen}${processTextForSSML(text, mainLang)}${styleClose}\n            </prosody>\n          </voice>\n        </speak>
  //     `.trim();
  //   }

  //   let voices;
  //   if (mainLang === "en-US") {
  //     voices = [AZURE_TTS_VOICE_EN];
  //   } else {
  //     voices = Array.from(new Set([AZURE_TTS_VOICE, AZURE_TTS_FALLBACK_VOICE].filter(Boolean)));
  //   }

  //   const formats = ["raw-8khz-8bit-mono-mulaw", "audio-8khz-8bit-mono-mulaw", "riff-8khz-8bit-mono-mulaw"];
  //   let lastErr = null;
  //   for (const v of voices) {
  //     for (const includeStyle of [Boolean(AZURE_TTS_STYLE), false]) {
  //       const ssml = buildSsml(v, includeStyle);
  //       for (const fmt of formats) {
  //         try {
  //           const res = await fetch(endpoint, {
  //             method: "POST",
  //             headers: {
  //               "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
  //               "X-Microsoft-OutputFormat": fmt,
  //               "Content-Type": "application/ssml+xml",
  //               "User-Agent": "ai-receptionist-egypt"
  //             },
  //             body: ssml
  //           });
  //           if (!res.ok) throw new Error(`Azure TTS ${res.status}`);
  //           const ab = await res.arrayBuffer();
  //           return Buffer.from(ab);
  //         } catch (e) {
  //           lastErr = e;
  //         }
  //       }
  //     }
  //   }
  //   throw lastErr || new Error("Azure TTS failed");
  // }

  // function escapeXml(s) {
  //   return String(s).replace(/[<>&'\"]/g, (c) => ({
  //     "<": "&lt;",
  //     ">": "&gt;",
  //     "&": "&amp;",
  //     "'": "&apos;",
  //     '"': "&quot;",
  //   })[c]);
  // }

  // ws.on("message", async (msg) => {
  //   let data; try { data = JSON.parse(msg.toString()); } catch { return; }
  //   const event = data.event;

  //   if (event === "start") {
  //     streamSid = data.start?.streamSid || null;
  //     console.log("Stream start", streamSid);
  //     caller.phone = data.start?.customParameters?.caller || null;
  //     startSpeechStream();
  //     if (GREETING_ON_START) {
  //       // Short Azure TTS greeting using configured voice
  //       speak(GREETING_TEXT).catch(()=>{});
  //     }
  //   } else if (event === "media") {
  //     const b64 = data.media?.payload;
  //     if (!b64) return;
  //     const mulaw = Buffer.from(b64, "base64");
  //     const linear16 = mulawToLinear16(mulaw);
  //     const pcm = Buffer.from(linear16.buffer);
  //     // if (useAzureSTT && azurePushStream) {
  //     //   try { azurePushStream.write(pcm); } catch {}
  //     // }
  //   } else if (event === "stop") {
  //     console.log("Stream stop");
  //     // if (useAzureSTT) {
  //     //   try { if (azurePushStream) azurePushStream.close(); } catch {}
  //     //   azurePushStream = null;
  //     //   try { if (azureRecognizer) azureRecognizer.stopContinuousRecognitionAsync(); } catch {}
  //     //   try { if (azureRecognizer) azureRecognizer.close(); } catch {}
  //     //   azureRecognizer = null;
  //     // }
  //     ws.close();
  //   } else if (event === "connected") {
  //     // Twilio occasionally sends events; ignore
  //   }
  // });

  // ws.on("close", () => {
  //   // if (useAzureSTT) {
  //   //   try { if (azurePushStream) azurePushStream.close(); } catch {}
  //   //   azurePushStream = null;
  //   //   try { if (azureRecognizer) azureRecognizer.stopContinuousRecognitionAsync(); } catch {}
  //   //   try { if (azureRecognizer) azureRecognizer.close(); } catch {}
  //   //   azureRecognizer = null;
  //   // }
  // });
// }
