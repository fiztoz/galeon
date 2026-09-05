import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { X, FileText, Folder, Database, Tag, Clock, HardDrive, Loader2, AlertCircle, Save, ShieldCheck, Copy, Check, Eye, ExternalLink } from 'lucide-react';
import type { GaleonObject } from '../types';
import { ProtocolCapabilities } from '../types';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface ObjectMetadataInfo {
  contentType: string | null;
  contentLength: number | null;
  lastModified: string | null;
  etag: string | null;
  cacheControl: string | null;
  contentEncoding: string | null;
  contentDisposition: string | null;
  storageClass: string | null;
  userMetadata: Record<string, string> | null;
}

export interface VerifyResult {
  matches: boolean;
  detail: string;
  checkedChecksum: boolean;
}

export interface PropertiesInspectorProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  object: GaleonObject | null;
  protocol?: 's3' | 'sftp' | 'ftp' | 'ftps';
  capabilities?: ProtocolCapabilities;
  mode?: 'properties' | 'preview';
}

// ── Constants ─────────────────────────────────────────────────────────────────

const S3_STORAGE_CLASSES = [
  'STANDARD',
  'STANDARD_IA',
  'ONEZONE_IA',
  'INTELLIGENT_TIERING',
  'GLACIER_IR',
  'GLACIER',
  'DEEP_ARCHIVE',
];

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  return `${value % 1 === 0 ? value : value.toFixed(2)} ${units[exp]}`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
}

export function deriveContentType(key: string): string | null {
  const ext = key.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  return MIME_MAP[ext] ?? null;
}

type PreviewKind = 'image' | 'pdf' | 'text';

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
function previewKindFor(contentType: string | null): PreviewKind | null {
  if (!contentType) return null;
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (ct === 'application/pdf') return 'pdf';
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('text/') || TEXTUAL_APP_TYPES.has(ct)) return 'text';
  return null;
}

export function isPreviewableFile(
  key: string,
  protocol?: 's3' | 'sftp' | 'ftp' | 'ftps',
): boolean {
  const isS3 = !protocol || protocol === 's3';
  if (!isS3) return false;
  return previewKindFor(deriveContentType(key)) !== null;
}

// Whole-file types (image/pdf) must fit under this cap to be previewed; larger
// objects show a "download to view" hint instead of being pulled into memory.
const PREVIEW_BINARY_MAX = 20 * 1024 * 1024; // 20 MB
// Text is bounded server-side: we only ever fetch the first slice for display.
const PREVIEW_TEXT_BYTES = 256 * 1024; // 256 KB

// ── Sub-components ────────────────────────────────────────────────────────────

interface RowProps {
  label: string;
  value: string;
  mono?: boolean;
}

