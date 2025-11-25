require("dotenv").config();
const sdk = require("microsoft-cognitiveservices-speech-sdk");

const key = process.env.AZURE_SPEECH_KEY;
const region = process.env.AZURE_SPEECH_REGION;

console.log(`Testing Azure Speech Credentials...`);
console.log(`Region: '${region}'`);
console.log(`Key: '${key ? key.slice(0, 4) + "..." : "MISSING"}'`);

if (!key || !region) {
    console.error("❌ Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION in .env");
    process.exit(1);
}

const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
// Disable audio output for this test
const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);

console.log("Attempting to synthesize text...");

synthesizer.speakTextAsync(
    "Test",
    result => {
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            console.log("✅ Success! Credentials are valid.");
        } else {
            console.error("❌ Authentication Failed.");
            console.error("Details:", result.errorDetails);
        }
        synthesizer.close();
    },
    error => {
        console.error("❌ Error:", error);
        synthesizer.close();
    }
);
