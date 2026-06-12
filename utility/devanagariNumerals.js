/** Devanagari digits ०–९ (Marathi/Hindi numerals). */
const DEVANAGARI_ZERO = 0x0966;
const ASCII_ZERO = 0x30;

/**
 * Converts Devanagari/Marathi digits in a string to Western Arabic (0-9).
 * Non-digit characters are preserved.
 */
export function devanagariToAsciiDigits(value) {
  if (value == null) return value;
  let out = "";
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (code >= DEVANAGARI_ZERO && code <= DEVANAGARI_ZERO + 9) {
      out += String.fromCharCode(ASCII_ZERO + (code - DEVANAGARI_ZERO));
    } else {
      out += ch;
    }
  }
  return out;
}
