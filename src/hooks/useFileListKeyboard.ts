/**
 * Keyboard model for a file list.
 *
 * A desktop file list is arrow-navigable and its selection is instant: a plain
 * click replaces, Cmd/Ctrl-click toggles, Shift extends. The rules live here as
 * one pure function so both panes behave identically and can be tested without
 * a DOM.
 */

export type ListKeyAction =
  | { type: 'none' }
  | { type: 'move'; index: number; extend: boolean }
  | { type: 'open'; index: number }
  | { type: 'selectAll' }
  | { type: 'clear' };

export type FileListKeyEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented?: boolean;
};

/** The event shape a pane's key handler receives. */
export type FileListKeyHandlerEvent = FileListKeyEvent & {
  target: EventTarget | null;
  preventDefault: () => void;
};

/**
 * Input types that do not consume the keyboard.
 *
 * A checkbox takes Space, not arrows — so it must not swallow the arrow keys
 * that walk the rows. Text-like inputs (including `number` and `date`, which
 * react to arrows) do consume them.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'image',
  'file',
  'color',
]);

/**
 * True when the key event came from somewhere the user is typing text.
 *
 * The search box and the inline editor both live inside the pane, so the pane
 * must not steal their arrow keys. A focused button or checkbox is *not* a
 * typing target — arrow keys must still walk the rows.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type?.toLowerCase() ?? 'text';
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  if (tag === 'textarea' || tag === 'select') return true;
  return el.getAttribute?.('contenteditable') === 'true';
}

/**
 * True when the element is a control the user clicks on directly.
 *
 * A click on one of these is that control's business, not the row's.
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || tag === 'a') {
    return true;
  }
  return el.getAttribute?.('contenteditable') === 'true';
}

export function fileListKeyAction(
  event: FileListKeyEvent,
  state: { count: number; cursor: number | null },
  typing: boolean,
): ListKeyAction {
  if (typing || event.defaultPrevented) return { type: 'none' };

  const { count, cursor } = state;
  // An empty list has nothing to move to, select, or clear.
  if (count === 0) return { type: 'none' };

  const extend = event.shiftKey;

  switch (event.key) {
    case 'ArrowDown':
      return { type: 'move', index: cursor === null ? 0 : Math.min(cursor + 1, count - 1), extend };
    case 'ArrowUp':
      return { type: 'move', index: cursor === null ? count - 1 : Math.max(cursor - 1, 0), extend };
    case 'Home':
      return { type: 'move', index: 0, extend };
    case 'End':
      return { type: 'move', index: count - 1, extend };
    case 'Enter':
      return cursor === null ? { type: 'none' } : { type: 'open', index: cursor };
    case 'Escape':
      return { type: 'clear' };
    default:
      break;
  }

  // Cmd/Ctrl+A selects every row. Alt+A is left alone so the key can still
  // reach menu mnemonics and other app shortcuts.
  if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'a' || event.key === 'A')) {
    return { type: 'selectAll' };
  }

  return { type: 'none' };
}

export type FileListKeyboardOptions = {
  /** How many rows the list holds. */
  count: number;
  /** The row the keyboard cursor sits on, or null when there is none. */
  cursor: number | null;
  /** The cursor should move to this row. `extend` means the shift range. */
  onMove: (index: number, extend: boolean) => void;
  /** The row should be opened (Enter). */
  onOpen: (index: number) => void;
  /** Every row should be selected (Cmd/Ctrl+A). */
  onSelectAll: () => void;
  /** The selection should be cleared (Escape). */
  onClear: () => void;
  /** Bring a row into view — windowed lists need it, plain ones do not. */
  onScrollTo?: (index: number) => void;
};

/**
 * Build the key handler for a file list.
 *
 * One place decides what a key does, so the remote and local panes cannot
 * drift apart. The pure rules live in `fileListKeyAction`; this only wires
 * them to the pane's callbacks.
 */
export function useFileListKeyboardNav(options: FileListKeyboardOptions) {
  return (event: FileListKeyHandlerEvent) => {
    const action = fileListKeyAction(
      event,
      { count: options.count, cursor: options.cursor },
      isTypingTarget(event.target),
    );

    switch (action.type) {
      case 'none':
        return;
      case 'move':
        event.preventDefault();
        options.onMove(action.index, action.extend);
        options.onScrollTo?.(action.index);
        return;
      case 'open':
        // Enter on a control belongs to that control — a row only opens when
        // the list itself has the focus.
        if (isInteractiveTarget(event.target)) return;
        event.preventDefault();
        options.onOpen(action.index);
        options.onScrollTo?.(action.index);
        return;
      case 'selectAll':
        event.preventDefault();
        options.onSelectAll();
        return;
      case 'clear':
        event.preventDefault();
        options.onClear();
        return;
    }
  };
}
