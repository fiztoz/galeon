import { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';

/**
 * The app's dialog vocabulary.
 *
 * Explorer grew eight dialogs that each re-declared the same overlay, card,
 * title, field and footer chrome — Create/Rename were the same shape, Move/Copy
 * were the same shape, Delete/BatchDelete were the same shape. This file keeps
 * one copy of each shape so the dialogs read as intent, not markup.
 *
 * Rule of thumb: transient input a dialog owns (prompt text, destination, a
 * generated URL) lives *in the dialog* and is handed to the caller on confirm.
 * State the caller needs to act on (which object is being renamed) stays in the
 * caller and is passed down.
 */

const card = (width: string) =>
  `bg-zinc-900 border border-zinc-800 rounded-xl p-6 ${width} shadow-2xl`;

const field =
  'w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal transition-all';

const fieldLabel = 'block text-sm text-zinc-400 mb-2';
const eyebrowLabel = 'block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2';

const cancelBtn = 'px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200';
const primaryBtn =
  'px-4 py-2 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white rounded-lg text-sm font-medium transition-colors';
const dangerBtn = 'px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg text-sm font-medium';
/** Full-width primary action (the Share dialog's Generate Link). No `px-*`: it spans the card. */
const widePrimaryBtn =
  'w-full py-2 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white rounded-lg text-sm font-medium transition-colors mb-4';

export interface DialogProps {
  title: React.ReactNode;
  /** Tailwind width for the card. Default `w-96`. */
  width?: string;
  /** Title bottom margin. Dialogs that lead with a paragraph use `mb-2`. */
  titleClassName?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** Footer row classes. Single-button footers drop the inter-button gap. */
  footerClassName?: string;
}

/** Overlay + card + heading + footer. Everything below is built from this. */
export const Dialog: React.FC<DialogProps> = ({
  title,
  width = 'w-96',
  titleClassName = 'mb-4',
  children,
  footer,
  footerClassName = 'flex justify-end space-x-2',
}) => (
  <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
    <div className={card(width)}>
      <h3 className={`text-lg font-semibold ${titleClassName}`}>{title}</h3>
      {children}
      {footer && <div className={footerClassName}>{footer}</div>}
    </div>
  </div>
);

export interface ConfirmDialogProps {
  title: React.ReactNode;
  width?: string;
  titleClassName?: string;
  /** Body copy between the heading and the buttons. */
  children?: React.ReactNode;
  cancelLabel?: string;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  onCancel: () => void;
  onConfirm: () => void;
}

/** Heading + explanatory body + Cancel/Confirm. Delete confirmations use `danger`. */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  title,
  width,
  titleClassName,
  children,
  cancelLabel = 'Cancel',
  confirmLabel,
  tone = 'primary',
  onCancel,
  onConfirm,
}) => (
  <Dialog
    title={title}
    width={width}
    titleClassName={titleClassName}
    footer={
      <>
        <button onClick={onCancel} className={cancelBtn}>{cancelLabel}</button>
        <button onClick={onConfirm} className={tone === 'danger' ? dangerBtn : primaryBtn}>
          {confirmLabel}
        </button>
      </>
    }
  >
    {children}
  </Dialog>
);

export interface TextPromptDialogProps {
  title: string;
  placeholder: string;
  confirmLabel: string;
  /** Rename prefills with the current name; Create Folder starts empty. */
  initialValue?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

/** Single text field, Enter submits. Owns the field's text. */
export const TextPromptDialog: React.FC<TextPromptDialogProps> = ({
  title,
  placeholder,
  confirmLabel,
  initialValue = '',
  onConfirm,
  onCancel,
}) => {
  const [value, setValue] = useState(initialValue);

  return (
    <Dialog
      title={title}
      footer={
        <>
          <button onClick={onCancel} className={cancelBtn}>Cancel</button>
          <button onClick={() => onConfirm(value)} className={primaryBtn}>{confirmLabel}</button>
        </>
      }
    >
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onConfirm(value)}
        placeholder={placeholder}
        className={`${field} mb-4`}
        autoFocus
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
      />
    </Dialog>
  );
};

export interface DestinationDialogProps {
  title: React.ReactNode;
  /** Folder keys to offer, as returned by the bucket listing. */
  folders: string[];
  confirmLabel: string;
  onConfirm: (destination: string) => void;
  onCancel: () => void;
}

/** "Move/Copy X to…" — a folder picker over the bucket's directories. Owns the choice. */
export const DestinationDialog: React.FC<DestinationDialogProps> = ({
  title,
  folders,
  confirmLabel,
  onConfirm,
  onCancel,
}) => {
  const [destination, setDestination] = useState('/');

  return (
    <Dialog
      title={title}
      footer={
        <>
          <button onClick={onCancel} className={cancelBtn}>Cancel</button>
          <button onClick={() => onConfirm(destination)} className={primaryBtn}>{confirmLabel}</button>
        </>
      }
    >
      <div className="mb-4">
        <label className={fieldLabel}>Select destination folder:</label>
        <select
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          className={field}
        >
          <option value="/">Root (/)</option>
          {folders.map((folder) => (
            <option key={folder} value={folder}>{folder}</option>
          ))}
        </select>
      </div>
    </Dialog>
  );
};

