// AI Egyptian Restaurant Receptionist
// Twilio Media Streams <-> Azure Speech STT + TTS + LLM tool actions
// Author: Generated scaffold
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
// TwiML will be produced by Twilio's helper library instead of xmlbuilder2
const http = require("http");
const WebSocket = require("ws");
// const twilio = require("twilio");
// const sdk = require("microsoft-cognitiveservices-speech-sdk");

// ========== ENV ==========
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// TTS Configuration
const TTS_PROVIDER = process.env.TTS_PROVIDER || "elevenlabs"; // "elevenlabs" or "azure"

// Azure TTS
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || "";
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || "eastus";
// Suggested voices: "ar-EG-SalmaNeural" (Female), "ar-EG-ShakirNeural" (Male)
const AZURE_TTS_VOICE = process.env.AZURE_TTS_VOICE || "ar-EG-SalmaNeural"; 
const AZURE_TTS_STYLE = process.env.AZURE_TTS_STYLE || ""; // e.g., "cheerful"
const AZURE_TTS_RATE = process.env.AZURE_TTS_RATE || "0.9";
const AZURE_TTS_PITCH = process.env.AZURE_TTS_PITCH || "0Hz";

// LLM
const LLM_PROVIDER = process.env.LLM_PROVIDER || "openai";
const LLM_BASE_URL = process.env.LLM_BASE_URL || "";
const LLM_MODEL = process.env.LLM_MODEL || "";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
const CF_API_TOKEN = process.env.CF_API_TOKEN || "";
const CF_MODEL = process.env.CF_MODEL || "@cf/meta/llama-3.1-8b-instruct";

// ElevenLabs
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Default voice

// Telephony
// const TWILIO_MEDIA_WS_PATH = "/ws";
// const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
// const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
// const TWILIO_NUMBER = process.env.TWILIO_NUMBER || "";
// const twilioRest = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

const GREETING_ON_START = (process.env.GREETING_ON_START ?? "1") === "1";
const GREETING_TEXT = process.env.GREETING_TEXT || "أهلاً بك في السويدي إليكتريك. أنا جينو. Welcome to El Sewedy Electric. I am Geno. How can I help you? 你好，欢迎来到 Elsewedy Electric。";

// ========== LIGHT DB (JSON file) ==========
const dbPath = path.join(__dirname, "db.json");
function loadDB() { 
  if (!fs.existsSync(dbPath)) {
    // Minimal init if missing
    fs.writeFileSync(dbPath, JSON.stringify({ company_info: {}, customers: [], reservations: [], meetings: [], counters: { customers: 0, reservations: 0 } }, null, 2)); 
  }
  return JSON.parse(fs.readFileSync(dbPath, "utf8")); 
}
function saveDB(db) { fs.writeFileSync(dbPath, JSON.stringify(db, null, 2)); }

function calculateLevenshtein(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          Math.min(
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1 // deletion
          )
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function getTrigrams(str) {
  const trigrams = new Map();
  // Padding with spaces helps with start/end of words
  const padded = "  " + str + "  ";
  for (let i = 0; i < padded.length - 2; i++) {
    const gram = padded.substring(i, i + 3);
    trigrams.set(gram, (trigrams.get(gram) || 0) + 1);
  }
  return trigrams;
}

// Calculate Cosine Similarity based on Trigram frequency vectors
function calculateCosineSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  // Normalize
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  
  if (s1 === s2) return 1.0;

  const bg1 = getTrigrams(s1);
  const bg2 = getTrigrams(s2);
  
  const uniqueGrams = new Set([...bg1.keys(), ...bg2.keys()]);
  let dotProduct = 0;
  let mag1 = 0;
  let mag2 = 0;
  
  for (const gram of uniqueGrams) {
    const count1 = bg1.get(gram) || 0;
    const count2 = bg2.get(gram) || 0;
    dotProduct += count1 * count2;
    mag1 += count1 * count1;
    mag2 += count2 * count2;
  }
  
  if (mag1 === 0 || mag2 === 0) return 0;
  
  const score = dotProduct / (Math.sqrt(mag1) * Math.sqrt(mag2));
  
  // Debug logging for Cosine logic if match failed but expected
  if (score > 0.3 && score < 0.6) {
      // console.log(`[CosDebug] '${s1}' vs '${s2}' -> Score:${score.toFixed(2)} Trigrams1:${bg1.size} Trigrams2:${bg2.size}`);
  }
  
  return score;
}

// Check if two strings are similar (Hybrid Fuzzy Match: Levenshtein + Cosine)
// Returns true if similarity >= threshold
function isSimilar(str1, str2, threshold = 0.6) {
  if (!str1 || !str2) return false;
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  
  // 1. Exact or Substring match (Fast Path)
  if (s1.includes(s2) || s2.includes(s1)) return true;

  // 2. Hybrid Similarity Score
  const levDistance = calculateLevenshtein(s1, s2);
  const maxLength = Math.max(s1.length, s2.length);
  const levSimilarity = 1 - (levDistance / maxLength);
  
  const cosineSimilarity = calculateCosineSimilarity(s1, s2);
  
  // Use the Maximum of the two metrics
  const hybridScore = Math.max(levSimilarity, cosineSimilarity);
  
  // Debug if close to threshold or failed but had some similarity
  // Log all hybrid attempts that have some potential (>0.3) to see why they fail
  if (hybridScore > 0.3) {
     console.log(`[Fuzzy] '${s1}' vs '${s2}' -> Lev:${levSimilarity.toFixed(2)}, Cos:${cosineSimilarity.toFixed(2)}, Final:${hybridScore.toFixed(2)}`);
  }

  if (hybridScore >= threshold) return true;

  // 3. Last Name / Part Matching Logic
  // Check if *any part* of s1 matches *any part* of s2 (e.g. "El-Eskandarany" in "Sherif El-Eskandarany")
  // or "Abdrahmane" matches "abdulrahman" (handled by hybrid above if tokens align)
  
  const parts1 = s1.split(/[\s-]+/); // Split by space or hyphen
  const parts2 = s2.split(/[\s-]+/);
  
  for (const p1 of parts1) {
    if (p1.length < 3) continue; // Skip short parts like "El", "Al", "Mr"
    for (const p2 of parts2) {
       if (p2.length < 3) continue;
       
       // Compare parts using hybrid score too
       const partLev = 1 - (calculateLevenshtein(p1, p2) / Math.max(p1.length, p2.length));
       const partCos = calculateCosineSimilarity(p1, p2);
       const partScore = Math.max(partLev, partCos);
       
       // Lower threshold for single word matching to handle variations like "Abdrahmane" vs "abdulrahman"
       if (partScore >= 0.68) return true;
    }
  }

  return false;
}

