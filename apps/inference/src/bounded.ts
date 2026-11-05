/**
 * Bounds on anything a refusal repeats: a caller's value, a facilitator's reason, a provider's error body. Request
 * bodies run to 1 MB, so an unbounded echo would turn one bad field into a large answer.
 */

/** One line of at most `max` characters; longer text ends in an ellipsis. */
export function boundedText(value: string, max: number): string {
  const line = value.replace(/\p{Cc}+/gu, ' ');
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

const MAX_JSON_CHARS = 2000;

/** A JSON value as it is when small, otherwise its text cut short. */
export function boundedJson(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= MAX_JSON_CHARS) return value;
  return { truncated: true, text: text.slice(0, MAX_JSON_CHARS) };
}
