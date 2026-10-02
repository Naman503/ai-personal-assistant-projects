/**
 * Mask secrets before text leaves the device. It's conservative: it targets
 * patterns that are almost never needed to answer a form question.
 */

const PATTERNS: [RegExp, string][] = [
  // Payment card numbers (13–19 digits with optional separators), validated with Luhn below.
  [/\b(?:\d[ -]?){13,19}\b/g, '[card]'],
  // IBAN
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, '[iban]'],
  // Private keys / tokens
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private-key]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}\b/g, '[api-key]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[api-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, '[token]'],
  // "password: xyz" style lines
  [/\b(pass(word)?|pwd|passcode|pin)\s*[:=]\s*\S+/gi, '$1: [redacted]'],
];

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) {
    if (rep === '[card]') {
      out = out.replace(re, (m) => {
        const d = m.replace(/\D/g, '');
        return d.length >= 13 && d.length <= 19 && luhn(d) ? rep : m;
      });
    } else out = out.replace(re, rep);
  }
  return out;
}