const Row: React.FC<RowProps> = ({ label, value, mono = false }) => {
  const [copied, setCopied] = useState(false);
  
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy property:', err);
    }
  };

  return (
    <div className="flex flex-col gap-0.5 py-2 border-b border-zinc-800 last:border-b-0">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">{label}</span>
      <div className="flex items-center justify-between gap-2 min-w-0 group">
        <span
          className={`text-sm text-zinc-300 break-all ${mono ? 'font-mono' : ''}`}
          title={value}
        >
          {value}
        </span>
        {value && value !== '—' && (
          <button
            onClick={handleCopy}
            className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            title="Copy to clipboard"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  );
};

const SectionHeader: React.FC<{ icon: React.ReactNode; title: string }> = ({ icon, title }) => (
  <div className="flex items-center gap-2 pt-4 pb-1 mb-1">
    <span className="text-gale-teal">{icon}</span>
    <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{title}</span>
  </div>
);

interface PreviewBlockProps {
  kind: PreviewKind | null;
  loading: boolean;
  error: string | null;
  url: string | null;
  text: string | null;
  truncated: boolean;
  tooLarge: boolean;
  pdfPreviewOpened?: boolean;
  onOpenPdfPreview?: () => void;
}

// Renders the inline preview for a previewable object. Returns null when the
// object type isn't one we preview, so the section simply doesn't appear.
const PreviewBlock: React.FC<PreviewBlockProps> = ({
  kind,
  loading,
  error,
  url,
  text,
  truncated,
  tooLarge,
  pdfPreviewOpened = false,
  onOpenPdfPreview,
}) => {
  if (!kind) return null;

  let body: React.ReactNode;
  if (tooLarge) {
    body = (
      <p className="text-zinc-500 text-sm py-3">
        File is too large to preview here — download it to view.
      </p>
    );
  } else if (loading) {
    body = (
      <div className="flex items-center gap-2 py-4 text-zinc-500 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Loading preview…</span>
      </div>
    );
  } else if (error) {
    body = (
      <div className="flex items-start gap-2 py-3 text-red-400 text-sm">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>{error}</span>
      </div>
    );
  } else if (kind === 'image' && url) {
    body = (
      <img
        src={url}
        alt="Object preview"
        className="max-w-full max-h-72 rounded-lg border border-zinc-800 object-contain bg-zinc-950"
      />
    );
  } else if (kind === 'pdf') {
    body = pdfPreviewOpened ? (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <p className="text-sm text-zinc-300">Opened in Preview</p>
        <p className="text-xs text-zinc-500 mt-1">
          Use Preview&apos;s zoom controls (⌘+ / ⌘−) to adjust the view.
        </p>
        {onOpenPdfPreview && (
          <button
            type="button"
            onClick={onOpenPdfPreview}
            className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open Again
          </button>
        )}
      </div>
    ) : (
      <button
        type="button"
        onClick={onOpenPdfPreview}
        disabled={loading || !onOpenPdfPreview}
        className="w-full flex items-center justify-center gap-2 py-8 rounded-lg border border-zinc-800 bg-zinc-950 text-sm text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 transition-colors disabled:opacity-50"
      >
        {loading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Opening in Preview…</span>
          </>
        ) : (
          <>
            <ExternalLink className="w-4 h-4" />
            <span>Open in Preview</span>
          </>
        )}
      </button>
    );
  } else if (kind === 'text' && text !== null) {
    body = (
      <div>
        <pre className="max-h-72 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300 whitespace-pre-wrap break-words galeon-scrollbar">
          {text}
        </pre>
        {truncated && (
          <p className="text-[10px] uppercase tracking-wider text-zinc-500 mt-1.5">
            Showing first {Math.round(PREVIEW_TEXT_BYTES / 1024)} KB
          </p>
        )}
      </div>
    );
  } else {
    return null;
  }

  return (
    <>
      <SectionHeader icon={<Eye className="w-3.5 h-3.5" />} title="Preview" />
      <div className="py-1">{body}</div>
    </>
  );
};

// ── Main Component ────────────────────────────────────────────────────────────