// Pending approvals: { requestId: { status: 'pending'|'approved'|'rejected', resolve: func, meeting: obj } }
const pendingApprovals = new Map();

function findOrCreateCustomer(db, { phone_e164, name }) {
  let c = db.customers.find(x => x.phone_e164 === phone_e164);
  if (!c) { db.counters.customers += 1; c = { id: db.counters.customers, phone_e164, name: name || "عميل", notes: "", created_at: Date.now() }; db.customers.push(c); }
  return c;
}
function placeReservation(db, { phone_e164, name, party_size, reserved_at }) {
  const c = findOrCreateCustomer(db, { phone_e164, name });
  db.counters.reservations += 1;
  const r = { id: db.counters.reservations, customer_id: c.id, party_size, reserved_at, status: "confirmed", source: "phone", created_at: Date.now() };
  db.reservations.push(r); saveDB(db); return r;
}

// ========== LLM helper ==========
async function callLLM(messages) {
  try {
    if (LLM_PROVIDER === "cloudflare") {
      if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !CF_MODEL) return null;
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${encodeURI(CF_MODEL)}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messages, temperature: 0.35, max_tokens: 256 })
      });
      if (!res.ok) {
        let detail = ""; try { detail = await res.text(); } catch {}
        throw new Error(`CF AI ${res.status} ${detail}`);
      }
      const data = await res.json();
      return data?.result?.response || data?.result?.output_text || null;
    } else {
      if (!LLM_BASE_URL || !LLM_MODEL) return null;
      const res = await fetch(`${LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {}) },
        body: JSON.stringify({ model: LLM_MODEL, temperature: 0.3, messages })
      });
      if (!res.ok) {
        let detail = ""; try { detail = await res.text(); } catch {}
        throw new Error(`LLM ${res.status} ${detail}`);
      }
      const data = await res.json();
      return data?.choices?.[0]?.message?.content || null;
    }
  } catch (e) {
    console.error("LLM error", e.message);
    return null;
  }
}

// ========== Express + Twilio Webhook (TwiML) ==========
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

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
app.get("/approve", (req, res) => {
  const id = req.query.id;
  const action = req.query.action || "approve"; // approve or reject
  if (pendingApprovals.has(id)) {
    const entry = pendingApprovals.get(id);
    entry.status = action === "approve" ? "approved" : "rejected";
    if (entry.resolve) entry.resolve(entry.status);
    pendingApprovals.delete(id);
    return res.send(`<h1>Meeting ${action}d</h1><p>You can close this window.</p>`);
  }
  res.status(404).send("Request not found or expired.");
});

app.get("/health", (req, res) => res.json({ ok: true }));

// Minimal diagnostics (no secrets)
app.get("/config", (req, res) => {
  res.json({
    port: PORT,
    public_url: PUBLIC_URL,
    llm_provider: LLM_PROVIDER,
    llm_base_url: LLM_BASE_URL || null,
    llm_model: LLM_MODEL || null,
    cf_account_id: CF_ACCOUNT_ID ? (CF_ACCOUNT_ID.slice(0,4)+"…") : null,
    cf_model: CF_MODEL || null,
    // tts_voice: AZURE_TTS_VOICE,
    // tts_style: AZURE_TTS_STYLE || null,
    // tts_rate: AZURE_TTS_RATE || null,
    // tts_pitch: AZURE_TTS_PITCH || null,
    // stt_region: AZURE_SPEECH_REGION || null,
    // stt_enabled: Boolean(AZURE_SPEECH_KEY && AZURE_SPEECH_REGION)
  });
});
// Quick LLM test (no secrets in response)
app.post("/llm-test", async (req, res) => {
  const prompt = (req.body?.prompt || "قل مرحبا").toString();
  const messages = [
    { role: "system", content: "أجب بجملة قصيرة." },
    { role: "user", content: prompt }
  ];
  try {
    const out = await callLLM(messages);
    if (!out) return res.status(500).json({ ok: false, error: "LLM returned null" });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

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
function extractMulawPayload(buffer) {
  if (buffer && buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF") {
    let offset = 12; // skip RIFF header
    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString("ascii", offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      const dataStart = offset + 8;
      if (chunkId === "data") return buffer.slice(dataStart, Math.min(dataStart + chunkSize, buffer.length));
      offset = dataStart + chunkSize;
    }
  }
  return buffer;
}

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

const server = http.createServer(app);

// ========== WebSocket (bidirectional) ==========
// Handle both Twilio (/ws) and Browser (/client-ws)
const wss = new WebSocket.Server({ server });

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

wss.on("connection", (ws, req) => {
  const url = req.url;
  console.log(`WS connected on ${url}`);

  if (url === "/client-ws") {
    handleBrowserConnection(ws);
  // } else if (url === TWILIO_MEDIA_WS_PATH) {
  //   handleTwilioConnection(ws);
  } else {
    ws.close();
  }
});

function handleBrowserConnection(ws) {
  const db = loadDB();
  
  const info = db.company_info || {};
  const dynamicPrompt = `You are Geno, the AI Receptionist for ${info.name || "El Sewedy Electric"}.
  
  Company Info (Knowledge Base):
  ${JSON.stringify(info, null, 2)}

  Instructions:
  1. **Identity**: Your name is Geno. You are helpful, polite, and professional.
  2. **Language Detection**: Listen to the user. 
     - If English -> Reply in English.
     - If Arabic -> Reply in Egyptian Arabic (Massry).
     - If Japanese -> Reply in Japanese.
     - If Chinese -> Reply in Chinese (Mandarin).
     - If other -> Reply in that language.
     - **CRITICAL**: When asking for missing information (Name, Phone, Email), you MUST ask in the SAME language the user is speaking. Do NOT switch to English.
     - **CONSISTENCY**: Maintain the conversation language. Do NOT switch languages unless the user explicitly switches.
  3. **No Repetition**: 
     - Do NOT repeat greetings (Hello, Welcome, "I am Geno") in every turn. Only greet once at the start.
     - **Do NOT** start your response with the user's name.
     - **Do NOT** repeat the user's name in every sentence. Use it very sparingly or not at all after the first time.
  4. **Brevity**: Keep your responses extremely short and concise (max 1-2 sentences). Do not lecture.
  5. **Intelligent Data Presentation**: 
     - You have access to the 'Company Info' JSON above.
     - **Do NOT** read raw JSON, keys, or structure.
     - **Translate & Adapt**: Always present the information in the user's current language and cultural context.
       - *Hours Example (English)*: "We are open Sunday through Thursday, 9 AM to 5 PM."
       - *Hours Example (Arabic)*: "مواعيد العمل عندنا من الأحد للخميس، من 9 الصبح لـ 5 المغرب."
     - **Lists**: When listing products/services, mention 2-3 key items naturally and ask if they want more details. Do not list everything at once.
     - **News**: Summarize 'recent_news' naturally as if telling a story.
  6. **Meeting Verification**:
     - If the user says they have a meeting or appointment, ask for their **Name** and **Company** (if not known) and **Who they are meeting with**.
     - **CRITICAL**: If the user says "I have a meeting", your IMMEDIATE next response MUST be to ask for the missing details (e.g., "Who are you meeting with?"). Do NOT wait.
     - **CRITICAL**: Do NOT output the \`check_meeting\` tool until you have ALL THREE pieces of information (Visitor Name, Company, Host Name).
     - **Company Name**: If the user has not provided a company name, ASK for it. Do NOT assume "Unknown" or guess. Do not call the tool.
     - **Host Name**: Output the Host Name EXACTLY as the user said it. Do NOT autocomplete, guess, or use names from the 'Company Info' or 'leadership' list unless the user explicitly said so. If they said "Abdrahman", output "Abdrahman".
     - If any info is missing, ASK for it first. Do NOT call the tool with empty strings.
     - **CONFIRMATION**: Before outputting the \`check_meeting\` tool, you MUST confirm the collected details with the user.
       - English Ask: "Just to confirm, you are [Name] from [Company] meeting [Host]. Is that correct?"
       - Arabic Ask: "عشان أتأكد، حضرتك [الاسم] من شركة [الشركة] وهتقابل [اسم المضيف]؟ صح كده؟"
       - **STOP**: Do NOT output the tool JSON in the same response as this question. Wait for the user to answer "Yes".
       - If the user corrects you, update your info and ask again.
     - Once confirmed, output the tool JSON \`check_meeting\` IMMEDIATELY.
     - **Do NOT** say "I will check". Just output the tool. The system will handle the "Checking..." message and hold music.
  7. **Lead Generation**: 
     - If the user expresses interest in products/services, you **MUST** collect their **Name**, **Phone Number**, and **Company Name**.
     - **CONFIRMATION**: Before outputting the \`save_lead\` tool, you MUST confirm the collected details with the user.
       - English Ask: "I have your name as [Name], phone [Phone], and company [Company]. Is that correct?"
       - Arabic Ask: "تمام يا [الاسم]، بياناتك عندي: رقم التليفون [الرقم] والشركة [الشركة]. البيانات دي صحيحة؟"
       - Only output the tool JSON if the user confirms.
     - **Do NOT** end the conversation or say goodbye until you have all three pieces of information.
     - If the user provides only some info, ask for the rest in the **current conversation language**.
     - Once you have all info, output the tool JSON **IMMEDIATELY** at the start of your response.
     - **HALLUCINATION WARNING**: Do NOT invent or guess information.
       - NEVER use "John Doe" or "123456789" or "Unknown" unless the user explicitly said them.
       - If you don't have the info, ASK the user. Do NOT call the tool.
  
  **STRICT OUTPUT FORMAT**:
  - Do NOT output the tool JSON unless you have ALL required fields.
  - **NEVER** speak the words "Tool Format", "JSON", "name", "phone", or "company" in English when the user is speaking Arabic.
  - **NEVER** switch to Arabic when the user is speaking English, even if their name is Arabic.
  - **NEVER** switch languages mid-sentence or mid-response.
  - **NEVER** output text like "(Tool Format: ...)" or "Here is the JSON".
  - **NEVER** use parentheses "(...)" to give instructions or ask for info in English if the conversation is in Arabic.
  - **Spoken Terms**: When speaking in Arabic, ALWAYS translate technical terms (like 'Cables', 'Wires', 'Private Cables') to Arabic (e.g. 'كابلات', 'أسلاك', 'كابلات خاصة') in your response, even if you save them in English in the tool.
  - Just output the <tool>...</tool> block if ready, followed by your natural language response.
  - **DATA FORMAT**: When saving the lead, **ALWAYS** transliterate Arabic names to English (e.g., "Ahmed" instead of "أحمد").
   - **ONE-TIME SAVE**: Only output the <tool> block ONCE when you first collect the full info. 
   - **STOP CONDITION**: After you have successfully output the <tool> block once, do NOT output it again for the rest of the conversation.
   - **EXCEPTION**: Only output the <tool> block again if the user EXPLICITLY asks to "change", "update", or "correct" their information.
   - If the user asks normal questions (e.g. "What is the news?", "Tell me about X"), just answer them. DO NOT output the tool block.
   - **CRITICAL**: If the user asks a question and you have already saved their lead info, DO NOT output \`save_lead\` again. Just answer the question.

  **EXAMPLES OF ASKING FOR INFO**:
  - English: "Could I please have your name, phone number, and company name to assist you further?"
  - Arabic: "ممكن الاسم ورقم التليفون واسم الشركة عشان أقدر أساعدك؟"
  - Japanese: "お客様のお名前、電話番号、会社名を教えていただけますか？"
  - Chinese: "请告诉我您的姓名、电话号码和公司名称，以便我为您提供帮助。"

  Tool Schemas:
  <tool>{"name":"save_lead","args":{"name":"John Doe","phone":"+123456789","company":"El Sewedy Inc","interest":"Cables"}}</tool>
  <tool>{"name":"check_meeting","args":{"visitor_name":"John Smith","visitor_company":"Microsoft","host_name":"Ahmed Sadek"}}</tool>
`;

  const convo = [ { role: "system", content: dynamicPrompt } ];

  // Handle text messages from browser (STT done in browser)
  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "text" && data.text) {
        // Half-duplex check: If AI is speaking, ignore incoming text to prevent self-reply/echo
        if (isSpeaking) {
            console.log("Ignored input while speaking:", data.text);
            return;
        }

        console.log("Browser STT:", data.text);
        await handleTurn(data.text);
      }
    } catch (e) {}
  });

  // State to track the last saved lead to prevent duplicates
  let lastCollectedInfo = {}; // Track info for current session context
  let currentCustomerId = null; // Track database ID of current customer for updates
  let waitingForApproval = false; // Track if we are currently waiting for approval

  async function handleTurn(text) {
    // Inject system state for waiting
    if (waitingForApproval) {
      // Check if the last message was the user asking something else
      // We do not want to block them, but we want to prevent the LLM from calling check_meeting again.
      // We append a system instruction to the conversation history temporarily.
      convo.push({ role: "system", content: "STATUS UPDATE: The user is currently WAITING for meeting approval (do not call check_meeting again). 1. If the user asks a question (e.g. about company history, or Asser Emad), ANSWER IT immediately and directly. 2. Do NOT mention the meeting status again unless asked. 3. Do NOT call the check_meeting tool again." });
    }
    
    convo.push({ role: "user", content: text });
    const llm = await callLLM(convo);
    console.log("LLM Raw Output:", llm); // Debug log
    
    let reply = llm;
    if (!reply) {
      // Smart fallback based on user's input language
      if (/[\u0600-\u06FF]/.test(text)) {
         reply = "عفوا، مسمعتش كويس. ممكن تقول تاني؟";
      } else if (/[\u3040-\u309F]|[\u30A0-\u30FF]/.test(text)) {
         reply = "申し訳ありません、よく聞き取れませんでした。もう一度お願いします。";
      } else if (/[\u4E00-\u9FFF]/.test(text)) {
         reply = "抱歉，我没听清楚。请您再说一遍好吗？";
      } else {
         reply = "I apologize, I didn't catch that. Could you please repeat?";
      }
    }

    // Tool logic
    const m = reply.match(/<tool>([\s\S]*?)<\/tool>/);
    if (m) {
      // Always remove the tool tag from the spoken reply, even if parsing fails
      reply = reply.replace(m[0], "").trim();
      
      try {
        // Fix potential trailing garbage after JSON (like "}")
        let jsonStr = m[1].trim();
        // Sometimes LLM adds extra brace at end, e.g. }}
        if (jsonStr.endsWith("}}") && !jsonStr.endsWith("}}}")) {
            // Check if the JSON is valid without the last brace
            try {
                JSON.parse(jsonStr.slice(0, -1));
                jsonStr = jsonStr.slice(0, -1);
            } catch(e) {}
        }
        
        const action = JSON.parse(jsonStr);
        if (action?.name === "save_lead") {
          const { name, phone, company, interest } = action.args || {};
          const normPhone = (phone || "").trim();

          // Check for redundant tool output (loop prevention)
          if (lastCollectedInfo.phone === normPhone && 
              lastCollectedInfo.name === name && 
              lastCollectedInfo.company === company &&
              lastCollectedInfo.interest === interest) {
             console.log("ℹ️ Skipping redundant save_lead (tool repetition).");
          } else {
            // Update session
            lastCollectedInfo = { name, phone: normPhone, company, interest };

            // Anti-Hallucination Checks
            const invalidValues = ["John Doe", "Unknown", "123456789", "+123456789", "0123456789"];
            if (invalidValues.includes(name) || invalidValues.includes(phone) || (phone || "").length < 5) {
               console.log("⚠️ Rejected hallucinated lead data:", action.args);
               // Dynamic language reply
               const isAr = /[\u0600-\u06FF]/.test(text) || /[\u0600-\u06FF]/.test(reply);
               reply = isAr 
                  ? "ممكن الاسم ورقم الموبايل؟" 
                  : "Could you please tell me your name and phone number?";
            } else {
                // ... continue to DB logic ...
                if (normPhone) {
                   if (!db.customers) db.customers = [];
                   
                   let existing = null;
                   if (currentCustomerId) {
                      existing = db.customers.find(c => c.id === currentCustomerId);
                   }
                   if (!existing) {
                      existing = db.customers.find(c => c.phone === normPhone);
                   }
                   
                   let leadWasUpdated = false;
  
                   if (existing) {
                     // Update existing - check for actual changes
                     if (
                          (name && existing.name !== name) ||
                          (interest && existing.interest !== interest) ||
                          (company && existing.company !== company) ||
                          (normPhone && existing.phone !== normPhone)
                     ) {
                         // Update fields
                         if (name) existing.name = name;
                         if (interest) existing.interest = interest;
                         if (company) existing.company = company;
                         if (normPhone) existing.phone = normPhone;
                         
                         currentCustomerId = existing.id;
                         saveDB(db);
                         console.log("✅ Lead updated in DB:", existing);
                         leadWasUpdated = true;
                     } else {
                         // No changes
                         currentCustomerId = existing.id;
                         console.log("ℹ️ Lead exists and no changes detected.");
                     }
                   } else {
                     // Create new
                     db.counters.customers = (db.counters.customers || 0) + 1;
                     const lead = { 
                       id: db.counters.customers, 
                       name: name || "Client", 
                       phone: normPhone, 
                       company: company || "", 
                       interest: interest || "", 
                       created_at: Date.now() 
                     };
                     db.customers.push(lead);
                     currentCustomerId = lead.id; // Set session ID
                     saveDB(db);
                     console.log("✅ New lead saved to DB:", lead);
                     leadWasUpdated = true;
                   }
      
                   // Force confirmation message ONLY if we actually saved/updated something
                   // or if the user seems to be asking for confirmation.
                   // If user says "I am good" or switches topic to "meeting", we skip this.
                   const negativeKeywords = ["good", "no thanks", "nothing", "don't", "dont", "fine", "تمام", "شكرا", "مش عايز"];
                   const topicSwitchKeywords = ["meeting", "appointment", "schedule", "reservation", "حجز", "ميعاد", "مقابلة"];
                   
                   const isNegative = negativeKeywords.some(k => text.toLowerCase().includes(k));
                   const isTopicSwitch = topicSwitchKeywords.some(k => text.toLowerCase().includes(k));
                   
                   if (leadWasUpdated && !isNegative && !isTopicSwitch) {
                       const isAr = /[\u0600-\u06FF]/.test(text) || /[\u0600-\u06FF]/.test(reply);
                       const savedMsg = isAr 
                          ? ` (تم حفظ البيانات: الاسم ${name || existing?.name}، التليفون ${normPhone || existing?.phone}، الشركة ${company || existing?.company}. تحب تعدل حاجة؟)`
                          : ` (I have saved: Name ${name || existing?.name}, Phone ${normPhone || existing?.phone}, Company ${company || existing?.company}. Would you like to change anything?)`;
                       
                       reply = reply + savedMsg;
                   }
                }
            }
          }
        } else if (action?.name === "check_meeting") {
          let { visitor_name, visitor_company, host_name } = action.args || {};

          // Auto-fill from last collected info if missing
          if (!visitor_name && lastCollectedInfo?.name) visitor_name = lastCollectedInfo.name;
          if (!visitor_company && lastCollectedInfo?.company) visitor_company = lastCollectedInfo.company;

          // Loop prevention: If we are already waiting for approval for this exact meeting, skip tool logic
          if (waitingForApproval && 
              lastCollectedInfo.visitor_name === visitor_name && 
              lastCollectedInfo.host_name === host_name) {
             console.log("ℹ️ Skipping redundant check_meeting (already waiting).");
             // Do NOT overwrite 'reply' here, let the LLM's natural text response stand
          } else {
              // Helper to check for invalid/placeholder strings
              const isInvalid = (str) => !str || str.trim().length < 2 || str.trim() === "?" || str.toLowerCase() === "unknown";
    
              if (isInvalid(visitor_name) || isInvalid(host_name) || isInvalid(visitor_company)) {
                 // Dynamic missing info prompt
                 let missing = [];
                 const isAr = /[\u0600-\u06FF]/.test(text) || /[\u0600-\u06FF]/.test(reply);
                 
                 if (isInvalid(visitor_name)) missing.push(isAr ? "اسمك" : "your name");
                 if (isInvalid(visitor_company)) missing.push(isAr ? "اسم شركتك" : "your company name");
                 if (isInvalid(host_name)) missing.push(isAr ? "اسم الشخص اللي هتقابله" : "who you are meeting with");
                 
                 if (missing.length > 0) {
                     const list = missing.join(isAr ? " و " : " and ");
                     reply = isAr 
                       ? `ممكن تقول لي ${list} عشان أقدر أساعدك؟`
                       : `Could you please tell me ${list} to proceed?`;
                 } else {
                     reply = isAr 
                       ? `ممكن اسم الشركة عشان أقدر أساعدك؟` 
                       : `Could you please provide your company name to proceed?`;
                 }
                 // Skip processing logic if data is missing or company is unknown
              } else {
                console.log("🔍 Checking meeting:", { visitor_name, visitor_company, host_name });
                
                // Fuzzy match logic
                const meetings = db.meetings || [];
                
                // Step 2: Normal Search (only if not already confirmed)
                let bestMatch = null;
                let partialMatch = null;
    
                // 1. Check for confirmation of previous partial match
                if (lastCollectedInfo.partialMatchCandidate) {
                   const confirmationKeywords = ["yes", "yeah", "correct", "right", "sure", "exactly", "اه", "ايوة", "تمام", "صح", "مظبوط"];
                   const isConfirmed = confirmationKeywords.some(k => reply.toLowerCase().includes(k) || text.toLowerCase().includes(k));
                   
                   if (isConfirmed) {
                     bestMatch = lastCollectedInfo.partialMatchCandidate;
                     console.log("User confirmed partial match:", bestMatch.host_name);
                     lastCollectedInfo.partialMatchCandidate = null;
                   } else {
                     console.log("User did not confirm partial match. Rescanning...");
                     lastCollectedInfo.partialMatchCandidate = null;
                   }
                }
    
                // 2. Normal Fuzzy Search (if not confirmed above)
                if (!bestMatch) {
                  for (const m of meetings) {
                     // Visitor Name
                     const vNameMatch = isSimilar(m.visitor_name, visitor_name, 0.6);
                     
                     // Company
                     let vCompMatch = true;
                     if (visitor_company && m.visitor_company) {
                       vCompMatch = isSimilar(m.visitor_company, visitor_company, 0.5);
                     }
    
                     // Host Name Matching
                     // Use isSimilar which includes Levenshtein + Cosine Hybrid logic
                     const hNameMatch = isSimilar(m.host_name, host_name, 0.6);
                     
                     const lenRatio = host_name.length / m.host_name.length;
                     
                     // Debug log - hNameMatch uses the new hybrid logic!
                     console.log(`Checking: ${m.visitor_name} vs ${visitor_name} (${vNameMatch}), ${m.host_name} vs ${host_name} (Match:${hNameMatch}, LenRatio:${lenRatio.toFixed(2)})`);
    
                     if (vNameMatch && vCompMatch && hNameMatch) {
                       if (lenRatio < 0.6) {
                          partialMatch = m;
                       } else {
                          bestMatch = m; 
                          break;
                       }
                     }
                  }
                }
    
                if (bestMatch) {
                  // 1. Notify User (Speak)
                  // const waitMsg = /[\u0600-\u06FF]/.test(reply) ? 
                  //   `تمام يا فندم، لقيت ميعادك مع أستاذ ${bestMatch.host_name}. ثانية واحدة أبلغه بوجودك.` : 
                  //   `I found your meeting with Mr. ${bestMatch.host_name}. Please wait a moment while I confirm with him.`;
                  
                  // await speak(waitMsg);
    
                  // 3. Background Wait (Non-blocking)
                const approvalId = Math.random().toString(36).substring(7);
                const approvalLink = `${PUBLIC_URL}/approve?id=${approvalId}&action=approve`;
                const rejectLink = `${PUBLIC_URL}/approve?id=${approvalId}&action=reject`;
                
                console.log(`\n\n📢 [MOCK TEAMS NOTIFICATION] 📢\nTo: ${bestMatch.host_email}\nMessage: Visitor ${visitor_name} from ${visitor_company} is here.\n👉 APPROVE: ${approvalLink}\n👉 REJECT: ${rejectLink}\n\n`);
    
                let status = "pending";
                pendingApprovals.set(approvalId, { status, resolve: (s) => { status = s; } });
                waitingForApproval = true;
                
                // Save context for loop prevention
                lastCollectedInfo.visitor_name = visitor_name;
                lastCollectedInfo.host_name = host_name;
    
                // Start background checker
                const checkInterval = setInterval(async () => {
                   if (status !== "pending") {
                     clearInterval(checkInterval);
                     waitingForApproval = false; // Reset flag
                     // When status changes, inject notification into conversation stream
                     let notification = "";
                     
                     // Calculate time remaining
                     let timeMsg = "";
                     if (bestMatch.time) {
                       const meetingTime = new Date(); 
                       const [hrs, mins] = bestMatch.time.split(':');
                       meetingTime.setHours(parseInt(hrs), parseInt(mins), 0, 0);
                       
                       // Handle meeting time logic (if time passed, show for tomorrow or just say time)
                       // For simple mock, assume same day
                       const diffMs = meetingTime - new Date();
                       const diffMins = Math.round(diffMs / 60000);
                       
                       if (diffMins > 0) {
                         timeMsg = /[\u0600-\u06FF]/.test(reply) ? 
                           `ميعادك الساعة ${bestMatch.time}، يعني كمان ${diffMins} دقيقة.` : 
                           `Your meeting is at ${bestMatch.time}, which is in ${diffMins} minutes.`;
                       } else {
                         timeMsg = /[\u0600-\u06FF]/.test(reply) ? 
                           `ميعادك كان الساعة ${bestMatch.time}.` : 
                           `Your meeting was scheduled for ${bestMatch.time}.`;
                       }
                     }
    
                     if (status === "approved") {
                       notification = /[\u0600-\u06FF]/.test(reply) ? 
                         `أستاذ ${bestMatch.host_name} أكد الميعاد. تقدر تتفضل دلوقتي. ${timeMsg}` : 
                         `Mr. ${bestMatch.host_name} has confirmed. You may proceed. ${timeMsg}`;
                     } else {
                       notification = /[\u0600-\u06FF]/.test(reply) ? 
                         `للأسف أستاذ ${bestMatch.host_name} اعتذر عن المقابلة دلوقتي.` : 
                         `Unfortunately, Mr. ${bestMatch.host_name} is unavailable.`;
                     }
                     
                     // Send notification - will be queued automatically if AI is speaking
                     await speak(notification);
                   }
                }, 1000);
    
                // Return immediately to allow user to ask questions while waiting
            // Suggest topics from Company Info
            // We use the 'reply' or 'text' to detect language context
            const isAr = /[\u0600-\u06FF]/.test(reply) || /[\u0600-\u06FF]/.test(text);
            const suggestTopics = isAr 
                ? "منتجاتنا أو خدماتنا" 
                : (info.sectors ? info.sectors.slice(0, 2).join(", ") : "our products");
            
            reply = isAr ? 
              `بعتله رسالة وهيرد علينا حالاً. عقبال ما يرد، تحب تعرف أكتر عن ${suggestTopics}؟` : 
              `I've sent him a message. While we wait, would you like to know about ${suggestTopics}?`;
    
                // DO NOT BLOCK here anymore. Just return reply.
                // The interval above handles the async approval.
    
                } else if (partialMatch) {
                   // Ambiguous case: User said "Sherif", DB has "Sherif El-Eskandarany"
                   // Ask for confirmation
                   reply = /[\u0600-\u06FF]/.test(reply) ? 
                     `تقصد أستاذ ${partialMatch.host_name}؟` : 
                     `Do you mean Mr. ${partialMatch.host_name}?`;
                   
                   // Update context so next turn uses confirmed candidate
                   lastCollectedInfo.partialMatchCandidate = partialMatch; 
    
                } else {
                   reply = /[\u0600-\u06FF]/.test(reply) ? 
                     `للأسف مش لاقي حجز بالاسم ده. ممكن تتأكد من الاسم أو الشخص اللي هتقابله؟` : 
                     `I couldn't find a meeting with those details. Could you please check the name or host again?`;
                }
    
                // Prepend natural confirmation of details used for the search
                const isAr = /[\u0600-\u06FF]/.test(text) || /[\u0600-\u06FF]/.test(reply);
                const infoMsg = isAr 
                  ? `تمام، ببحث عن حجز للزائر ${visitor_name} من شركة ${visitor_company} مع ${host_name}.`
                  : `Okay, checking for a meeting for ${visitor_name} from ${visitor_company} with ${host_name}.`;
                
                // Only prepend if we found a match (or failed to find one), i.e. we are not just waiting
                if (bestMatch || !bestMatch) {
                   reply = infoMsg + " " + reply;
                }
              }
          }
        }
      } catch (e) { console.warn("Bad tool JSON", e); }
    }

    convo.push({ role: "assistant", content: reply });
    await speak(reply);
  }

  function preprocessTextForElevenLabs(text) {
    // 1. Brand Name Fixes
    let processed = text
      .replace(/Elsewedy/gi, "El Sewedy")
      .replace(/El Sewedy/gi, "El Sewedy");

    // 2. Email handling: Replace symbols with words to ensure clear reading in any language
    // const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    // processed = processed.replace(emailRegex, (match) => {
    //   return match.replace(/\./g, " dot ").replace(/@/g, " at ");
    // });

    // 3. Numerals: Convert digits to words based on language context
    // This ensures digit-by-digit reading (e.g. phone numbers) instead of whole numbers.
    // NOTE: Simplified to avoid false positives in English/French detection.
    // We assume standard TTS handles numbers well unless we explicitly intercept phone numbers later.
    const isArabic = /[\u0600-\u06FF]/.test(text);
    const isJapanese = /[\u3040-\u309F]|[\u30A0-\u30FF]/.test(text);
    const isChinese = /[\u4E00-\u9FFF]/.test(text);
    
    if (isArabic) {
      // For Arabic, do NOT split digits. Let TTS handle them as full numbers (e.g. "ألف وتسعمية...") 
      // unless it's explicitly a phone number which we handle in processTextForSpeech.
      // processed = processed.replace(/\d/g, (match) => " " + arDigits[match] + " ");
    } else if (isJapanese) {
      const jaDigits = {
        '0': 'ゼロ', '1': 'イチ', '2': 'ニ', '3': 'サン', '4': 'ヨン',
        '5': 'ゴ', '6': 'ロク', '7': 'ナナ', '8': 'ハチ', '9': 'キュウ'
      };
      processed = processed.replace(/\d/g, (match) => " " + jaDigits[match] + " ");
    } else if (isChinese) {
      // Chinese typically reads numbers fine as characters, but spacing can help with phone numbers
      // Often digits are read as jiau (9), yao (1) for phone numbers, but standard is fine.
      // We leave them as digits and rely on the TTS engine which is usually good with mixed text.
    } 
    // Removed aggressive European language heuristics (German/French/Italian) 
    // because they were triggering on common English words (e.g. "I", "a", "is").
    
    // Cleanup extra spaces
    processed = processed.replace(/\s+/g, " ").trim();

    return processed;

    // Cleanup extra spaces
    processed = processed.replace(/\s+/g, " ").trim();

    return processed;
  }

  // Simple audio queue
  let audioQueue = [];
  let isSpeaking = false;

  async function processAudioQueue() {
    if (isSpeaking || audioQueue.length === 0) return;
    isSpeaking = true;
    
    const nextFn = audioQueue.shift();
    try {
      await nextFn();
    } catch (e) {
      console.error("Audio playback error", e);
    } finally {
      isSpeaking = false;
      // Process next immediately
      if (audioQueue.length > 0) processAudioQueue();
    }
  }

  // Generic speak function that dispatches to the selected provider
  function speak(text) {
    // Return a promise that resolves when THIS utterance finishes
    return new Promise((resolve, reject) => {
        // Enqueue the TTS generation and sending
        audioQueue.push(async () => {
            try {
                if (TTS_PROVIDER === "azure") {
                    await speakAzure(text);
                } else {
                    await speakElevenLabs(text);
                }
                resolve();
            } catch (e) {
                reject(e);
            }
        });
        processAudioQueue();
    });
  }

  function processTextForSpeech(text, mainLang) {
    let processed = text;

    if (mainLang === "ar-EG") {
      // No complex regex for Arabic yet, but can add here
    } else {
      // English Normalization
      
      // 1. Dates (Years) - e.g. 1938 -> nineteen thirty-eight
      // Heuristic: 4 digits starting with 19 or 20, often preceded by "in" or "since" or just a date context
      // We need to avoid matching 4-digit numbers that are part of phone numbers if they weren't caught yet
      // But usually years are distinct.
      processed = processed.replace(/\b(19|20)(\d{2})\b/g, (match, p1, p2) => {
        // Simple map for first part
        const prefixes = { "19": "nineteen", "20": "twenty" };
        
        // For second part (00-99), we can rely on TTS reading "thirty-eight" for "38"
        // So "nineteen 38" works for most TTS engines to say "nineteen thirty eight"
        // BUT to be safe, we can convert small numbers too if we want, or just let it be.
        // Azure usually handles "nineteen 38" correctly.
        
        // However, we must be careful not to break logic.
        // Let's return words if we are sure.
        return `${prefixes[p1]} ${p2}`; 
      });

      // 2. Times - e.g. 14:00 -> 2 PM
      processed = processed.replace(/\b(\d{1,2}):(\d{2})\b/g, (match, h, m) => {
        let hour = parseInt(h);
        const min = parseInt(m);
        const suffix = hour >= 12 ? "PM" : "AM";
        if (hour > 12) hour -= 12;
        if (hour === 0) hour = 12;
        
        const minStr = min === 0 ? "" : (min < 10 ? ` oh ${min}` : ` ${min}`);
        return `${hour}${minStr} ${suffix}`;
      });
    }

    // 3. Phone Numbers - Force digit-by-digit
    // Regex for phone-like patterns. 
    // Relaxed to catch shorter numbers starting with 0 or + (common in spoken corrections)
    const phoneRegex = /(\+?\d[\d\-\s]{3,}\d)/g;
    processed = processed.replace(phoneRegex, (match) => {
        // Filter out things that look like simple large numbers (e.g. "1,000,000" or "1938")
        const clean = match.replace(/\D/g, '');
        
        // If it starts with 0 or +, treat as phone even if short (e.g. 010, 01554)
        if (match.trim().startsWith('0') || match.trim().startsWith('+')) {
             // Add commas between digits to slow down TTS reading
            // let spaced = match.split('').map(c => /\d/.test(c) ? `${c}, ` : c).join('');
             
             // For Arabic, convert English digits to Arabic words to ensure correct pronunciation
             if (mainLang === "ar-EG") {
                 const arDigits = {
                   '0': 'صفر', '1': 'واحد', '2': 'اتنين', '3': 'تلاتة', '4': 'أربعة',
                   '5': 'خمسة', '6': 'ستة', '7': 'سبعة', '8': 'تمانية', '9': 'تسعة'
                 };
                 spaced = spaced.replace(/\d/g, d => arDigits[d] || d);
             }
             return spaced;
        }

        // For other numbers, only treat as phone if very long (likely international without +)
        if (clean.length > 8 && !match.includes(',')) {
             // Heuristic: if it looks like a year (19xx or 20xx), skip
             if ((clean.startsWith("19") || clean.startsWith("20")) && clean.length === 4) return match;
             
             // Add commas between digits to slow down TTS reading
             let spaced = match.split('').map(c => /\d/.test(c) ? `${c}, ` : c).join('');
             // Same Arabic logic for long numbers
             if (mainLang === "ar-EG") {
                 const arDigits = {
                   '0': 'صفر', '1': 'واحد', '2': 'اتنين', '3': 'تلاتة', '4': 'أربعة',
                   '5': 'خمسة', '6': 'ستة', '7': 'سبعة', '8': 'تمانية', '9': 'تسعة'
                 };
                 spaced = spaced.replace(/\d/g, d => arDigits[d] || d);
             }
             return spaced;
        }
        
        return match;
    });

    return processed;
  }

  async function speakAzure(text) {
    try {
      if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) throw new Error("No Azure Speech Key/Region");

      const endpoint = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
      
      const isArabic = /[\u0600-\u06FF]/.test(text);
      // Determine correct ISO language code for SSML
      let langCode = "en-US";
      if (AZURE_TTS_VOICE.startsWith("ar-")) {
        langCode = "ar-EG";
      } else if (AZURE_TTS_VOICE.toLowerCase().includes("multilingual") && isArabic) {
        langCode = "ar-EG";
      }

      // Normalize Text (Dates, Times, Phones)
      const normalizedText = processTextForSpeech(text, langCode);

      const escapedText = normalizedText.replace(/&/g, '&amp;')
                              .replace(/</g, '&lt;')
                              .replace(/>/g, '&gt;')
                              .replace(/"/g, '&quot;')
                              .replace(/'/g, '&apos;');

      // Simple SSML build
      const ssml = `
        <speak version="1.0" xml:lang="${langCode}">
          <voice xml:lang="${langCode}" name="${AZURE_TTS_VOICE}">
            <prosody rate="${AZURE_TTS_RATE}" pitch="${AZURE_TTS_PITCH}">
              ${escapedText}
            </prosody>
          </voice>
        </speak>
      `.trim();
      // ... rest of the logic ...

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm",
          "User-Agent": "ai-receptionist-egypt"
        },
        body: ssml
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Azure TTS ${response.status}: ${err}`);
      }

      // Stream audio chunks to client
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        ws.send(value); // Send raw PCM chunk
      }
      ws.send(JSON.stringify({ type: 'tts_end' }));

    } catch (e) {
      console.error("Azure TTS error", e);
    }
  }

    async function speakElevenLabs(text) {
    try {
      if (!ELEVENLABS_API_KEY) throw new Error("No ElevenLabs Key");
      
      const isArabic = /[\u0600-\u06FF]/.test(text);
      const langCode = isArabic ? "ar-EG" : (/[\u4E00-\u9FFF]/.test(text) ? "zh-CN" : "en-US");

      // Apply text preprocessing (Emails, Brand Name, etc.)
      // We merge the new Normalizer with the specific ElevenLabs brand fixes
      let ttsText = preprocessTextForElevenLabs(text);
      
      // Apply Date/Time/Phone normalizer with correct language context
      ttsText = processTextForSpeech(ttsText, langCode);
        
      const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
      const stability = parseFloat(process.env.ELEVENLABS_STABILITY || "0.5");
      const similarity = parseFloat(process.env.ELEVENLABS_SIMILARITY_BOOST || "0.75");
      // Latency optimization: 0=Default/HighQuality, 1=Normal, 2=Fast, 3=Fastest(lowest latency)
      // Reduced default to 1 to improve stability and potentially slow down pacing slightly vs 3.
      const latency = process.env.ELEVENLABS_LATENCY || "1"; 

      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=${latency}&output_format=pcm_24000`, {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: ttsText,
          model_id: modelId,
          voice_settings: { stability: stability, similarity_boost: similarity }
        })
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`ElevenLabs ${response.status}: ${err}`);
      }

      // Stream audio chunks to client
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        ws.send(value); // Send raw MP3 chunk
      }
      ws.send(JSON.stringify({ type: 'tts_end' }));
    } catch (e) {
      console.error("ElevenLabs TTS error", e);
    }
  }

  // Initial greeting
  if (GREETING_ON_START) speak(GREETING_TEXT);
}

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

server.listen(PORT, () => console.log(`AI receptionist server listening on ${PORT}. Public URL: ${PUBLIC_URL}`));

