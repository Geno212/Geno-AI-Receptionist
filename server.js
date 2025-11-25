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
const twilio = require("twilio");
const sdk = require("microsoft-cognitiveservices-speech-sdk");

// ========== ENV ==========
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

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
const TWILIO_MEDIA_WS_PATH = "/ws";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || "";
const twilioRest = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

const GREETING_ON_START = (process.env.GREETING_ON_START ?? "1") === "1";
const GREETING_TEXT = process.env.GREETING_TEXT || "أهلاً بك في السويدي إليكتريك. أنا جينو. Welcome to El Sewedy Electric. I am Geno. How can I help you?";

// ========== LIGHT DB (JSON file) ==========
const dbPath = path.join(__dirname, "db.json");
function seedDB() {
  return {
    customers: [ { id: 1, phone_e164: "+201001234567", name: "أحمد علي", notes: "", created_at: Date.now() } ],
    reservations: [],
    menu_items: [
      { id: 1, name_ar: "كشري", name_en: "Koshary", description_ar: "أرز ومكرونة وعدس وبصل مقرمش", price_egp: 95, is_available: true, category: "mains" },
      { id: 2, name_ar: "ملوخية", name_en: "Molokhia", description_ar: "شوربة ملوخية مع ثوم وكزبرة", price_egp: 85, is_available: true, category: "mains" },
      { id: 3, name_ar: "حمص", name_en: "Hummus", description_ar: "حمص مهروس مع طحينة", price_egp: 70, is_available: true, category: "mezzes" },
      { id: 4, name_ar: "أم علي", name_en: "Om Ali", description_ar: "حلوى باللبن والمكسرات", price_egp: 75, is_available: true, category: "desserts" },
    ],
    opening_hours: [
      { id: 1, weekday: 1, open_time: "12:00", close_time: "23:00" },
      { id: 2, weekday: 2, open_time: "12:00", close_time: "23:00" },
      { id: 3, weekday: 3, open_time: "12:00", close_time: "23:00" },
      { id: 4, weekday: 4, open_time: "12:00", close_time: "23:00" },
      { id: 5, weekday: 5, open_time: "12:00", close_time: "00:00" },
      { id: 6, weekday: 6, open_time: "12:00", close_time: "00:00" },
      { id: 7, weekday: 7, open_time: "12:00", close_time: "23:00" },
    ],
    special_days: [],
    counters: { customers: 1, reservations: 0 },
  };
}
function loadDB() { if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify(seedDB(), null, 2)); return JSON.parse(fs.readFileSync(dbPath, "utf8")); }
function saveDB(db) { fs.writeFileSync(dbPath, JSON.stringify(db, null, 2)); }

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

// Azure Speech SDK is used for both STT and TTS

// ========== Express + Twilio Webhook (TwiML) ==========
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const SYSTEM_PROMPT = `أنت موظف استقبال لشركة السويدي إليكتريك.
تكلّم بلهجة مصرية مهذبة واحترافية.
جاوب على الأسئلة عن المنتجات والخدمات (كابلات، محولات، عدادات، مشاريع).
لا تكرر الترحيب في كل رد.
`;

app.post("/voice", (req, res) => {
  const wsUrl = (PUBLIC_URL.replace(/^http/, "ws") + TWILIO_MEDIA_WS_PATH);
  console.log(`[TwiML] /voice requested from ${req.ip}. Opening stream → ${wsUrl}`);
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  // Use inbound_track to receive caller audio only (avoids 31941 on accounts without bidirectional)
  connect.stream({ url: wsUrl, track: "inbound_track", name: "ai-eg-reception" });
  res.type("text/xml").send(twiml.toString());
});

