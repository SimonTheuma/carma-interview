const PATTERNS_EN = [
  /ignore (all )?(previous|prior|above) instructions/i,
  /you are now/i,
  /system prompt/i,
  /disregard (the )?rules/i,
];
const PATTERNS_AR = [/تجاهل التعليمات/i, /أنت الآن/i];
const PATTERNS_ZH = [/忽略(以上|之前)?指令/, /你现在是/];

/** Linear-time injection heuristic; flags low trust, never drops. */
export function detectInjection(text: string): boolean {
  for (const re of PATTERNS_EN) if (re.test(text)) return true;
  for (const re of PATTERNS_AR) if (re.test(text)) return true;
  for (const re of PATTERNS_ZH) if (re.test(text)) return true;
  return false;
}
