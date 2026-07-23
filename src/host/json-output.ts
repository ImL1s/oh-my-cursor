export interface JsonParseOptions { readonly maxBytes?: number; readonly maxRecords?: number }

export function parseCursorJsonOutput(text: string, options: JsonParseOptions = {}): unknown {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const maxRecords = options.maxRecords ?? 1000;
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('E_OUTPUT_TOO_LARGE');
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('E_EMPTY_JSON_OUTPUT');
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    if (lines.length > maxRecords) throw new Error('E_TOO_MANY_JSON_RECORDS');
    try {
      return lines.map((line) => JSON.parse(line) as unknown);
    } catch {
      throw new Error('E_INVALID_CURSOR_JSON');
    }
  }
}
