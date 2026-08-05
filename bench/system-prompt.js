// Re-export of the PRODUCTION system prompt (lib/system-prompt.js).
//
// The benchmark must score exactly what production sends, so this file holds no
// prompt text of its own. Edit lib/system-prompt.js; both bench and server pick
// the change up automatically.
//
// Note: buildSystemPrompt defaults to the lean knowledge base (KB_MODE=lean).
// Pass { kbMode: "full" } to score the untrimmed variant.

module.exports = require("../lib/system-prompt");
