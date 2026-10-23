/**
 * Inline preview for one object.
 *
 * Owns the eight pieces of preview state and the load effect that fills them:
 * images and PDFs render from an object URL, text from the first slice of the
 * object. The decision of *what* is previewable lives in `previewModel`; this
 * only fetches, decodes, and revokes.
 */

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GaleonObject, StorageProtocol } from '../types';
import {
  PREVIEW_BINARY_MAX,
  PREVIEW_TEXT_BYTES,
  previewKindFor,
  type PreviewKind,
} from '../components/preview/previewModel';

export type ObjectPreviewOptions = {
  open: boolean;
  object: GaleonObject | null;
  sessionId: string;
  protocol?: StorageProtocol;
  /** The drawer is showing the file itself, so a PDF opens right away. */
  previewOnly: boolean;
  /** Resolved content type: metadata first, extension second. */
  contentType: string | null;
  resolvedSize: number | null;
};

export function useObjectPreview({
  open,
  object,
  sessionId,
  protocol,
  previewOnly,
  contentType,
  resolvedSize,
}: ObjectPreviewOptions) {
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

  // Build an inline preview, but only for common, previewable types — the gate is
  // the resolved content type, not the raw file. Native SFTP/FTP expose no content
  // type, so preview is offered for S3 objects only.
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

  return {
    previewUrl,
    previewText,
    previewKind,
    previewLoading,
    previewError,
    previewTruncated,
    previewTooLarge,
    pdfPreviewOpened,
    openPdfPreview,
  };
}
