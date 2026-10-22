/**
 * Conservative tokenizer-independent estimate for prompt budgeting.
 *
 * Qwen's exact tokenizer lives with the model runtime, not in these services.
 * This estimator intentionally keeps a safety margin for JSON framing and
 * charges CJK/non-ASCII text conservatively so budgets stay below runtime limits.
 */
export function estimateModelTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return 0;

  let tokens = 0;
  let asciiRun = 0;
  const flushAscii = () => {
    if (!asciiRun) return;
    tokens += Math.ceil(asciiRun / 3);
    asciiRun = 0;
  };

  for (const character of text) {
    const codePoint = character.codePointAt(0) || 0;
    // Qwen's BPE merges ASCII words, URLs, and common JSON syntax. Charging
    // one token per three ASCII characters remains conservative on the real
    // Anime Expo payload without treating every JSON quote/comma as a token.
    if (codePoint <= 0x7f) {
      asciiRun += 1;
      continue;
    }
    flushAscii();
    if (
      (codePoint >= 0x3400 && codePoint <= 0x9fff)
      || (codePoint >= 0x3040 && codePoint <= 0x30ff)
      || (codePoint >= 0xac00 && codePoint <= 0xd7af)
    ) {
      tokens += 1;
    } else {
      tokens += Math.max(1, Math.ceil(new TextEncoder().encode(character).length / 2));
    }
  }
  flushAscii();

  // Chat templates and provider-specific message framing are not present in
  // the serialized input. Keep an 8% safety margin for that overhead.
  return Math.ceil(tokens * 1.08);
}

export function estimateChatTokens(system: string, user: string): number {
  return estimateModelTokens(system) + estimateModelTokens(user) + 32;
}
