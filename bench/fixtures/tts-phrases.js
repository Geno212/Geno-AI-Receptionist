// TTS benchmark phrases: real Geno receptionist output, Egyptian Arabic + English.
//
// Deliberately weighted toward the cases that already required special handling
// in server.js (processTextForSpeech / preprocessTextForElevenLabs, ~line 1160):
// numbers, phone numbers, times, years, emails, and the company name. Those are
// exactly where a new TTS model is most likely to regress, because they force
// the model to verbalize non-lexical tokens.
//
// `listenFor` is the human-judgment checklist -- automated stats catch silence
// and clipping, but only a listener catches "that sounds Levantine, not Egyptian".

const phrases = [
  {
    id: "ar-greeting",
    lang: "ar",
    text: "أهلاً بحضرتك في السويدي إليكتريك. أنا جينو، أقدر أساعدك إزاي؟",
    listenFor: ["Egyptian dialect, not MSA", "company name 'El Sewedy' pronounced correctly"],
  },
  {
    id: "ar-hours",
    lang: "ar",
    text: "مواعيد العمل عندنا من الأحد للخميس، من 9 الصبح لـ 5 المغرب.",
    listenFor: ["numbers 9 and 5 spoken as Arabic words", "natural time phrasing"],
  },
  {
    id: "ar-phone",
    lang: "ar",
    text: "رقم التليفون بتاعنا هو 27599700 02 20+.",
    listenFor: ["digits read individually, not as one huge number", "no digit skipped"],
  },
  {
    id: "ar-ask-details",
    lang: "ar",
    text: "ممكن الاسم ورقم التليفون واسم الشركة عشان أقدر أساعد حضرتك؟",
    listenFor: ["polite Egyptian register", "question intonation"],
  },
  {
    id: "ar-confirm-lead",
    lang: "ar",
    text: "تمام يا أحمد، بياناتك عندي: الرقم 01001234567 وشركة النيل للمقاولات. البيانات دي صحيحة؟",
    listenFor: ["long digit string stays intelligible", "rising confirmation intonation"],
  },
  {
    id: "ar-codeswitch",
    lang: "ar",
    text: "عندنا حلول smart meters وdata centers ضمن قطاع الحلول الرقمية.",
    listenFor: ["English terms not mangled inside Arabic prosody", "no language-switch artifact"],
  },
  {
    id: "ar-meeting-wait",
    lang: "ar",
    text: "لحظة واحدة من فضلك، بتأكد من الميعاد مع الأستاذ أحمد صادق.",
    listenFor: ["natural hold phrasing", "host name intelligible"],
  },
  {
    id: "en-greeting",
    lang: "en",
    text: "Welcome to El Sewedy Electric. I'm Geno. How can I help you today?",
    listenFor: ["'El Sewedy' pronounced correctly, not 'El Swaydee'"],
  },
  {
    id: "en-sectors",
    lang: "en",
    text: "We work across cables, transformers, and turnkey infrastructure projects. Would you like more detail on any of those?",
    listenFor: ["clear technical terms", "natural list prosody"],
  },
  {
    id: "en-founded",
    lang: "en",
    text: "El Sewedy Electric was founded in 1938 and is headquartered in New Cairo, Egypt.",
    listenFor: ["1938 as 'nineteen thirty-eight', not 'one thousand nine hundred'"],
  },
  {
    id: "en-email",
    lang: "en",
    text: "You can reach us at info@elsewedy.com or on +20 2 27599700.",
    listenFor: ["email read as 'info at elsewedy dot com'", "phone digits grouped sensibly"],
  },
  {
    id: "en-meeting-confirm",
    lang: "en",
    text: "Just to confirm, you are John Miller from Siemens meeting Ahmed Sadek in the IT department. Is that correct?",
    listenFor: ["proper nouns intelligible", "confirmation intonation"],
  },
];

module.exports = { phrases };
