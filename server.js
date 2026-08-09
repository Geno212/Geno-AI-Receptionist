// Geno - El Sewedy Electric AI Receptionist
//
// Browser -> WebSocket -> LLM -> TTS pipeline for Egyptian Arabic + English.
// Provider backends (LLM/STT/TTS) are selected via .env, see lib/providers.js.
// Full request flow: docs/ARCHITECTURE.md
//
// Legacy Twilio / Azure Speech / Google Cloud code lives in legacy/ and is not
// loaded by this file.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const WebSocket = require("ws");
// Provider layer: LLM/STT backends are selected via .env, not code.
const { callLLMWithFallback, transcribe, providerStatus } = require("./lib/providers");
// Single source of truth for the system prompt, shared with bench/.
const { buildSystemPrompt } = require("./lib/system-prompt");
const languages = require("./lib/languages");

// ========== ENV ==========
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// TTS: "elevenlabs" (paid, hosted) or "local" (self-hosted MIT model on a GPU).
// LLM/STT provider config lives in lib/providers.js.
const TTS_PROVIDER = process.env.TTS_PROVIDER || "elevenlabs";

// ElevenLabs
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

// Self-hosted TTS (NAMAA-Egyptian-TTS / Chatterbox) - see tts-server/
const TTS_LOCAL_URL = process.env.TTS_LOCAL_URL || "http://localhost:8020";


