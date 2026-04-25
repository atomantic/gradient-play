// Floor-language bulkhead: trade directives that embed a credit-floor
// constraint ("keep 5000 on-hand", "1000cr floor") cause TaskAgents to
// refuse cargo buys when the purchase would drop the ship below the named
// floor. Valid only in deposit/sweep/fund prompts; callers that legitimately
// need floor language pass { bypassFloorGuard: true }.

const FLOOR_PATTERNS = [
  /\bkeep\s+[\d,]+\s*(?:cr|credits?)\b/i,
  /\b(?:keep|hold)\s+[\d,]+\s*(?:cr|credits?)?\s*on[\s-]?hand\b/i,
  /\b[\d,]+\s*(?:cr|credits?)\s+(?:floor|minimum|reserve)\b/i,
  /\bon[\s-]?hand\s+min(?:imum)?\b/i,
  /\b(?:credit|cash)\s+(?:floor|reserve)\b/i,
  /\b(?:maintain|retain)\s+[\d,]+\s*(?:cr|credits?)\b/i,
  /\bfloor\s+always\b/i,
];

export const detectFloorLanguage = (text) => {
  if (!text) return { matched: false };
  for (const re of FLOOR_PATTERNS) {
    const m = String(text).match(re);
    if (m) return { matched: true, pattern: re.source, sample: m[0] };
  }
  return { matched: false };
};
