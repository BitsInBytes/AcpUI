import { describe, expect, it } from 'vitest';
import { parseLocalFileLinkHref } from '../utils/localFileLinks';

describe('parseLocalFileLinkHref', () => {
  it('parses Windows drive paths and removes line suffixes', () => {
    expect(parseLocalFileLinkHref('D:/Git/AcpUI/.devFiles/work-done/report.md:1')).toBe(
      'D:/Git/AcpUI/.devFiles/work-done/report.md'
    );
    expect(parseLocalFileLinkHref('C:\\repos\\demo\\src\\app.ts:42:7')).toBe('C:\\repos\\demo\\src\\app.ts');
  });

  it('decodes spaces and strips angle brackets', () => {
    expect(parseLocalFileLinkHref('<D:/Git/AcpUI/My%20Report.md:12>')).toBe('D:/Git/AcpUI/My Report.md');
  });

  it('supports file URLs', () => {
    expect(parseLocalFileLinkHref('file:///D:/Git/AcpUI/README.md:3')).toBe('D:/Git/AcpUI/README.md');
  });

  it('ignores non-local links', () => {
    expect(parseLocalFileLinkHref('https://example.com/file.md:1')).toBeNull();
    expect(parseLocalFileLinkHref('//example.com/file.md')).toBeNull();
    expect(parseLocalFileLinkHref('/documents/README.md')).toBeNull();
    expect(parseLocalFileLinkHref('#section')).toBeNull();
  });
});
