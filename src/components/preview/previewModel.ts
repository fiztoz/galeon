/**
 * What Galeon will preview, and how.
 *
 * The gate is the resolved content type — S3 stores one, native SFTP/FTP do
 * not — so the drawer, the context menu, and the preview loader all consult
 * this one table instead of deciding for themselves. Pure: no React, no Tauri.
 */
import type { StorageProtocol } from '../../types';

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  yaml: 'application/yaml',
  yml: 'application/yaml',
};

export function deriveContentType(key: string): string | null {
  const ext = key.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  return MIME_MAP[ext] ?? null;
}

export type PreviewKind = 'image' | 'pdf' | 'text';

// Application/content types that are text under the hood despite an `application/*`
// prefix. Used alongside the `text/*` family to decide what we can show as text.
const TEXTUAL_APP_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
]);

// Only common, safely-renderable types get a preview — everything else falls back
// to metadata only. This is the "by seeing the application type" gate: previews
// are driven off the resolved content type, not blindly off every file.
export function previewKindFor(contentType: string | null): PreviewKind | null {
  if (!contentType) return null;
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (ct === 'application/pdf') return 'pdf';
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('text/') || TEXTUAL_APP_TYPES.has(ct)) return 'text';
  return null;
}

export function isPreviewableFile(
  key: string,
  protocol?: StorageProtocol,
): boolean {
  const isS3 = !protocol || protocol === 's3';
  if (!isS3) return false;
  return previewKindFor(deriveContentType(key)) !== null;
}

// Whole-file types (image/pdf) must fit under this cap to be previewed; larger
// objects show a "download to view" hint instead of being pulled into memory.
export const PREVIEW_BINARY_MAX = 20 * 1024 * 1024; // 20 MB
// Text is bounded server-side: we only ever fetch the first slice for display.
export const PREVIEW_TEXT_BYTES = 256 * 1024; // 256 KB