const LOG_TRANSCRIPTS = (process.env.LOG_TRANSCRIPTS ?? "1") === "1";
const GREETING_ON_START = (process.env.GREETING_ON_START ?? "1") === "1";
// Scope is Egyptian Arabic + English only; the greeting is bilingual so the
// visitor's first reply establishes which language the conversation continues in.
const GREETING_TEXT = process.env.GREETING_TEXT || "أهلاً بك في السويدي إليكتريك. أنا جينو. Welcome to El Sewedy Electric, I am Geno.";

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
function isSimilar(str1, str2, threshold = 0.6, label = null) {
  if (!str1 || !str2) return false;
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  
  // 1. Exact or Substring match (Fast Path)
  if (s1.includes(s2) || s2.includes(s1)) {
    if (label) {
      console.log(`[Fuzzy:${label}] '${s1}' vs '${s2}' -> Substring/Exact Match`);
    }
    return true;
  }

  // 2. Hybrid Similarity Score
  const levDistance = calculateLevenshtein(s1, s2);
  const maxLength = Math.max(s1.length, s2.length);
  const levSimilarity = 1 - (levDistance / maxLength);
  
  const cosineSimilarity = calculateCosineSimilarity(s1, s2);
  
  // Use the Maximum of the two metrics
  const hybridScore = Math.max(levSimilarity, cosineSimilarity);
  
  // Debug if close to threshold or failed but had some similarity
  // Log all hybrid attempts that have some potential (>0.3) to see why they fail
  if (label || hybridScore > 0.3) {
     console.log(`[Fuzzy${label ? ':' + label : ''}] '${s1}' vs '${s2}' -> Lev:${levSimilarity.toFixed(2)}, Cos:${cosineSimilarity.toFixed(2)}, Final:${hybridScore.toFixed(2)}`);
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
       if (partScore >= 0.68) {
         if (label) {
            console.log(`[Fuzzy:${label}] Part Match '${p1}' vs '${p2}' -> Score:${partScore.toFixed(2)}`);
         }
         return true;
       }
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
// Delegates to lib/providers.js so the backend is an .env choice
// (LLM_PROVIDER=groq|cerebras|gemini|openrouter|cloudflare) rather than code.
//
// LLM_FALLBACKS lets a throttled free tier hand off to another provider instead
// of leaving the visitor in silence -- free tiers rate-limit without warning.
async function callLLM(messages) {
  const { text, provider, error } = await callLLMWithFallback(messages, {
    temperature: 0.35,
    maxTokens: 256,
  });
  if (!text && error) console.error("LLM error", error.message);
  else if (provider && provider !== (process.env.LLM_PROVIDER || "groq").toLowerCase()) {
    console.warn(`[llm] served by fallback provider "${provider}"`);
  }
  return text;
}

// ========== Express + Twilio Webhook (TwiML) ==========
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const CLIENT_DIR = path.join(__dirname, "src", "client");
app.use(express.static(CLIENT_DIR));
app.get("/", (_req, res) => {
  res.sendFile(path.join(CLIENT_DIR, "index.html"));
});

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

// ========== Server-side STT (Groq Whisper) ==========
// The browser's Web Speech API is Chrome-only and weak on Egyptian dialect.
// This endpoint accepts a recorded audio blob and transcribes it via Groq's
// free Whisper tier, which makes the receptionist work in any browser.
//
// The client posts raw audio bytes with the source mime type in Content-Type.
// Kept as plain HTTP (not the WebSocket) because Whisper is utterance-based:
// the client records until its VAD detects end-of-speech, then posts once.
app.post(
  "/stt",
  express.raw({ type: () => true, limit: "25mb" }),
  async (req, res) => {
    const started = Date.now();
    try {
      if (!req.body || !req.body.length) {
        return res.status(400).json({ ok: false, error: "empty audio body" });
      }
      // Whisper picks the decoder from the file extension, so map the browser's
      // MediaRecorder mime type to a matching filename.
      const mime = (req.get("content-type") || "").toLowerCase();
      const ext = mime.includes("ogg") ? "ogg"
        : mime.includes("mp4") || mime.includes("m4a") ? "m4a"
        : mime.includes("mpeg") || mime.includes("mp3") ? "mp3"
        : mime.includes("wav") ? "wav"
        : "webm";

      // Auto-detect by default. When a non-core language appears, enable it for
      // both STT routing and TTS (server-side — no client language picker).
      const langParam = req.query.lang;
      const language = !langParam || langParam === "" || langParam === "auto"
        ? null
        : langParam;

      const { text, model, language: detectedLang } = await transcribe(req.body, { filename: `speech.${ext}`, language });
      const latencyMs = Date.now() - started;

      let langInfo = null;
      if (detectedLang) {
        langInfo = languages.enableLanguage(detectedLang);
        if (langInfo.ok && langInfo.newlyEnabled && TTS_PROVIDER === "local") {
          const ensured = await languages.ensureTtsLanguage(langInfo.language, TTS_LOCAL_URL);
          if (LOG_TRANSCRIPTS) {
            console.log(`[lang] enabled ${langInfo.language} for TTS/STT`, ensured.ok ? "ok" : ensured.error);
          }
        }
      }

      if (LOG_TRANSCRIPTS) {
        console.log(`[stt] ${latencyMs}ms (${req.body.length}B ${ext}${detectedLang ? `, lang=${detectedLang}` : ""}): ${text}`);
      }
      res.json({
        ok: true,
        text,
        model,
        language: langInfo?.language || languages.normalizeLang(detectedLang) || null,
        newly_enabled: Boolean(langInfo?.newlyEnabled),
        enabled_languages: languages.listEnabled(),
        latencyMs,
      });
    } catch (e) {
      const status = e?.status === 429 ? 429 : 500;
      const bytes = req.body?.length || 0;
      const head = req.body && bytes
        ? Buffer.from(req.body).subarray(0, 4).toString("hex")
        : "none";
      console.error(`[stt] error (${bytes}B, magic=${head})`, e.message);
      res.status(status).json({ ok: false, error: e.message, quota: Boolean(e?.isQuota) });
    }
  }
);

// Minimal diagnostics (no secrets)
app.get("/config", (req, res) => {
  // Reports which backend each layer resolves to, so a misconfigured .env is
  // visible without reading logs. Never includes key material.
  res.json({
    port: PORT,
    public_url: PUBLIC_URL,
    providers: providerStatus(),
    prompt: { kb_mode: process.env.KB_MODE || "lean", chars: buildSystemPrompt().length },
    languages: {
      core: languages.listCore(),
      enabled: languages.listEnabled(),
      supported_tts: languages.listSupported(),
      last_detected: languages.getLastDetected(),
    },
  });
});

/** Language registry — any HTTP/WS client can inspect/enable languages. */
app.get("/languages", (req, res) => {
  res.json({
    ok: true,
    core: languages.listCore(),
    enabled: languages.listEnabled(),
    supported_tts: languages.listSupported(),
    last_detected: languages.getLastDetected(),
  });
});

app.post("/languages/enable", express.json(), async (req, res) => {
  const info = languages.enableLanguage(req.body?.language);
  if (!info.ok) {
    return res.status(400).json({ ok: false, error: info.error, supported_tts: languages.listSupported() });
  }
  let tts = null;
  if (TTS_PROVIDER === "local") {
    tts = await languages.ensureTtsLanguage(info.language, TTS_LOCAL_URL);
  }
  res.json({ ...info, tts });
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


const server = http.createServer(app);

// ========== WebSocket (bidirectional) ==========
// Handle both Twilio (/ws) and Browser (/client-ws)
const wss = new WebSocket.Server({ server });
// ws re-emits the http server's listen errors; without this the EADDRINUSE
// handler above is bypassed and node crashes with a raw stack trace.
wss.on("error", handleListenError);


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
  const confirmedMeetings = new Set(); // Track confirmed meetings to prevent re-checking
  
  const info = db.company_info || {};
  // System prompt now comes from lib/system-prompt.js -- the same module the
  // benchmark scores, so bench and production can never drift apart.
  //
  // KB_MODE=lean (default) trims db.json's company_info from ~5,461 chars to
  // ~2,100 by dropping embedded LinkedIn work histories from key_contacts.
  // Measured 10/10 on the behavioural suite at 34% fewer tokens, which matters
  // because the prompt is resent every turn against Groq's 12k tokens/minute cap.
  const dynamicPrompt = buildSystemPrompt();

  const convo = [ { role: "system", content: dynamicPrompt } ];

  // Handle text messages from browser / any WS client (language comes from /stt registry)
  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "text" && data.text) {
        // Half-duplex check: If AI is speaking, ignore incoming text to prevent self-reply/echo
        if (isSpeaking) {
            console.log("Ignored input while speaking:", data.text);
            return;
        }

        // Optional hint from client; /stt already enabled the language server-side.
        if (data.language) {
          const info = languages.enableLanguage(data.language);
          if (info.ok && info.newlyEnabled && TTS_PROVIDER === "local") {
            await languages.ensureTtsLanguage(info.language, TTS_LOCAL_URL);
          }
        }
        console.log("Browser STT:", data.text, `(lang=${languages.getLastDetected()})`);
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
    
    // Clean up DeepSeek/R1 thinking tags
    let reply = (llm || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    
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
          let { visitor_name, visitor_company, host_name, host_company, department } = action.args || {};

          // Auto-fill from last collected info if missing
          if (!visitor_name && lastCollectedInfo?.name) visitor_name = lastCollectedInfo.name;
          if (!visitor_company && lastCollectedInfo?.company) visitor_company = lastCollectedInfo.company;

          // Loop prevention: If we are already waiting for approval or confirmed, skip
          const meetingKey = `${visitor_name}|${host_name}`;
          if (waitingForApproval || confirmedMeetings.has(meetingKey)) {
             console.log("ℹ️ Skipping redundant check_meeting (already waiting or confirmed).");
             // Do NOT overwrite 'reply' here, let the LLM's natural text response stand
          } else {
              // Helper to check for invalid/placeholder strings
              const isInvalid = (str) => !str || str.trim().length < 2 || str.trim() === "?" || str.toLowerCase() === "unknown";
    
              if (isInvalid(visitor_name) || isInvalid(host_name) || isInvalid(visitor_company) || isInvalid(host_company) || isInvalid(department)) {
                 // Dynamic missing info prompt
                 let missing = [];
                 const isAr = /[\u0600-\u06FF]/.test(text) || /[\u0600-\u06FF]/.test(reply);
                 
                 if (isInvalid(visitor_name)) missing.push(isAr ? "اسمك" : "your name");
                 if (isInvalid(visitor_company)) missing.push(isAr ? "اسم شركتك" : "your company name");
                 if (isInvalid(host_name)) missing.push(isAr ? "اسم الشخص اللي هتقابله" : "who you are meeting with");
                 if (isInvalid(host_company)) missing.push(isAr ? "شركة المضيف" : "host company");
                 if (isInvalid(department)) missing.push(isAr ? "القسم" : "department");
                 
                 if (missing.length > 0) {
                     const list = missing.join(isAr ? " و " : " and ");
                     reply = isAr 
                       ? `ممكن تقول لي ${list} عشان أقدر أساعدك؟`
                       : `Could you please tell me ${list} to proceed?`;
                 } else {
                     reply = isAr 
                       ? `ممكن بيانات الاجتماع كاملة عشان أقدر أساعدك؟` 
                       : `Could you please provide full meeting details to proceed?`;
                 }
                 // Skip processing logic if data is missing
              } else {
                console.log("🔍 Checking meeting:", { visitor_name, visitor_company, host_name, host_company, department });
                
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
                     const vNameMatch = isSimilar(m.visitor_name, visitor_name, 0.6, "VName");
                     
                     // Visitor Company
                     let vCompMatch = true;
                     if (visitor_company && m.visitor_company) {
                       vCompMatch = isSimilar(m.visitor_company, visitor_company, 0.5, "VComp");
                     }

                     // Host Name Matching
                     // Use isSimilar which includes Levenshtein + Cosine Hybrid logic
                     const hNameMatch = isSimilar(m.host_name, host_name, 0.6, "HName");

                     // Host Company
                     let hCompMatch = true;
                     if (host_company && m.host_company) {
                        hCompMatch = isSimilar(m.host_company, host_company, 0.5, "HComp");
                     }

                     // Department
                     let deptMatch = true;
                     if (department && m.department) {
                        deptMatch = isSimilar(m.department, department, 0.5, "Dept");
                     }
                 
                 const lenRatio = host_name.length / m.host_name.length;
                 
                 // Debug log - hNameMatch uses the new hybrid logic!
                 console.log(`Checking: ${m.visitor_name} vs ${visitor_name} (${vNameMatch}), ${m.host_name} vs ${host_name} (Match:${hNameMatch}), VComp:${vCompMatch}, HComp:${hCompMatch}, Dept:${deptMatch}`);

                 if (vNameMatch && vCompMatch && hNameMatch && hCompMatch && deptMatch) {
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
                       // Mark as confirmed to prevent future re-checks
                       confirmedMeetings.add(`${visitor_name}|${host_name}`);
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
                // Show the spoken text in the chat before audio starts.
                if (ws.readyState === WebSocket.OPEN && text) {
                  ws.send(JSON.stringify({ type: "reply", text }));
                }
                if (TTS_PROVIDER === "local") {
                    await speakLocal(text);
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
      // Convert 24h time (HH:mm) to Arabic 12h format
      processed = processed.replace(/\b(\d{1,2}):(\d{2})\b/g, (match, h, m) => {
        let hour = parseInt(h);
        const min = parseInt(m);
        let suffix = "صباحاً";
        
        if (hour >= 12) {
          suffix = "مساءً";
          if (hour > 12) hour -= 12;
        }
        if (hour === 0) hour = 12;
        
        const minStr = min === 0 ? "" : ` و ${min}`;
        return `${hour}${minStr} ${suffix}`;
      });
    } else {
      // English Normalization
      
      // 1. Dates (Years) - e.g. 1938 -> nineteen thirty-eight
      // Heuristic: 4 digits starting with 19 or 20, often preceded by "in" or "since" or just a date context
      // We need to avoid matching 4-digit numbers that are part of phone numbers if they weren't caught yet
      // But usually years are distinct.
      processed = processed.replace(/\b(19|20)(\d{2})\b/g, (match, p1, p2) => {
        // Simple map for first part
        const prefixes = { "19": "nineteen", "20": "twenty" };
        
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
            let spaced = match.split('').map(c => /\d/.test(c) ? `${c}, ` : c).join('');
             
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

  /**
   * Self-hosted TTS (NAMAA-Egyptian-TTS for Arabic / Chatterbox for English).
   *
   * Requires the sidecar in tts-server/ running on a GPU (~8GB VRAM).
   * Unlike ElevenLabs this is NOT streaming: the model synthesizes a whole
   * utterance, so the first byte arrives only when synthesis completes. We
   * still chunk the send so the client's playback path is identical.
   *
   * The sidecar returns WAV; we strip the header and forward raw PCM to honour
   * the client contract (PCM 24kHz / 16-bit / mono / LE, then {type:'tts_end'}).
   */
  function detectTtsLanguage(text) {
    return languages.resolveTtsLanguage(text, languages.getLastDetected());
  }

  async function speakLocal(text) {
    try {
      const lang = detectTtsLanguage(text);
      // Ensure sidecar knows about on-demand languages (no-op for ar/en).
      if (!languages.isCore(lang)) {
        await languages.ensureTtsLanguage(lang, TTS_LOCAL_URL);
      }
      const speechLocale = lang === "ar" ? "ar-EG" : (lang === "zh" ? "zh-CN" : "en-US");
      const ttsText = processTextForSpeech(preprocessTextForElevenLabs(text), speechLocale);
      if (LOG_TRANSCRIPTS) console.log(`[tts] lang=${lang} → local: ${ttsText.slice(0, 80)}`);

      const response = await fetch(`${TTS_LOCAL_URL.replace(/\/$/, "")}/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: ttsText, language: lang, sample_rate: 24000 })
      });

      if (!response.ok) {
        const err = await response.text().catch(() => "");
        throw new Error(`Local TTS ${response.status}: ${err.slice(0, 200)}`);
      }

      const buf = Buffer.from(await response.arrayBuffer());

      // Strip the RIFF header if present; the client expects bare PCM frames.
      let pcm = buf;
      if (buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF") {
        let off = 12;
        while (off + 8 <= buf.length) {
          const id = buf.toString("ascii", off, off + 4);
          const size = buf.readUInt32LE(off + 4);
          if (id === "data") { pcm = buf.subarray(off + 8, off + 8 + size); break; }
          off += 8 + size + (size % 2);
        }
      }

      // Send in ~20ms frames so playback scheduling matches the streaming path.
      const FRAME = 960 * 2;
      for (let i = 0; i < pcm.length; i += FRAME) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(pcm.subarray(i, Math.min(i + FRAME, pcm.length)));
      }
      ws.send(JSON.stringify({ type: 'tts_end' }));
    } catch (e) {
      console.error("Local TTS error", e.message);
      // Signal end-of-utterance so the client does not hang waiting for audio.
      try { ws.send(JSON.stringify({ type: 'tts_end' })); } catch {}
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


// A port clash is the most common first-run failure on a new machine, and the
// raw EADDRINUSE stack trace does not say what to do about it.
//
// The listener must be attached to BOTH the http server and the WebSocketServer:
// `ws` attaches to the same http server and re-emits its errors, so handling
// only one of them still leaves an unhandled 'error' event that crashes the
// process with a stack trace.
function handleListenError(err) {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error(`  - another Geno instance may still be running, or`);
    console.error(`  - start on a different port:  PORT=3001 npm start\n`);
    process.exit(1);
  }
  console.error("Server error:", err);
  process.exit(1);
}
server.on("error", handleListenError);

server.listen(PORT, () => {
  const s = providerStatus();
  console.log(`Geno listening on http://localhost:${PORT}  (public: ${PUBLIC_URL})`);
  console.log(`  LLM  ${s.llm.provider} / ${s.llm.model}${s.llm.fallbacks.length ? ` (fallback: ${s.llm.fallbacks.join(", ")})` : ""}`);
  console.log(`  STT  ${s.stt.serverSide ? `${s.stt.provider} / ${s.stt.model}` : "browser Web Speech API"}`);
  console.log(`  TTS  ${s.tts.provider}`);
  if (!s.llm.configured) console.warn(`  WARNING: LLM has no credentials - run: npm run doctor`);
  if (s.stt.serverSide && !s.stt.configured) console.warn(`  WARNING: STT has no credentials - run: npm run doctor`);
  if (!s.tts.configured) console.warn(`  WARNING: TTS has no credentials - run: npm run doctor`);
});

