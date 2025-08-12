# AI Egyptian Restaurant Receptionist

Realtime Arabic (Egyptian dialect) phone receptionist using:
* Twilio Voice Media Streams (8k μ-law) – bidirectional
* Google Cloud Speech-to-Text (streaming) + Text-to-Speech (μ-law 8k)
* Optional LLM (OpenAI-compatible) for smart dialog + tool JSON (<tool>{}</tool>)
* Lightweight JSON file DB for customers, reservations, menu

## 1. Prerequisites
* Node.js 18+
* Twilio account + phone number (Voice)
* Google Cloud project with Speech-to-Text & Text-to-Speech APIs enabled (billing on)
* (Optional) LLM provider (OpenRouter, OpenAI, local gateway, etc.)

## 2. Google Cloud Setup
1. Enable APIs: Speech-to-Text, Text-to-Speech.
2. Create Service Account (roles: Cloud Speech Client, Cloud Text-to-Speech Admin minimal).
3. Create JSON key, download to a safe path.
4. Set `GOOGLE_APPLICATION_CREDENTIALS` in `.env` to the absolute path (Windows backslashes escaped if in JSON context, normal in .env).

## 3. Clone / Prepare Project
```
cd Restraunt_AI_Receiptionist
copy .env.example .env   # Windows PowerShell: cp .env.example .env
```
Edit `.env` with your values.

## 4. Install Dependencies
```
npm install
```

## 5. Expose Local Port (choose one)
LocalTunnel (simple / demo):
```
npx localtunnel --port 3000
```
Ngrok:
```
ngrok http 3000
```
Cloudflare Tunnel (recommended for stability) – follow `cloudflared` docs.

Set the public https URL in `.env` as `PUBLIC_URL`. Restart server after changing.

## 6. Run Server
```
npm start
```
Health check: open http://localhost:3000/health

Console should show: `AI receptionist server listening...`

## 7. Twilio Number Configuration
In Twilio Console -> Phone Numbers -> Active Number -> Voice Configuration:
* A CALL COMES IN: Webhook
* Method: HTTP POST
* URL: `https://YOUR_PUBLIC_TUNNEL/voice`
Save.

Call your Twilio number; it should greet you then stream audio.

## 8. Flow
1. Caller speaks Arabic (Egyptian).
2. Twilio sends μ-law frames via WebSocket.
3. App decodes → Google STT.
4. Final transcripts sent to LLM (if configured).
5. LLM may emit `<tool>{"name":"place_reservation",...}</tool>` JSON → parsed → DB updated.
6. Assistant response synthesized via Google TTS (μ-law) back to caller.

## 9. Reservation Tool Schema
```
<tool>{
  "name": "place_reservation",
  "args": {
    "name": "اسم",
    "phone": "+2010...",
    "party_size": 4,
    "iso_datetime": "2025-08-11T20:00:00+02:00"
  }
}</tool>
```

## 10. Testing Without LLM
If you omit LLM env vars the system replies with a fallback phrase after each final transcript.

## 11. Data Files
* `db.json` auto-created on first run.

## 12. Production Hardening (Next Steps)
* Validate Twilio signatures on `/voice`.
* Rate limiting & auth for health / internal endpoints.
* Structured logging (pino / winston).
* Persistent DB (Postgres) & migrations.
* Better μ-law encoder (currently decode only; TTS already returns μ-law so fine).
* Retry + backoff for LLM & STT errors.

## 13. Troubleshooting
| Issue | Tip |
|-------|-----|
| Silence / no reply | Check console for TTS error; ensure APIs enabled. |
| STT errors | Verify service account roles + quota. |
| Twilio 502 | Public tunnel sleeping; re-run tunnel and update PUBLIC_URL. |
| LLM null replies | Confirm API key & model; inspect logs. |

## 14. License
Example scaffold – adapt freely (no warranty).
