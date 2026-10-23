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
  | { type: 'rename'; index: number }
  | { type: 'delete'; index: number }
  | { type: 'selectAll' }
  | { type: 'clear' }
  | { type: 'typeAhead'; char: string };

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

/** Rows a PageUp / PageDown moves when the pane cannot measure its viewport. */
export const DEFAULT_PAGE_SIZE = 10;

/** A pause longer than this starts a new type-ahead search. */
export const TYPE_AHEAD_TIMEOUT_MS = 700;

export function fileListKeyAction(
  event: FileListKeyEvent,
  state: { count: number; cursor: number | null; pageSize?: number },
  typing: boolean,
): ListKeyAction {
  if (typing || event.defaultPrevented) return { type: 'none' };

  const { count, cursor } = state;
  // An empty list has nothing to move to, select, or clear.
  if (count === 0) return { type: 'none' };

  const extend = event.shiftKey;
  const page = Math.max(1, Math.floor(state.pageSize ?? DEFAULT_PAGE_SIZE));

  switch (event.key) {
    case 'ArrowDown':
      return { type: 'move', index: cursor === null ? 0 : Math.min(cursor + 1, count - 1), extend };
    case 'ArrowUp':
      return { type: 'move', index: cursor === null ? count - 1 : Math.max(cursor - 1, 0), extend };
    case 'Home':
      return { type: 'move', index: 0, extend };
    case 'End':
      return { type: 'move', index: count - 1, extend };
    case 'PageDown':
      return {
        type: 'move',
        index: cursor === null ? Math.min(page - 1, count - 1) : Math.min(cursor + page, count - 1),
        extend,
      };
    case 'PageUp':
      return {
        type: 'move',
        index: cursor === null ? Math.max(count - page, 0) : Math.max(cursor - page, 0),
        extend,
      };
    case 'Enter':
      return cursor === null ? { type: 'none' } : { type: 'open', index: cursor };
    case 'F2':
      return cursor === null ? { type: 'none' } : { type: 'rename', index: cursor };
    case 'Backspace':
      // Only the modified key is ours: a bare Backspace belongs to the
      // webview, and in a text field it deletes a word.
      if (!(event.metaKey || event.ctrlKey)) break;
      return cursor === null ? { type: 'none' } : { type: 'delete', index: cursor };
    case 'Delete':
      // The forward-delete key is how Windows and Linux file managers delete,
      // and Fn+Backspace sends it on a Mac. It never edits text here: typing
      // targets were already excluded above.
      return cursor === null ? { type: 'none' } : { type: 'delete', index: cursor };
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

  // A printable character with no command modifier is type-ahead: it jumps to
  // the row whose name starts with what was typed. Shift is allowed — it only
  // changes the case, and matching ignores case anyway.
  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
    return { type: 'typeAhead', char: event.key };
  }

  return { type: 'none' };
}

/** What the user has typed so far, and when they last typed. */
export type TypeAheadState = { query: string; at: number };

export function initialTypeAhead(): TypeAheadState {
  return { query: '', at: 0 };
}

/**
 * Add one character to the type-ahead query.
 *
 * A pause longer than `timeoutMs` starts a fresh query, so typing `re` after a
 * break searches for `re`, not for whatever was typed a minute ago.
 */
export function appendTypeAhead(
  state: TypeAheadState,
  char: string,
  now: number,
  timeoutMs: number = TYPE_AHEAD_TIMEOUT_MS,
): TypeAheadState {
  const fresh = state.query === '' || now - state.at > timeoutMs;
  return { query: (fresh ? '' : state.query) + char, at: now };
}

/**
 * The row a type-ahead query lands on, or null when no name matches.
 *
 * Matching is a case-insensitive prefix. A one-letter query — or the same
 * letter pressed again and again (`ddd`) — steps to the *next* match after the
 * cursor, so repeated presses cycle through every name starting with that
 * letter. A longer query refines in place: it keeps the cursor row while that
 * row still matches. The search wraps past the end of the list.
 */
export function typeAheadMatch(
  names: readonly string[],
  query: string,
  cursor: number | null,
): number | null {
  if (names.length === 0 || query === '') return null;
  const lower = query.toLocaleLowerCase();
  const repeated = [...lower].every((c) => c === lower[0]);
  const needle = repeated ? lower[0] : lower;
  const start = cursor === null ? 0 : repeated ? cursor + 1 : cursor;
  for (let step = 0; step < names.length; step += 1) {
    const index = (start + step) % names.length;
    if (names[index].toLocaleLowerCase().startsWith(needle)) return index;
  }
  return null;
}

/**
 * How many rows fit in a scrolling list, for PageUp / PageDown.
 *
 * One row less than the viewport holds, so the row the cursor leaves stays in
 * sight — the way a desktop list pages. Falls back to `DEFAULT_PAGE_SIZE`
 * before the list has been laid out.
 */
export function pageSizeFor(viewportHeight: number, rowHeight: number): number {
  if (!(viewportHeight > 0) || !(rowHeight > 0)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.floor(viewportHeight / rowHeight) - 1);
}

/** Measure the page size of a scroll container whose rows carry `data-row-index`. */
export function measurePageSize(scroller: Element | null | undefined): number {
  if (!scroller) return DEFAULT_PAGE_SIZE;
  const row = scroller.querySelector('[data-row-index]') as HTMLElement | null;
  return pageSizeFor(scroller.clientHeight, row?.offsetHeight ?? 0);
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
  /** The row should be renamed (F2). Omitted where renaming is not possible. */
  onRename?: (index: number) => void;
  /** The row should be deleted (Delete, or Cmd/Ctrl+Backspace). */
  onDelete?: (index: number) => void;
  /** Every row should be selected (Cmd/Ctrl+A). */
  onSelectAll: () => void;
  /** The selection should be cleared (Escape). */
  onClear: () => void;
  /** Bring a row into view — windowed lists need it, plain ones do not. */
  onScrollTo?: (index: number) => void;
  /** Rows per PageUp / PageDown, read when the key is pressed. */
  pageSize?: () => number;
  /**
   * Type-ahead: the row names in list order, and where the pane keeps the
   * query between key presses (a `useRef` in a component). Omitted, letters do
   * nothing.
   */
  typeAhead?: { names: readonly string[]; state: { current: TypeAheadState } };
  /** Clock for type-ahead pauses; tests pass a fake one. */
  now?: () => number;
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
      { count: options.count, cursor: options.cursor, pageSize: options.pageSize?.() },
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
      case 'rename':
        // A pane that cannot rename simply does not bind the key.
        if (!options.onRename) return;
        event.preventDefault();
        options.onRename(action.index);
        return;
      case 'delete':
        if (!options.onDelete) return;
        event.preventDefault();
        options.onDelete(action.index);
        return;
      case 'clear':
        event.preventDefault();
        options.onClear();
        return;
      case 'typeAhead': {
        const typeAhead = options.typeAhead;
        if (!typeAhead) return;
        const now = (options.now ?? Date.now)();
        const ref = typeAhead.state;
        // A space only belongs to the query once a name is being typed; on
        // its own it stays with the focused control (a checkbox toggles).
        const fresh = ref.current.query === '' || now - ref.current.at > TYPE_AHEAD_TIMEOUT_MS;
        if (action.char === ' ' && fresh) return;
        ref.current = appendTypeAhead(ref.current, action.char, now);
        event.preventDefault();
        const index = typeAheadMatch(typeAhead.names, ref.current.query, options.cursor);
        if (index === null) return;
        options.onMove(index, false);
        options.onScrollTo?.(index);
        return;
      }
    }
  };
}