app.post("/client-voice", (req, res) => {
  const wsUrl = (PUBLIC_URL.replace(/^http/, "ws") + TWILIO_MEDIA_WS_PATH);
  console.log(`[TwiML] /client-voice requested from ${req.ip}. Opening stream → ${wsUrl}`);
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({ url: wsUrl, track: "inbound_track", name: "ai-eg-reception" });
  res.type("text/xml").send(twiml.toString());
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
    tts_voice: AZURE_TTS_VOICE,
    tts_style: AZURE_TTS_STYLE || null,
    tts_rate: AZURE_TTS_RATE || null,
    tts_pitch: AZURE_TTS_PITCH || null,
    stt_region: AZURE_SPEECH_REGION || null,
    stt_enabled: Boolean(AZURE_SPEECH_KEY && AZURE_SPEECH_REGION)
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
app.get("/voices", async (req, res) => {
  try {
    const endpoint = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
    const resp = await fetch(endpoint, {
      headers: {
        "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
        "User-Agent": "ai-receptionist-egypt"
      }
    });
    if (!resp.ok) {
      let detail = ""; try { detail = await resp.text(); } catch {}
      return res.status(500).json({ ok: false, error: `Azure voices ${resp.status} ${detail}` });
    }
    const voices = await resp.json();
    const ar = voices.filter(v => (v.Locale || v.LocaleName || "").toString().toLowerCase().includes("ar-eg"));
    res.json({ ok: true, count: voices.length, ar_eg: ar });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// XML escape helper (top-level for routes that build SSML)
function escapeXml(s) {
  return String(s).replace(/[<>&'\"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  })[c]);
}

// Top-level Azure TTS (robust): tries style on/off and multiple μ-law formats with voice + fallback
async function synthesizeWithAzureStandalone(text) {
  const endpoint = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;

  function buildSsml(voiceName, includeStyle) {
    const prosodyAttrs = [
      AZURE_TTS_RATE ? `rate=\"${AZURE_TTS_RATE}\"` : "",
      AZURE_TTS_PITCH ? `pitch=\"${AZURE_TTS_PITCH}\"` : "",
    ].filter(Boolean).join(" ");
    const styleOpen = (includeStyle && AZURE_TTS_STYLE) ? `<mstts:express-as style=\"${AZURE_TTS_STYLE}\">` : "";
    const styleClose = (includeStyle && AZURE_TTS_STYLE) ? `</mstts:express-as>` : "";
    return `
      <speak version=\"1.0\" xml:lang=\"ar-EG\" xmlns:mstts=\"https://www.w3.org/2001/mstts\">\n        <voice xml:lang=\"ar-EG\" name=\"${voiceName}\">\n          <prosody ${prosodyAttrs}>\n            ${styleOpen}${escapeXml(text)}${styleClose}\n          </prosody>\n        </voice>\n      </speak>
    `.trim();
  }

  async function postTts(ssml, format) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
        "X-Microsoft-OutputFormat": format,
        "Content-Type": "application/ssml+xml",
        "User-Agent": "ai-receptionist-egypt"
      },
      body: ssml
    });
    if (!res.ok) {
      let detail = ""; try { detail = await res.text(); } catch {}
      throw new Error(`Azure TTS ${res.status} ${detail}`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }

  const voices = Array.from(new Set([AZURE_TTS_VOICE, AZURE_TTS_FALLBACK_VOICE].filter(Boolean)));
  const formats = ["raw-8khz-8bit-mono-mulaw", "audio-8khz-8bit-mono-mulaw", "riff-8khz-8bit-mono-mulaw"];
  for (const v of voices) {
    for (const includeStyle of [Boolean(AZURE_TTS_STYLE), false]) {
      const ssml = buildSsml(v, includeStyle);
      for (const fmt of formats) {
        try { return await postTts(ssml, fmt); } catch { /* try next */ }
      }
    }
  }
  throw new Error("Azure TTS failed for all combinations");
}

// Quick TTS check (validates Azure TTS creds/voice; returns size only)
app.get("/tts-test", async (req, res) => {
  const text = (req.query.text || "اختبار الصوت").toString();
  try {
    const buf = await synthesizeWithAzureStandalone(text);
    res.json({ ok: true, bytes: buf.length, voice: AZURE_TTS_VOICE, region: AZURE_SPEECH_REGION });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

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
app.get("/stt-test", async (req, res) => {
  const text = (req.query.text || "اختبار الصوت الآن").toString();
  try {
    const ttsBuf = await synthesizeWithAzureStandalone(text);
    const mulawBuf = extractMulawPayload(ttsBuf);
    const u8 = new Uint8Array(mulawBuf.buffer, mulawBuf.byteOffset, mulawBuf.byteLength);
    const linear16 = mulawToLinear16(u8);
    const pcm = Buffer.from(linear16.buffer);

    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
    speechConfig.speechRecognitionLanguage = "ar-EG";
    speechConfig.setProperty(sdk.PropertyId.SpeechServiceResponse_PostProcessingOption, "TrueText");

    const pushStream = sdk.AudioInputStream.createPushStream(
      sdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1)
    );
    pushStream.write(pcm);
    pushStream.close();
    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    const result = await new Promise((resolve, reject) => {
      recognizer.recognizeOnceAsync(
        r => { try { recognizer.close(); } catch {} resolve(r); },
        err => { try { recognizer.close(); } catch {} reject(err); }
      );
    });
    res.json({ ok: true, provided_text: text, recognized_text: result?.text || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/token", (req, res) => {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET || !TWILIO_TWIML_APP_SID) {
    return res.status(500).json({ error: "Twilio client env vars missing" });
  }
  const identity = (req.query.identity || TWILIO_CLIENT_IDENTITY).toString();
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;
  const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { identity, ttl: 3600 });
  const voiceGrant = new VoiceGrant({ outgoingApplicationSid: TWILIO_TWIML_APP_SID, incomingAllow: true });
  token.addGrant(voiceGrant);
  res.json({ identity, token: token.toJwt() });
});

// Trigger an outbound call so Twilio calls your phone and connects to the AI stream
// Body: { "to": "+2010..." }
app.post("/call", async (req, res) => {
  try {
    const to = (req.body?.to || "").toString();
    if (!to) return res.status(400).json({ error: "Missing 'to' E.164 number" });
    if (!twilioRest || !TWILIO_NUMBER) return res.status(500).json({ error: "Twilio outbound env vars missing" });
    const call = await twilioRest.calls.create({
      to,
      from: TWILIO_NUMBER,
      // When the call is answered, Twilio fetches TwiML from here, which opens the media stream
      url: `${PUBLIC_URL.replace(/\/$/, "")}/voice`
    });
    res.json({ sid: call.sid, to });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const server = http.createServer(app);

// ========== WebSocket (bidirectional) ==========
// Handle both Twilio (/ws) and Browser (/client-ws)
const wss = new WebSocket.Server({ server });

// μ-law decode table
const MULAW_DECODE_TABLE = (() => {
  const BIAS = 0x84;
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let mu = ~i & 0xff;
    let t = ((mu & 0x0F) << 3) + BIAS;
    t <<= ((mu & 0x70) >> 4);
    let s = (mu & 0x80) ? (BIAS - t) : (t - BIAS);
    table[i] = s;
  }
  return table;
})();

function mulawToLinear16(u8arr) {
  const out = new Int16Array(u8arr.length);
  for (let i = 0; i < u8arr.length; i++) out[i] = MULAW_DECODE_TABLE[u8arr[i]];
  return out;
}

wss.on("connection", (ws, req) => {
  const url = req.url;
  console.log(`WS connected on ${url}`);

  if (url === "/client-ws") {
    handleBrowserConnection(ws);
  } else if (url === TWILIO_MEDIA_WS_PATH) {
    handleTwilioConnection(ws);
  } else {
    ws.close();
  }
});

function handleBrowserConnection(ws) {
  const db = loadDB();
  
  const info = db.company_info || {};
  const dynamicPrompt = `You are Geno, the AI Receptionist for ${info.name || "El Sewedy Electric"}.
  
  Company Info:
  - Description: ${info.description || ""}
  - HQ: ${info.headquarters || ""}
  - Hours: ${JSON.stringify(info.working_hours || {})}
  - Products/Services: ${JSON.stringify(info.key_services_products || [])}
  - News: ${JSON.stringify(info.recent_news || [])}
  - Contact: ${JSON.stringify(info.contact || {})}

  Instructions:
  1. **Identity**: Your name is Geno. You are helpful, polite, and professional.
  2. **Language Detection**: Listen to the user. 
     - If English -> Reply in English.
     - If Arabic -> Reply in Egyptian Arabic.
     - If Japanese -> Reply in Japanese.
     - If other -> Reply in that language.
     - **CRITICAL**: When asking for missing information (Name, Phone, Email), you MUST ask in the SAME language the user is speaking. Do NOT switch to English.
  3. **No Repetition**: 
     - Do NOT repeat greetings (Hello, Welcome, "I am Geno") in every turn. Only greet once at the start.
     - **Do NOT** repeat the user's name in every sentence. Use it once or not at all after the first time.
  4. **Brevity**: Keep your responses extremely short and concise (max 1-2 sentences). Do not lecture.
  5. **Content**: Answer questions based on the Company Info.
  6. **Lead Generation**: 
     - If the user expresses interest in products/services, you **MUST** collect their **Name**, **Phone Number**, and **Email**.
     - **Do NOT** end the conversation or say goodbye until you have all three pieces of information.
     - If the user provides only some info, ask for the rest in the user's language.
     - Once you have all info, output the tool JSON **IMMEDIATELY** at the start of your response.
  
  **STRICT OUTPUT FORMAT**:
  - Do NOT output the tool JSON unless you have ALL 3 fields (Name, Phone, Email).
  - **NEVER** speak the words "Tool Format", "JSON", "name", "phone", or "email" in English when the user is speaking Arabic.
  - **NEVER** output text like "(Tool Format: ...)" or "Here is the JSON".
  - **NEVER** use parentheses "(...)" to give instructions or ask for info in English if the conversation is in Arabic.
  - Just output the <tool>...</tool> block if ready, followed by your natural language response.
  - **DATA FORMAT**: When saving the lead, **ALWAYS** transliterate Arabic names to English (e.g., "Ahmed" instead of "أحمد") and ensure the email is in valid format.
  - **ONE-TIME SAVE**: Only output the <tool> block ONCE when you first collect the full info. Do NOT output it again in subsequent turns unless the user explicitly changes their information.

  **EXAMPLES OF ASKING FOR INFO**:
  - English: "Could I please have your name, phone number, and email to assist you further?"
  - Arabic: "ممكن الاسم ورقم التليفون والإيميل عشان أقدر أساعدك؟"
  - Japanese: "お客様のお名前、電話番号、メールアドレスを教えていただけますか？"

  Tool Schema:
  <tool>{"name":"save_lead","args":{"name":"Ahmed","phone":"+123456789","email":"ahmed@example.com","interest":"Cables"}}</tool>
  `;

  const convo = [ { role: "system", content: dynamicPrompt } ];

  // Handle text messages from browser (STT done in browser)
  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "text" && data.text) {
        console.log("Browser STT:", data.text);
        await handleTurn(data.text);
      }
    } catch (e) {}
  });

  // State to track the last saved lead to prevent duplicates
  let lastSavedLead = null;

  async function handleTurn(text) {
    convo.push({ role: "user", content: text });
    const llm = await callLLM(convo);
    console.log("LLM Raw Output:", llm); // Debug log
    let reply = llm || "تمام، تحت أمرك";

    // Tool logic
    const m = reply.match(/<tool>([\s\S]*?)<\/tool>/);
    if (m) {
      // Always remove the tool tag from the spoken reply, even if parsing fails
      reply = reply.replace(m[0], "").trim();
      
      try {
        const action = JSON.parse(m[1]);
        if (action?.name === "save_lead") {
          const { name, phone, email, interest } = action.args || {};
          
          // Create a signature of the current lead data
          const currentLeadSig = JSON.stringify({ name, phone, email, interest });
          
          // Only save if the data is different from the last save
          if (currentLeadSig !== lastSavedLead && (name || phone || email)) {
             db.counters.customers = (db.counters.customers || 0) + 1;
             const lead = { 
               id: db.counters.customers, 
               name: name || "Client", 
               phone: phone || "", 
               email: email || "",
               interest: interest || "", 
               created_at: Date.now() 
             };
             if (!db.customers) db.customers = [];
             db.customers.push(lead);
             saveDB(db);
             console.log("✅ Lead saved to DB:", lead);
             
             // Update the last saved state
             lastSavedLead = currentLeadSig;
          } else {
             console.log("ℹ️ Duplicate lead data detected, skipping DB save.");
          }
        }
      } catch (e) { console.warn("Bad tool JSON", e); }
    }

    convo.push({ role: "assistant", content: reply });
    await speakElevenLabs(reply);
  }

  async function speakElevenLabs(text) {
    try {
      if (!ELEVENLABS_API_KEY) throw new Error("No ElevenLabs Key");
      
      // Pronunciation fixes
      let ttsText = text
        .replace(/Elsewedy/gi, "El Sewedy") // Ensure space
        .replace(/El Sewedy/gi, "El Sewedy"); // Standardize (no-op but safe)
        
      const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
      const stability = parseFloat(process.env.ELEVENLABS_STABILITY || "0.5");
      const similarity = parseFloat(process.env.ELEVENLABS_SIMILARITY_BOOST || "0.75");

      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=pcm_44100`, {
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
  if (GREETING_ON_START) speakElevenLabs(GREETING_TEXT);
}

function handleTwilioConnection(ws) {
  console.log("Twilio connected");
  const db = loadDB();
  const convo = [ { role: "system", content: SYSTEM_PROMPT } ];
  const caller = { phone: null };
  let streamSid = null; // Twilio stream identifier needed for outbound audio

  let azurePushStream = null; // Azure STT push stream
  let azureRecognizer = null; // Azure STT recognizer
  const useAzureSTT = true;

  async function startSpeechStream() {
    if (useAzureSTT) {
      if (azureRecognizer) return;
      try {
        const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
        speechConfig.speechRecognitionLanguage = "ar-EG";
        speechConfig.setProperty(sdk.PropertyId.SpeechServiceResponse_PostProcessingOption, "TrueText");

        azurePushStream = sdk.AudioInputStream.createPushStream(
          sdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1)
        );
        const audioConfig = sdk.AudioConfig.fromStreamInput(azurePushStream);
        // Use the configured speechConfig so properties (e.g., TrueText) apply
        azureRecognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
        azureRecognizer.speechRecognitionLanguage = "ar-EG";

        azureRecognizer.recognizing = async (_s, e) => {
          const text = e?.result?.text?.trim();
          if (!text) return;
          if (process.env.LOG_TRANSCRIPTS) console.log("STT PART", text);
        };

        azureRecognizer.recognized = async (_s, e) => {
          const text = e?.result?.text?.trim();
          if (!text) return;
          if (process.env.LOG_TRANSCRIPTS) console.log("STT FINAL", text);
          await handleFinalTranscript(text);
        };

        azureRecognizer.canceled = (_s, e) => {
          console.error("Azure STT canceled", e?.errorDetails || e?.reason || "");
        };
        azureRecognizer.sessionStopped = () => {
          if (process.env.LOG_TRANSCRIPTS) console.log("Azure STT session stopped");
        };

        azureRecognizer.startContinuousRecognitionAsync();
      } catch (err) {
        console.error("Azure STT init error", err?.message || err);
      }
    }
  }

  async function handleFinalTranscript(text) {
    convo.push({ role: "user", content: text });
    const llm = await callLLM(convo);
    let reply = llm || "تمام، تحت أمرك";

    // Parse optional <tool>{...}</tool>
    const m = reply.match(/<tool>([\s\S]*?)<\/tool>/);
    if (m) {
      try {
        const action = JSON.parse(m[1]);
        if (action?.name === "place_reservation") {
          const { name, phone, party_size, iso_datetime } = action.args || {};
          const when = Date.parse(iso_datetime);
          const r = placeReservation(db, { phone_e164: phone || caller.phone || "+201000000000", name: name || "ضيف", party_size: Number(party_size)||2, reserved_at: when || (Date.now()+3600000) });
          reply = reply.replace(m[0], "");
          reply = `اتأكد الحجز. ${reply.trim()}`;
          if (process.env.LOG_TRANSCRIPTS) console.log("Reservation stored", r);
        }
      } catch (e) { console.warn("Bad tool JSON"); }
    }

    convo.push({ role: "assistant", content: reply });
    await speak(reply);
  }

  async function speak(text) {
    try {
      if (!streamSid) {
        console.warn("No streamSid yet; cannot send audio to Twilio.");
        return;
      }
      const buf = await synthesizeWithAzureRobust(text);

      // Optional: clear any pending audio on Twilio side
      try { ws.send(JSON.stringify({ event: "clear", streamSid })); } catch {}

      // Send μ-law 8k audio back in small frames; chunk on binary boundaries then base64-encode per frame
      const frameSizeBytes = 160; // 20ms at 8kHz μ-law
      for (let i = 0; i < buf.length; i += frameSizeBytes) {
        const frame = buf.subarray(i, i + frameSizeBytes);
        const b64 = frame.toString("base64");
        ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
      }
      ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts_done" } }));
    } catch (e) {
      console.error("TTS error", e.message);
    }
  }

  // Robust TTS: tries with/without style and multiple mulaw formats
  async function synthesizeWithAzureRobust(text) {
    const endpoint = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;

    function buildSsml(voiceName, includeStyle) {
      const prosodyAttrs = [
        AZURE_TTS_RATE ? `rate=\"${AZURE_TTS_RATE}\"` : "",
        AZURE_TTS_PITCH ? `pitch=\"${AZURE_TTS_PITCH}\"` : "",
      ].filter(Boolean).join(" ");
      const styleOpen = (includeStyle && AZURE_TTS_STYLE) ? `<mstts:express-as style=\"${AZURE_TTS_STYLE}\">` : "";
      const styleClose = (includeStyle && AZURE_TTS_STYLE) ? `</mstts:express-as>` : "";
      return `
        <speak version=\"1.0\" xml:lang=\"ar-EG\" xmlns:mstts=\"https://www.w3.org/2001/mstts\">\n          <voice xml:lang=\"ar-EG\" name=\"${AZURE_TTS_VOICE}\">\n            <prosody ${prosodyAttrs}>\n              ${styleOpen}${escapeXml(text)}${styleClose}\n            </prosody>\n          </voice>\n        </speak>
      `.trim();
    }

    const formats = ["raw-8khz-8bit-mono-mulaw", "audio-8khz-8bit-mono-mulaw", "riff-8khz-8bit-mono-mulaw"];
    const styleFlags = [Boolean(AZURE_TTS_STYLE), false];
    let lastErr = null;
    for (const includeStyle of styleFlags) {
      const ssml = buildSsml(AZURE_TTS_VOICE, includeStyle);
      for (const fmt of formats) {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
              "X-Microsoft-OutputFormat": fmt,
              "Content-Type": "application/ssml+xml",
              "User-Agent": "ai-receptionist-egypt"
            },
            body: ssml
          });
          if (!res.ok) throw new Error(`Azure TTS ${res.status}`);
          const ab = await res.arrayBuffer();
          return Buffer.from(ab);
        } catch (e) {
          lastErr = e;
        }
      }
    }
    // Try fallback voice without/with style if defined
    if (AZURE_TTS_FALLBACK_VOICE && AZURE_TTS_FALLBACK_VOICE !== AZURE_TTS_VOICE) {
      for (const includeStyle of styleFlags) {
        const ssml = buildSsml(AZURE_TTS_FALLBACK_VOICE, includeStyle);
        for (const fmt of formats) {
          try {
            const res = await fetch(endpoint, {
              method: "POST",
              headers: {
                "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
                "X-Microsoft-OutputFormat": fmt,
                "Content-Type": "application/ssml+xml",
                "User-Agent": "ai-receptionist-egypt"
              },
              body: ssml
            });
            if (!res.ok) throw new Error(`Azure TTS ${res.status}`);
            const ab = await res.arrayBuffer();
            return Buffer.from(ab);
          } catch (e) {
            lastErr = e;
          }
        }
      }
    }
    throw lastErr || new Error("Azure TTS failed");
  }

  function escapeXml(s) {
    return String(s).replace(/[<>&'\"]/g, (c) => ({
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "'": "&apos;",
      '"': "&quot;",
    })[c]);
  }

  ws.on("message", async (msg) => {
    let data; try { data = JSON.parse(msg.toString()); } catch { return; }
    const event = data.event;

    if (event === "start") {
      streamSid = data.start?.streamSid || null;
      console.log("Stream start", streamSid);
      caller.phone = data.start?.customParameters?.caller || null;
      startSpeechStream();
      if (GREETING_ON_START) {
        // Short Azure TTS greeting using configured voice
        speak(GREETING_TEXT).catch(()=>{});
      }
    } else if (event === "media") {
      const b64 = data.media?.payload;
      if (!b64) return;
      const mulaw = Buffer.from(b64, "base64");
      const linear16 = mulawToLinear16(mulaw);
      const pcm = Buffer.from(linear16.buffer);
      if (useAzureSTT && azurePushStream) {
        try { azurePushStream.write(pcm); } catch {}
      }
    } else if (event === "stop") {
      console.log("Stream stop");
      if (useAzureSTT) {
        try { if (azurePushStream) azurePushStream.close(); } catch {}
        azurePushStream = null;
        try { if (azureRecognizer) azureRecognizer.stopContinuousRecognitionAsync(); } catch {}
        try { if (azureRecognizer) azureRecognizer.close(); } catch {}
        azureRecognizer = null;
      }
      ws.close();
    } else if (event === "connected") {
      // Twilio occasionally sends events; ignore
    }
  });

  ws.on("close", () => {
    if (useAzureSTT) {
      try { if (azurePushStream) azurePushStream.close(); } catch {}
      azurePushStream = null;
      try { if (azureRecognizer) azureRecognizer.stopContinuousRecognitionAsync(); } catch {}
      try { if (azureRecognizer) azureRecognizer.close(); } catch {}
      azureRecognizer = null;
    }
  });
}

server.listen(PORT, () => console.log(`AI receptionist server listening on ${PORT}. Public URL: ${PUBLIC_URL}`));
