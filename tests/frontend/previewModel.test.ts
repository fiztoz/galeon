import { test, expect } from 'bun:test';
import {
  PREVIEW_BINARY_MAX,
  PREVIEW_TEXT_BYTES,
  deriveContentType,
  isPreviewableFile,
  previewKindFor,
} from '../../src/components/preview/previewModel';

test('the extension decides a type when the object has no metadata', () => {
  expect(deriveContentType('notes/photo.JPG')).toBe('image/jpeg');
  expect(deriveContentType('report.pdf')).toBe('application/pdf');
  expect(deriveContentType('settings.yaml')).toBe('application/yaml');
  expect(deriveContentType('LICENSE')).toBe(null);
  expect(deriveContentType('archive.unknownext')).toBe(null);
});

test('the resolved content type decides what kind of preview it gets', () => {
  expect(previewKindFor('application/pdf')).toBe('pdf');
  expect(previewKindFor('image/png')).toBe('image');
  expect(previewKindFor('image/png; charset=binary')).toBe('image');
  expect(previewKindFor('text/plain')).toBe('text');
  expect(previewKindFor('application/json')).toBe('text');
  expect(previewKindFor('application/zip')).toBe(null);
  expect(previewKindFor(null)).toBe(null);
});

test('native protocols expose no content type, so they never preview', () => {
  expect(isPreviewableFile('notes.md')).toBe(true);
  expect(isPreviewableFile('notes.md', 's3')).toBe(true);
  expect(isPreviewableFile('notes.md', 'sftp')).toBe(false);
  expect(isPreviewableFile('notes.md', 'ftp')).toBe(false);
  expect(isPreviewableFile('notes.md', 'webdav')).toBe(false);
});

test('an unpreviewable extension stays metadata-only', () => {
  expect(isPreviewableFile('dump.bin')).toBe(false);
  expect(isPreviewableFile('no-extension')).toBe(false);
});

test('text is capped well below the whole-file cap', () => {
  expect(PREVIEW_TEXT_BYTES).toBeLessThan(PREVIEW_BINARY_MAX);
  expect(PREVIEW_BINARY_MAX).toBe(20 * 1024 * 1024);
});