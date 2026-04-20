import * as XLSX from 'xlsx';

/**
 * Parse an uploaded file into a Gemini-compatible content part.
 *
 * PDF  → returned as { type: 'inlineData', mimeType, data } (Gemini handles natively)
 * Excel/CSV → parsed into text, returned as { type: 'text', text }
 *
 * @param {{ mimeType: string, data: string, name?: string }} file
 * @returns {{ type: 'inlineData', mimeType: string, data: string } | { type: 'text', text: string }}
 */
export function parseFileToContent(file) {
  const { mimeType, data, name } = file;

  if (mimeType === 'application/pdf') {
    return { type: 'inlineData', mimeType, data };
  }

  // Excel / CSV → parse to text
  const buffer = Buffer.from(data, 'base64');
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const sheets = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (csv.trim()) {
      sheets.push(`--- Sheet: ${sheetName} ---\n${csv}`);
    }
  }

  if (sheets.length === 0) {
    throw new Error(`File${name ? ` "${name}"` : ''} contains no readable data`);
  }

  const label = name ? `[File: ${name}]` : '[Attached spreadsheet]';
  return { type: 'text', text: `${label}\n${sheets.join('\n\n')}` };
}