const EXPIRY_OPTIONS: ReadonlyArray<readonly [number, string]> = [
  [3600, '1 Hour'],
  [43200, '12 Hours'],
  [86400, '1 Day'],
  [604800, '7 Days'],
];

export interface ShareLinkDialogProps {
  fileName: string;
  /** Generates the presigned URL; throws if the session or the key is bad. */
  onGenerate: (expiresInSeconds: number) => Promise<string>;
  onError: (message: string) => void;
  onClose: () => void;
}

/**
 * Presigned-link generator. Owns the expiry choice, the generated URL and the
 * "copied" flash — none of which the caller has any use for once it closes.
 */
export const ShareLinkDialog: React.FC<ShareLinkDialogProps> = ({
  fileName,
  onGenerate,
  onError,
  onClose,
}) => {
  const [expiration, setExpiration] = useState(3600);
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    try {
      setUrl(await onGenerate(expiration));
    } catch (err: any) {
      onError(String(err));
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const open = async () => {
    try {
      await openUrl(url);
    } catch (err: any) {
      onError(String(err));
    }
  };

  return (
    <Dialog
      title="Share Link"
      footerClassName="flex justify-end"
      footer={<button onClick={onClose} className={cancelBtn}>Close</button>}
    >
      <p className="text-sm text-zinc-400 mb-4">
        Generate a temporary link for <span className="text-zinc-200 font-medium">"{fileName}"</span>
      </p>

      <div className="mb-4">
        <label className={eyebrowLabel}>Link Expiration</label>
        <select
          value={expiration}
          onChange={(e) => setExpiration(Number(e.target.value))}
          className={field}
        >
          {EXPIRY_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      {!url ? (
        <button onClick={generate} className={widePrimaryBtn}>
          Generate Link
        </button>
      ) : (
        <div className="mb-4">
          <label className={eyebrowLabel}>Generated URL</label>
          <div className="flex space-x-2">
            <input
              type="text"
              value={url}
              readOnly
              className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-300 focus:outline-none"
            />
            <button
              onClick={copy}
              className="px-3 py-2 bg-raised hover:bg-raised-hover rounded-lg text-sm"
              title="Copy link"
            >
              {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            </button>
            <button
              onClick={open}
              className="px-3 py-2 bg-raised hover:bg-raised-hover rounded-lg text-sm"
              title="Open in browser"
            >
              <ExternalLink className="w-4 h-4" />
            </button>
          </div>
          {copied && <p className="text-xs text-green-400 mt-1">Copied to clipboard!</p>}
        </div>
      )}
    </Dialog>
  );
};

export interface ConflictDialogProps {
  fileName: string;
  /** How many conflicts are still queued, including this one. */
  pendingCount: number;
  applyToAll: boolean;
  onApplyToAllChange: (value: boolean) => void;
  onResolve: (action: 'overwrite' | 'skip' | 'rename') => void;
}

/** Upload collision: skip, rename, or overwrite — optionally for the whole queue. */
export const ConflictDialog: React.FC<ConflictDialogProps> = ({
  fileName,
  pendingCount,
  applyToAll,
  onApplyToAllChange,
  onResolve,
}) => (
  <Dialog
    title="File Already Exists"
    titleClassName="mb-2"
    width="w-[420px]"
    footer={
      <>
        <button
          onClick={() => onResolve('skip')}
          className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg"
        >
          Skip
        </button>
        <button
          onClick={() => onResolve('rename')}
          className="px-4 py-2 text-sm text-zinc-300 bg-raised hover:bg-raised-hover rounded-lg"
        >
          Rename
        </button>
        <button
          onClick={() => onResolve('overwrite')}
          className="px-4 py-2 bg-amber-600 hover:bg-amber-500 rounded-lg text-sm font-medium"
        >
          Overwrite
        </button>
      </>
    }
  >
    <p className="text-zinc-400 text-sm mb-4">
      <span className="text-zinc-200 font-medium">{fileName}</span> already exists at the destination.
    </p>
    <div className="mb-4">
      <label className="flex items-center space-x-2 text-sm text-zinc-400 cursor-pointer hover:text-zinc-200">
        <input
          type="checkbox"
          checked={applyToAll}
          onChange={(e) => onApplyToAllChange(e.target.checked)}
          className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-gale-teal focus:ring-gale-teal focus:ring-1 accent-gale-teal"
        />
        <span>Apply to all ({pendingCount} files)</span>
      </label>
    </div>
  </Dialog>
);
