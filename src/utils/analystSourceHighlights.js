const MIN_PASSAGE_LENGTH = 24;
const MIN_PASSAGE_WORDS = 4;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

const meaningfulPassage = (text) => (
  text.length >= MIN_PASSAGE_LENGTH
  && (text.match(/[\p{L}]+(?:['’][\p{L}]+)*/gu) || []).length >= MIN_PASSAGE_WORDS
);

// Every normalized code unit maps back to the original string. In particular,
// collapsed newlines and Unicode case folding must not shift the highlight.
const normalizeWithOffsets = (text) => {
  let normalized = '';
  const starts = [];
  const ends = [];
  let offset = 0;

  for (const character of text) {
    const end = offset + character.length;
    if (/\s/u.test(character)) {
      if (normalized.endsWith(' ')) {
        ends[ends.length - 1] = end;
      } else {
        normalized += ' ';
        starts.push(offset);
        ends.push(end);
      }
    } else {
      const folded = character.toLowerCase();
      normalized += folded;
      for (let index = 0; index < folded.length; index += 1) {
        starts.push(offset);
        ends.push(end);
      }
    }
    offset = end;
  }

  return { normalized, starts, ends };
};

const withoutHeading = (text) => {
  const match = text.match(/^([\p{L}][\p{L}\s&/-]{0,45}?)(?:\s+[—–]\s+|:\s+)([\s\S]+)$/u);
  if (!match || match[1].trim().split(/\s+/u).length > 5) return text;
  // Strip a short descriptive label, never an action, number, or negation.
  if (/\b(?:not|no|never|without|long|short|bullish|bearish|buy|sell|cover|increase|decrease|rise|fall|rose|fell)\b/iu.test(match[1])) return text;
  return match[2];
};

const passageCandidates = (text) => {
  const candidates = new Set([text]);
  for (const paragraph of text.split(/\n\s*\n/u)) {
    const passage = withoutHeading(paragraph.trim());
    candidates.add(passage);
    // Only split at sentence boundaries, never at individual words or commas.
    // A lowercase continuation remains attached to the preceding sentence.
    for (const sentence of passage.split(/(?<=[.!?])\s+(?=["“(]*\p{Lu})/u)) {
      candidates.add(sentence);
    }
  }
  return [...candidates]
    .map((candidate) => normalizeWithOffsets(candidate).normalized.trim())
    .filter(meaningfulPassage);
};

const passageRanges = ({ normalized, starts, ends }, passage) => {
  const ranges = [];
  let from = 0;
  let match = normalized.indexOf(passage, from);
  while (match !== -1) {
    const after = match + passage.length;
    const startsInsideWord = WORD_CHARACTER.test(passage[0])
      && match > 0 && WORD_CHARACTER.test(normalized[match - 1]);
    const endsInsideWord = WORD_CHARACTER.test(passage[passage.length - 1])
      && after < normalized.length && WORD_CHARACTER.test(normalized[after]);
    if (!startsInsideWord && !endsInsideWord) {
      ranges.push({ start: starts[match], end: ends[after - 1] });
    }
    from = match + 1;
    match = normalized.indexOf(passage, from);
  }
  return ranges;
};

/** Plain-text source matches, with original UTF-16 offsets and exclusive ends. */
export const analystSourceHighlightRanges = (excerpt, highlightTexts) => {
  if (typeof excerpt !== 'string' || !excerpt || !Array.isArray(highlightTexts)) return [];
  const source = normalizeWithOffsets(excerpt);
  const ranges = [];

  for (const text of highlightTexts) {
    if (typeof text !== 'string' || !text.trim()) continue;
    for (const candidate of passageCandidates(text)) {
      ranges.push(...passageRanges(source, candidate));
    }
  }

  const merged = [];
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
};
