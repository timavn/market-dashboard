/** Recognize an explicit portfolio capture request, never a quoted command or a research question. */
function isPortfolioRefreshRequest(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim().replace(/[’‘]/g, "'")
    .replace(/```[\s\S]*?```|`[^`]*`|"[^"]*"/g, ' ')
    .replace(/(^|[\s(])'[^'\n]*'(?=$|[\s).,?!])/g, '$1 ')
    .replace(/\b(?:report|email|source|article|example|command|prompt)\s+(?:says|reads|suggests|contains|is)\s*:[^.!?;]*/gi, ' ')
    .replace(/\s+/g, ' ');
  if (!text || text.length > 20_000) return false;
  if (/\bportfolio\s+(?:quotes?|prices?|marks?|charts?|display|data)\b/i.test(text)) return false;
  if (/\b(?:don't|dont|do not|never|avoid|cancel|stop|without)\b[^.!?;]{0,70}\b(?:refresh|review|realign|catch[ -]?up|reassess|recheck)\b/i.test(text)) return false;
  if (/^(?:what|why|when|where|how|is|does|did|will|should)\b/i.test(text)
    || /^(?:can|could|would)\s+(?:(?:the|this|your)\s+)?(?:hermes|analyst|bot|it)\b/i.test(text)) return false;

  const cue = "(?:^|[.!?;:]\\s*[)\\]]?\\s*|\\b(?:and|then)\\s+)(?:(?:please|can you|could you|would you|i want you to|i'd like you to|let's|lets)\\s+)?(?:please\\s+)?";
  const portfolio = '(?:(?:my|our|the)\\s+)?portfolio';
  const qualifier = '(?:fresh|full|complete|comprehensive|catch[ -]?up)';
  const direct = new RegExp(`${cue}(?:refresh|recheck|reassess)\\s+${portfolio}\\b|${cue}${qualifier}\\s+portfolio\\s+(?:review|refresh)\\b|${cue}portfolio\\s+refresh\\b|${cue}(?:run|start|prepare|do|give me)\\s+(?:(?:a|the)\\s+)?${qualifier}\\s+portfolio\\s+(?:review|refresh|check)\\b|${cue}review\\s+and\\s+realign\\s+${portfolio}\\b`, 'i');
  if (direct.test(text)) return true;
  const review = new RegExp(`${cue}review\\s+${portfolio}\\b`, 'i');
  return review.test(text) && (/\b(?:realign|catch[ -]?up|recent products|latest research|all (?:research|products|holdings|positions))\b/i.test(text)
    || new RegExp(`^review\\s+${portfolio}[.!]?$`, 'i').test(text));
}

module.exports = { isPortfolioRefreshRequest };
