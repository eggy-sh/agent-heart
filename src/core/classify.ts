/**
 * Failure classification from captured stderr.
 *
 * Behavior-preserving extraction of the logic embedded in `exec --capture`,
 * pulled into a pure function so it can be tested and extended independently.
 * Today it recognizes permission failures; new categories slot in here.
 */

const PERMISSION_PATTERNS: readonly RegExp[] = [
  /permission denied/i,
  /\b403\b/,
  /\b401\b/,
  /unauthorized/i,
  /not authorized/i,
  /EPERM\b/,
  /EACCES\b/,
  /access denied/i,
];

/**
 * Classify a failure from its captured stderr.
 * Returns a short class label (e.g. "permission"), or undefined when nothing
 * matches (including empty input).
 */
export function classifyFailure(stderr: string): string | undefined {
  if (!stderr) return undefined;
  for (const pattern of PERMISSION_PATTERNS) {
    if (pattern.test(stderr)) return "permission";
  }
  return undefined;
}