export const PropertiesInspector: React.FC<PropertiesInspectorProps> = ({
  open,
  onClose,
  sessionId,
  object,
  protocol,
  capabilities,
  mode = 'properties',
}) => {
  const previewOnly = mode === 'preview';
  const [metadata, setMetadata] = useState<ObjectMetadataInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Content-Type edit state (S3 only)
  const [editContentType, setEditContentType] = useState<string>('');
  const [savingContentType, setSavingContentType] = useState(false);
  const [contentTypeSaveError, setContentTypeSaveError] = useState<string | null>(null);
  const [contentTypeSaveSuccess, setContentTypeSaveSuccess] = useState(false);

  // Storage class edit state
  const [editStorageClass, setEditStorageClass] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // "Verify against local file" state
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  // Inline preview state (images/pdf rendered from an object URL, text decoded inline)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewKind, setPreviewKind] = useState<PreviewKind | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [previewTooLarge, setPreviewTooLarge] = useState(false);
  const [pdfPreviewOpened, setPdfPreviewOpened] = useState(false);

  const openPdfPreview = useCallback(async () => {
    if (!object || object.objectType !== 'file') return;
    setPreviewKind('pdf');
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      await invoke('preview_remote_file', {
        sessionId,
        key: object.fullKey,
      });
      setPdfPreviewOpened(true);
    } catch (err: unknown) {
      setPreviewError(typeof err === 'string' ? err : 'Could not open in Preview.');
      setPdfPreviewOpened(false);
    } finally {
      setPreviewLoading(false);
    }
  }, [object, sessionId]);

  // Fetch metadata when drawer opens or object changes
  useEffect(() => {
    if (!open || !object || object.objectType !== 'file') {
      setMetadata(null);
      setFetchError(null);
      setVerifyResult(null);
      setVerifyError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    setMetadata(null);
    setSaveError(null);
    setSaveSuccess(false);
    setContentTypeSaveError(null);
    setContentTypeSaveSuccess(false);
    setVerifyResult(null);
    setVerifyError(null);

    invoke<ObjectMetadataInfo>('get_object_metadata', {
      sessionId,
      key: object.fullKey,
    })
      .then((info) => {
        if (!cancelled) {
          setMetadata(info);
          setEditStorageClass(info.storageClass ?? 'STANDARD');
          const derived = object ? deriveContentType(object.fullKey) : null;
          setEditContentType(info.contentType ?? derived ?? '');
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFetchError(typeof err === 'string' ? err : 'Failed to load metadata.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, object?.fullKey, sessionId]);

  // Resolved content type (metadata first, then extension) and size — shared by
  // the preview effect and the rendered Content rows. Declared here so the
  // preview effect can depend on stable values rather than recomputing them.
  const contentType =
    metadata?.contentType ?? (object ? deriveContentType(object.fullKey) : null);
  const resolvedSize = metadata?.contentLength ?? object?.sizeBytes ?? null;

  // Build an inline preview, but only for common, previewable types — the gate is
  // the resolved content type ("application type"), not the raw file. Native
  // SFTP/FTP expose no content type, so preview is offered for S3 objects only.
  useEffect(() => {
    // Reset on every change and revoke any object URL from the previous object.
    setPreviewKind(null);
    setPreviewText(null);
    setPreviewError(null);
    setPreviewTruncated(false);
    setPreviewTooLarge(false);
    setPdfPreviewOpened(false);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });

    const isS3Session = !protocol || protocol === 's3';
    if (!open || !object || object.objectType !== 'file' || !isS3Session) return;

    const kind = previewKindFor(contentType);
    if (!kind) return;

    // PDFs open in macOS Preview — WKWebView's embedded PDF viewer has broken zoom.
    if (kind === 'pdf') {
      setPreviewKind('pdf');
      if (previewOnly) {
        void openPdfPreview();
      }
      return;
    }

    // Images must fit the cap; text is bounded server-side.
    if (kind === 'image' && resolvedSize !== null && resolvedSize > PREVIEW_BINARY_MAX) {
      setPreviewKind(kind);
      setPreviewTooLarge(true);
      return;
    }

    const maxBytes = kind === 'text' ? PREVIEW_TEXT_BYTES : (resolvedSize ?? PREVIEW_BINARY_MAX);

    let cancelled = false;
    let createdUrl: string | null = null;
    setPreviewKind(kind);
    setPreviewLoading(true);

    invoke<ArrayBuffer>('read_object_preview', {
      sessionId,
      key: object.fullKey,
      maxBytes,
    })
      .then((buf) => {
        if (cancelled) return;
        const bytes = new Uint8Array(buf);
        if (kind === 'text') {
          setPreviewText(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
          setPreviewTruncated(resolvedSize !== null && resolvedSize > bytes.byteLength);
        } else {
          const blob = new Blob([bytes], { type: contentType ?? 'application/octet-stream' });
          createdUrl = URL.createObjectURL(blob);
          setPreviewUrl(createdUrl);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setPreviewError(typeof err === 'string' ? err : 'Could not load preview.');
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [open, object?.fullKey, sessionId, protocol, contentType, resolvedSize, previewOnly, openPdfPreview]);

  const handleSaveContentType = async () => {
    if (!object) return;
    setSavingContentType(true);
    setContentTypeSaveError(null);
    setContentTypeSaveSuccess(false);
    try {
      await invoke('update_object_metadata', {
        sessionId,
        key: object.fullKey,
        contentType: editContentType,
      });
      setContentTypeSaveSuccess(true);
      const updated = await invoke<ObjectMetadataInfo>('get_object_metadata', {
        sessionId,
        key: object.fullKey,
      });
      setMetadata(updated);
      setEditContentType(
        updated.contentType ?? deriveContentType(object.fullKey) ?? editContentType,
      );
    } catch (err: unknown) {
      setContentTypeSaveError(typeof err === 'string' ? err : 'Failed to update content type.');
    } finally {
      setSavingContentType(false);
    }
  };

  const handleSaveStorageClass = async () => {
    if (!object) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      await invoke('update_object_metadata', {
        sessionId,
        key: object.fullKey,
        storageClass: editStorageClass,
      });
      setSaveSuccess(true);
      // Re-fetch metadata after successful save
      const updated = await invoke<ObjectMetadataInfo>('get_object_metadata', {
        sessionId,
        key: object.fullKey,
      });
      setMetadata(updated);
      setEditStorageClass(updated.storageClass ?? editStorageClass);
    } catch (err: unknown) {
      setSaveError(typeof err === 'string' ? err : 'Failed to update storage class.');
    } finally {
      setSaving(false);
    }
  };

  // Verify a user-chosen local file against this remote object (size + S3 checksum).
  const handleVerify = async () => {
    if (!object) return;
    setVerifyError(null);
    setVerifyResult(null);
    let picked: string | null;
    try {
      const sel = await openFileDialog({ multiple: false, directory: false });
      picked = typeof sel === 'string' ? sel : null;
    } catch {
      setVerifyError('Could not open the file picker.');
      return;
    }
    if (!picked) return; // user cancelled
    setVerifying(true);
    try {
      const result = await invoke<VerifyResult>('verify_local_matches_remote', {
        sessionId,
        key: object.fullKey,
        localPath: picked,
      });
      setVerifyResult(result);
    } catch (err: unknown) {
      setVerifyError(typeof err === 'string' ? err : 'Verification failed.');
    } finally {
      setVerifying(false);
    }
  };

  const isS3 = !protocol || protocol === 's3';
  const isFile = object?.objectType === 'file';

  // Build storage class select options: standard classes + current value if unknown
  const storageClassOptions =
    metadata?.storageClass && !S3_STORAGE_CLASSES.includes(metadata.storageClass)
      ? [...S3_STORAGE_CLASSES, metadata.storageClass]
      : S3_STORAGE_CLASSES;

  return (
    <>
      {/* Dim backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black/30 z-40"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Sliding drawer */}
      <div
        className={`fixed top-0 right-0 h-full w-96 z-40 flex flex-col bg-zinc-900 border-l border-zinc-800 shadow-2xl transition-transform duration-200 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {object?.objectType === 'folder' ? (
              <Folder className="w-4 h-4 text-gale-teal shrink-0" />
            ) : (
              <FileText className="w-4 h-4 text-gale-teal shrink-0" />
            )}
            <h2 className="text-sm font-semibold text-zinc-200 truncate" title={object?.name ?? ''}>
              {object?.name ?? (previewOnly ? 'Preview' : 'Properties')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-200 transition-colors p-1 rounded hover:bg-zinc-800 shrink-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 pb-6 galeon-scrollbar">
          {object === null ? (
            <p className="text-zinc-500 text-sm mt-6 text-center">No item selected.</p>
          ) : previewOnly ? (
            <>
              {isFile ? (
                previewKind || previewLoading || previewError ? (
                  <PreviewBlock
                    kind={previewKind}
                    loading={previewLoading}
                    error={previewError}
                    url={previewUrl}
                    text={previewText}
                    truncated={previewTruncated}
                    tooLarge={previewTooLarge}
                    pdfPreviewOpened={pdfPreviewOpened}
                    onOpenPdfPreview={() => void openPdfPreview()}
                  />
                ) : (
                  <p className="text-zinc-500 text-sm mt-6 text-center">
                    This file type cannot be previewed.
                  </p>
                )
              ) : (
                <p className="text-zinc-500 text-sm mt-6 text-center">Folders cannot be previewed.</p>
              )}
            </>
          ) : (
            <>
              {/* General section */}
              <SectionHeader icon={<HardDrive className="w-3.5 h-3.5" />} title="General" />
              <div>
                <Row label="Name" value={object.name} />
                <Row label={isFile ? 'Key' : 'Prefix'} value={object.fullKey} mono />
                <Row label="Type" value={object.objectType === 'folder' ? 'Folder' : 'File'} />
                {isFile && (
                  <Row
                    label="Size"
                    value={formatBytes(metadata?.contentLength ?? object.sizeBytes)}
                  />
                )}
                <Row
                  label="Last Modified"
                  value={formatDate(metadata?.lastModified ?? object.lastModified)}
                />
              </div>

              {/* Inline preview (files only; renders nothing for non-previewable types) */}
              {isFile && (
                <PreviewBlock
                  kind={previewKind}
                  loading={previewLoading}
                  error={previewError}
                  url={previewUrl}
                  text={previewText}
                  truncated={previewTruncated}
                  tooLarge={previewTooLarge}
                  pdfPreviewOpened={pdfPreviewOpened}
                  onOpenPdfPreview={() => void openPdfPreview()}
                />
              )}

              {/* MIME / Content section (files only) */}
              {isFile && (
                <>
                  <SectionHeader icon={<Tag className="w-3.5 h-3.5" />} title="Content" />
                  {loading ? (
                    <div className="flex items-center gap-2 py-4 text-zinc-500 text-sm">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Loading metadata…</span>
                    </div>
                  ) : fetchError ? (
                    <div className="flex items-start gap-2 py-3 text-red-400 text-sm">
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                      <span>{fetchError}</span>
                    </div>
                  ) : (
                    <div>
                      {isS3 ? (
                        <div className="py-2 border-b border-zinc-800">
                          <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">
                            Content Type
                          </span>
                          <div className="flex items-center gap-2 mt-1.5">
                            <input
                              type="text"
                              value={editContentType}
                              onChange={(e) => {
                                setEditContentType(e.target.value);
                                setContentTypeSaveSuccess(false);
                                setContentTypeSaveError(null);
                              }}
                              placeholder="e.g. image/png"
                              className="flex-1 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-200 px-3 py-1.5 font-mono focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal transition-all"
                            />
                            <button
                              onClick={handleSaveContentType}
                              disabled={savingContentType || !editContentType.trim()}
                              className="flex items-center gap-1.5 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white disabled:opacity-50 disabled:cursor-not-allowed text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                            >
                              {savingContentType ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Save className="w-3 h-3" />
                              )}
                              <span>Save</span>
                            </button>
                          </div>
                          {contentTypeSaveSuccess && (
                            <p className="text-green-400 text-xs mt-1.5">Content type updated.</p>
                          )}
                          {contentTypeSaveError && (
                            <p className="text-red-400 text-xs mt-1.5">{contentTypeSaveError}</p>
                          )}
                        </div>
                      ) : (
                        contentType && <Row label="Content Type" value={contentType} />
                      )}
                      {metadata?.contentEncoding && (
                        <Row label="Content Encoding" value={metadata.contentEncoding} />
                      )}
                      {metadata?.cacheControl && (
                        <Row label="Cache-Control" value={metadata.cacheControl} />
                      )}
                      {metadata?.contentDisposition && (
                        <Row label="Content-Disposition" value={metadata.contentDisposition} />
                      )}
                      {metadata?.etag && (
                        <Row label="ETag" value={metadata.etag} mono />
                      )}
                      {!metadata && !loading && !fetchError && (
                        <p className="text-zinc-500 text-sm py-2">No content metadata available.</p>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Integrity verification (files only, all protocols) */}
              {isFile && (
                <>
                  <SectionHeader icon={<ShieldCheck className="w-3.5 h-3.5" />} title="Verify" />
                  <div className="py-1">
                    <p className="text-xs text-zinc-500 mb-2">
                      Compare a local file against this object by size{isS3 ? ' and checksum' : ''}.
                    </p>
                    <button
                      onClick={handleVerify}
                      disabled={verifying}
                      className="flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-200 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                    >
                      {verifying ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <ShieldCheck className="w-3 h-3" />
                      )}
                      <span>{verifying ? 'Verifying…' : 'Verify against local file…'}</span>
                    </button>
                    {verifyError && (
                      <div className="flex items-start gap-2 mt-2 text-red-400 text-xs">
                        <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span>{verifyError}</span>
                      </div>
                    )}
                    {verifyResult && (
                      <div
                        className={`flex items-start gap-2 mt-2 text-xs ${
                          verifyResult.matches ? 'text-emerald-400' : 'text-amber-400'
                        }`}
                      >
                        {verifyResult.matches ? (
                          <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        ) : (
                          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        )}
                        <span>
                          {verifyResult.matches ? 'Match — ' : 'Mismatch — '}
                          {verifyResult.detail}
                        </span>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* S3 Specifics section */}
              {isFile && isS3 && metadata && (
                <>
                  <SectionHeader icon={<Database className="w-3.5 h-3.5" />} title="S3 Specifics" />
                  <div>
                    {/* Storage Class */}
                    {capabilities?.supportsStorageClass ? (
                      <div className="py-2 border-b border-zinc-800">
                        <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">
                          Storage Class
                        </span>
                        <div className="flex items-center gap-2 mt-1.5">
                          <select
                            value={editStorageClass}
                            onChange={(e) => {
                              setEditStorageClass(e.target.value);
                              setSaveSuccess(false);
                              setSaveError(null);
                            }}
                            className="flex-1 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-200 px-3 py-1.5 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal transition-all"
                          >
                            {storageClassOptions.map((cls) => (
                              <option key={cls} value={cls}>
                                {cls}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={handleSaveStorageClass}
                            disabled={saving}
                            className="flex items-center gap-1.5 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white disabled:opacity-50 disabled:cursor-not-allowed text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                          >
                            {saving ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Save className="w-3 h-3" />
                            )}
                            <span>Save</span>
                          </button>
                        </div>
                        {saveSuccess && (
                          <p className="text-green-400 text-xs mt-1.5">Storage class updated.</p>
                        )}
                        {saveError && (
                          <p className="text-red-400 text-xs mt-1.5">{saveError}</p>
                        )}
                      </div>
                    ) : (
                      metadata.storageClass && (
                        <Row label="Storage Class" value={metadata.storageClass} />
                      )
                    )}

                    {/* User Metadata */}
                    {metadata.userMetadata &&
                      Object.keys(metadata.userMetadata).length > 0 && (
                        <div className="py-2">
                          <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">
                            User Metadata
                          </span>
                          <div className="mt-2 rounded-lg border border-zinc-800 overflow-hidden">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="bg-zinc-800/60">
                                  <th className="text-left text-zinc-500 font-medium px-3 py-1.5 w-1/2">
                                    Key
                                  </th>
                                  <th className="text-left text-zinc-500 font-medium px-3 py-1.5 w-1/2">
                                    Value
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {Object.entries(metadata.userMetadata).map(([k, v]) => (
                                  <tr
                                    key={k}
                                    className="border-t border-zinc-800 hover:bg-zinc-800/30 transition-colors"
                                  >
                                    <td
                                      className="px-3 py-1.5 font-mono text-gale-teal truncate max-w-0"
                                      title={k}
                                    >
                                      {k}
                                    </td>
                                    <td
                                      className="px-3 py-1.5 text-zinc-300 truncate max-w-0"
                                      title={v}
                                    >
                                      {v}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                  </div>
                </>
              )}

              {/* Folder note */}
              {!isFile && (
                <>
                  <SectionHeader icon={<Clock className="w-3.5 h-3.5" />} title="Info" />
                  <p className="text-zinc-500 text-sm py-1">
                    Folders are virtual prefixes — no metadata is stored for them.
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
};
