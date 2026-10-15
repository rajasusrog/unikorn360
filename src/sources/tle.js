/**
 * Parse three-line TLE catalog text into `{ name, line1, line2 }` entries.
 * Malformed sets are skipped without dropping the valid sets that follow.
 */
export function parseTleText(text) {
  const lines = String(text)
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const result = [];
  for (let i = 0; i < lines.length - 2; i++) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    const cat1 = tleCatalogNumber(line1);
    const cat2 = tleCatalogNumber(line2);
    if (
      line1.startsWith('1 ') &&
      line2.startsWith('2 ') &&
      cat1 !== null &&
      cat1 === cat2
    ) {
      result.push({ name, line1, line2 });
      i += 2;
    }
  }
  return result;
}

/** The NORAD catalog number from a TLE line, or null. */
export function tleCatalogNumber(line) {
  const number = Number.parseInt(String(line).slice(2, 7), 10);
  return Number.isInteger(number) ? number : null;
}
