import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('xlsx', () => {
  const mockSheet = {};
  return {
    read: vi.fn(() => ({
      SheetNames: ['Sheet1'],
      Sheets: { Sheet1: mockSheet },
    })),
    utils: {
      sheet_to_csv: vi.fn(() => 'col1,col2\nval1,val2'),
    },
  };
});

import { parseFileToContent } from '../../src/services/fileParsers.js';
import * as XLSX from 'xlsx';

describe('parseFileToContent()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return inlineData for PDF files', () => {
    const result = parseFileToContent({
      mimeType: 'application/pdf',
      data: 'base64pdfdata',
      name: 'test.pdf',
    });
    expect(result.type).toBe('inlineData');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.data).toBe('base64pdfdata');
  });

  it('should parse Excel files to text', () => {
    const result = parseFileToContent({
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: Buffer.from('fake-excel').toString('base64'),
      name: 'test.xlsx',
    });
    expect(result.type).toBe('text');
    expect(result.text).toContain('Sheet1');
    expect(result.text).toContain('col1,col2');
  });

  it('should include filename in label when provided', () => {
    const result = parseFileToContent({
      mimeType: 'text/csv',
      data: Buffer.from('fake-csv').toString('base64'),
      name: 'data.csv',
    });
    expect(result.text).toContain('[File: data.csv]');
  });

  it('should use default label when no name provided', () => {
    const result = parseFileToContent({
      mimeType: 'text/csv',
      data: Buffer.from('fake-csv').toString('base64'),
    });
    expect(result.text).toContain('[Attached spreadsheet]');
  });

  it('should throw when file contains no readable data', () => {
    XLSX.utils.sheet_to_csv.mockReturnValue('   ');
    expect(() =>
      parseFileToContent({
        mimeType: 'text/csv',
        data: Buffer.from('empty').toString('base64'),
        name: 'empty.csv',
      })
    ).toThrow('no readable data');
  });
});
