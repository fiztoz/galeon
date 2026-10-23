import { test, expect } from 'bun:test';
import {
  DEFAULT_PAGE_SIZE,
  fileListKeyAction,
  isInteractiveTarget,
  isTypingTarget,
  useFileListKeyboardNav,
} from '../../src/hooks/useFileListKeyboard';

const key = (
  k: string,
  modifiers: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    defaultPrevented: boolean;
  }> = {},
) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  ...modifiers,
});

const state = (count: number, cursor: number | null = null) => ({ count, cursor });

test('typing ignores arrow keys', () => {
  expect(fileListKeyAction(key('ArrowDown'), state(3), true)).toEqual({ type: 'none' });
  expect(fileListKeyAction(key('ArrowUp'), state(3), true)).toEqual({ type: 'none' });
});

test('an already-handled event is ignored', () => {
  expect(fileListKeyAction(key('ArrowDown', { defaultPrevented: true }), state(3, 0), false)).toEqual({
    type: 'none',
  });
});

test('an empty list has nothing to do', () => {
  expect(fileListKeyAction(key('ArrowDown'), state(0), false)).toEqual({ type: 'none' });
  expect(fileListKeyAction(key('Escape'), state(0), false)).toEqual({ type: 'none' });
  expect(fileListKeyAction(key('a', { metaKey: true }), state(0), false)).toEqual({ type: 'none' });
  expect(fileListKeyAction(key('Enter'), state(0), false)).toEqual({ type: 'none' });
});

test('the first arrow from no cursor lands on an edge', () => {
  expect(fileListKeyAction(key('ArrowDown'), state(3), false)).toEqual({
    type: 'move',
    index: 0,
    extend: false,
  });
  expect(fileListKeyAction(key('ArrowUp'), state(3), false)).toEqual({
    type: 'move',
    index: 2,
    extend: false,
  });
});

test('arrows move one row and clamp at both ends', () => {
  expect(fileListKeyAction(key('ArrowDown'), state(3, 0), false)).toEqual({
    type: 'move',
    index: 1,
    extend: false,
  });
  expect(fileListKeyAction(key('ArrowDown'), state(3, 2), false)).toEqual({
    type: 'move',
    index: 2,
    extend: false,
  });
  expect(fileListKeyAction(key('ArrowUp'), state(3, 2), false)).toEqual({
    type: 'move',
    index: 1,
    extend: false,
  });
  expect(fileListKeyAction(key('ArrowUp'), state(3, 0), false)).toEqual({
    type: 'move',
    index: 0,
    extend: false,
  });
});

test('shift with an arrow extends the selection', () => {
  expect(fileListKeyAction(key('ArrowDown', { shiftKey: true }), state(3, 0), false)).toEqual({
    type: 'move',
    index: 1,
    extend: true,
  });
  expect(fileListKeyAction(key('Home', { shiftKey: true }), state(3, 2), false)).toEqual({
    type: 'move',
    index: 0,
    extend: true,
  });
});

test('Home and End jump to the ends', () => {
  expect(fileListKeyAction(key('Home'), state(3, 1), false)).toEqual({
    type: 'move',
    index: 0,
    extend: false,
  });
  expect(fileListKeyAction(key('End'), state(3, 1), false)).toEqual({
    type: 'move',
    index: 2,
    extend: false,
  });
});

test('Enter opens the row under the cursor', () => {
  expect(fileListKeyAction(key('Enter'), state(3, 1), false)).toEqual({ type: 'open', index: 1 });
  expect(fileListKeyAction(key('Enter'), state(3, null), false)).toEqual({ type: 'none' });
});

test('Cmd or Ctrl+A selects every row', () => {
  expect(fileListKeyAction(key('a', { metaKey: true }), state(3), false)).toEqual({ type: 'selectAll' });
  expect(fileListKeyAction(key('A', { ctrlKey: true }), state(3), false)).toEqual({ type: 'selectAll' });
});

test('Alt+A is not a select-all', () => {
  expect(fileListKeyAction(key('a', { metaKey: true, altKey: true }), state(3), false)).toEqual({
    type: 'none',
  });
  expect(fileListKeyAction(key('a', { ctrlKey: true, altKey: true }), state(3), false)).toEqual({
    type: 'none',
  });
});

test('Escape clears the selection', () => {
  expect(fileListKeyAction(key('Escape'), state(3, 1), false)).toEqual({ type: 'clear' });
});

test('F2 renames the row under the cursor', () => {
  expect(fileListKeyAction(key('F2'), state(3, 1), false)).toEqual({ type: 'rename', index: 1 });
  expect(fileListKeyAction(key('F2'), state(3, null), false)).toEqual({ type: 'none' });
});

test('Cmd or Ctrl+Backspace deletes the row under the cursor', () => {
  expect(fileListKeyAction(key('Backspace', { metaKey: true }), state(3, 2), false)).toEqual({
    type: 'delete',
    index: 2,
  });
  expect(fileListKeyAction(key('Backspace', { ctrlKey: true }), state(3, 2), false)).toEqual({
    type: 'delete',
    index: 2,
  });
  // A bare Backspace belongs to the webview, not to the file list.
  expect(fileListKeyAction(key('Backspace'), state(3, 2), false)).toEqual({ type: 'none' });
  expect(fileListKeyAction(key('Backspace', { metaKey: true }), state(3, null), false)).toEqual({
    type: 'none',
  });
});

test('the Delete key deletes the row under the cursor', () => {
  expect(fileListKeyAction(key('Delete'), state(3, 1), false)).toEqual({ type: 'delete', index: 1 });
  expect(fileListKeyAction(key('Delete'), state(3, null), false)).toEqual({ type: 'none' });
  // In a text field Delete edits the text.
  expect(fileListKeyAction(key('Delete'), state(3, 1), true)).toEqual({ type: 'none' });
});

test('PageUp and PageDown move a page and clamp at both ends', () => {
  const paged = (count: number, cursor: number | null, pageSize: number) => ({ count, cursor, pageSize });
  expect(fileListKeyAction(key('PageDown'), paged(50, 3, 10), false)).toEqual({ type: 'move', index: 13, extend: false });
  expect(fileListKeyAction(key('PageUp'), paged(50, 13, 10), false)).toEqual({ type: 'move', index: 3, extend: false });
  expect(fileListKeyAction(key('PageDown'), paged(50, 45, 10), false)).toEqual({ type: 'move', index: 49, extend: false });
  expect(fileListKeyAction(key('PageUp'), paged(50, 4, 10), false)).toEqual({ type: 'move', index: 0, extend: false });
  // From no cursor, the first page lands a page in from the edge it moves toward.
  expect(fileListKeyAction(key('PageDown'), paged(50, null, 10), false)).toEqual({ type: 'move', index: 9, extend: false });
  expect(fileListKeyAction(key('PageUp'), paged(50, null, 10), false)).toEqual({ type: 'move', index: 40, extend: false });
  expect(fileListKeyAction(key('PageDown'), paged(4, null, 10), false)).toEqual({ type: 'move', index: 3, extend: false });
  expect(fileListKeyAction(key('PageUp'), paged(4, null, 10), false)).toEqual({ type: 'move', index: 0, extend: false });
  // Shift extends, like the arrows.
  expect(fileListKeyAction(key('PageDown', { shiftKey: true }), paged(50, 0, 10), false)).toEqual({ type: 'move', index: 10, extend: true });
  // No page size means the default; a nonsense one still moves a row.
  expect(fileListKeyAction(key('PageDown'), state(50, 0), false)).toEqual({ type: 'move', index: DEFAULT_PAGE_SIZE, extend: false });
  expect(fileListKeyAction(key('PageDown'), paged(50, 0, 0), false)).toEqual({ type: 'move', index: 1, extend: false });
  expect(fileListKeyAction(key('PageDown'), paged(0, null, 10), false)).toEqual({ type: 'none' });
  expect(fileListKeyAction(key('PageDown'), paged(50, 3, 10), true)).toEqual({ type: 'none' });
});

test('printable characters are type-ahead, command chords and other keys are not', () => {
  expect(fileListKeyAction(key('a'), state(3), false)).toEqual({ type: 'typeAhead', char: 'a' });
  expect(fileListKeyAction(key('R', { shiftKey: true }), state(3), false)).toEqual({ type: 'typeAhead', char: 'R' });
  expect(fileListKeyAction(key('x', { altKey: true }), state(3), false)).toEqual({ type: 'none' });
  expect(fileListKeyAction(key('x', { ctrlKey: true }), state(3), false)).toEqual({ type: 'none' });
  expect(fileListKeyAction(key('x', { metaKey: true }), state(3), false)).toEqual({ type: 'none' });
  expect(fileListKeyAction(key('x'), state(3), true)).toEqual({ type: 'none' });
  expect(fileListKeyAction(key('Tab'), state(3), false)).toEqual({ type: 'none' });
  expect(fileListKeyAction(key('F5'), state(3), false)).toEqual({ type: 'none' });
});

test('typing targets are recognised', () => {
  const input = { tagName: 'INPUT', type: 'text', getAttribute: () => null } as unknown as HTMLElement;
  const area = { tagName: 'TEXTAREA', getAttribute: () => null } as unknown as HTMLElement;
  const editable = {
    tagName: 'DIV',
    getAttribute: (name: string) => (name === 'contenteditable' ? 'true' : null),
  } as unknown as HTMLElement;
  const div = { tagName: 'DIV', getAttribute: () => null } as unknown as HTMLElement;

  expect(isTypingTarget(input)).toBe(true);
  expect(isTypingTarget(area)).toBe(true);
  expect(isTypingTarget(editable)).toBe(true);
  expect(isTypingTarget(div)).toBe(false);
  expect(isTypingTarget(null)).toBe(false);
});

test('a checkbox is not a typing target — arrows must still walk the rows', () => {
  const checkbox = { tagName: 'INPUT', type: 'checkbox', getAttribute: () => null } as unknown as HTMLElement;
  const radio = { tagName: 'INPUT', type: 'radio', getAttribute: () => null } as unknown as HTMLElement;
  const number = { tagName: 'INPUT', type: 'number', getAttribute: () => null } as unknown as HTMLElement;

  expect(isTypingTarget(checkbox)).toBe(false);
  expect(isTypingTarget(radio)).toBe(false);
  // A number input consumes the arrow keys itself.
  expect(isTypingTarget(number)).toBe(true);
});

test('interactive targets are recognised', () => {
  const button = { tagName: 'BUTTON', getAttribute: () => null } as unknown as HTMLElement;
  const link = { tagName: 'A', getAttribute: () => null } as unknown as HTMLElement;
  const div = { tagName: 'DIV', getAttribute: () => null } as unknown as HTMLElement;

  expect(isInteractiveTarget(button)).toBe(true);
  expect(isInteractiveTarget(link)).toBe(true);
  expect(isInteractiveTarget(div)).toBe(false);
  expect(isInteractiveTarget(null)).toBe(false);
});

const handlerEvent = (k: string, modifiers: Partial<{ metaKey: boolean; shiftKey: boolean }> = {}) => {
  let prevented = false;
  return {
    event: {
      key: k,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      target: null,
      preventDefault: () => { prevented = true; },
      ...modifiers,
    },
    wasPrevented: () => prevented,
  };
};

test('the nav handler moves the cursor and scrolls the row into view', () => {
  const moves: { index: number; extend: boolean }[] = [];
  const scrolled: number[] = [];
  const handle = useFileListKeyboardNav({
    count: 3,
    cursor: 0,
    onMove: (index, extend) => moves.push({ index, extend }),
    onOpen: () => {},
    onSelectAll: () => {},
    onClear: () => {},
    onScrollTo: (index) => scrolled.push(index),
  });

  const down = handlerEvent('ArrowDown');
  handle(down.event);
  expect(moves).toEqual([{ index: 1, extend: false }]);
  expect(scrolled).toEqual([1]);
  expect(down.wasPrevented()).toBe(true);

  const shiftDown = handlerEvent('ArrowDown', { shiftKey: true });
  handle(shiftDown.event);
  expect(moves[1]).toEqual({ index: 1, extend: true });
});

test('the nav handler opens, selects all, and clears', () => {
  const opened: number[] = [];
  let selected = 0;
  let cleared = 0;
  const handle = useFileListKeyboardNav({
    count: 3,
    cursor: 1,
    onMove: () => {},
    onOpen: (index) => opened.push(index),
    onSelectAll: () => { selected += 1; },
    onClear: () => { cleared += 1; },
  });

  handle(handlerEvent('Enter').event);
  handle(handlerEvent('a', { metaKey: true }).event);
  handle(handlerEvent('Escape').event);

  expect(opened).toEqual([1]);
  expect(selected).toBe(1);
  expect(cleared).toBe(1);
});

test('the nav handler renames and deletes when the pane supports it', () => {
  const renamed: number[] = [];
  const deleted: number[] = [];
  const handle = useFileListKeyboardNav({
    count: 3,
    cursor: 2,
    onMove: () => {},
    onOpen: () => {},
    onRename: (index) => renamed.push(index),
    onDelete: (index) => deleted.push(index),
    onSelectAll: () => {},
    onClear: () => {},
  });

  handle(handlerEvent('F2').event);
  handle(handlerEvent('Backspace', { metaKey: true }).event);
  handle(handlerEvent('Delete').event);

  expect(renamed).toEqual([2]);
  expect(deleted).toEqual([2, 2]);
});

test('a pane that cannot rename or delete leaves those keys alone', () => {
  let prevented = false;
  const handle = useFileListKeyboardNav({
    count: 3,
    cursor: 2,
    onMove: () => {},
    onOpen: () => {},
    onSelectAll: () => {},
    onClear: () => {},
  });

  const rename = handlerEvent('F2');
  handle(rename.event);
  const remove = handlerEvent('Backspace', { metaKey: true });
  handle(remove.event);
  const forwardDelete = handlerEvent('Delete');
  handle(forwardDelete.event);

  expect(rename.wasPrevented()).toBe(false);
  expect(remove.wasPrevented()).toBe(false);
  expect(forwardDelete.wasPrevented()).toBe(false);
});

test('the nav handler ignores keys it has no answer for', () => {
  let moved = 0;
  const handle = useFileListKeyboardNav({
    count: 3,
    cursor: 0,
    onMove: () => { moved += 1; },
    onOpen: () => {},
    onSelectAll: () => {},
    onClear: () => {},
  });

  const typed = handlerEvent('ArrowDown');
  typed.event.target = { tagName: 'INPUT', type: 'text', getAttribute: () => null } as unknown as HTMLElement;
  handle(typed.event);

  expect(moved).toBe(0);
  expect(typed.wasPrevented()).toBe(false);
});

test('Enter on a control belongs to the control, not to the row', () => {
  const opened: number[] = [];
  const handle = useFileListKeyboardNav({
    count: 3,
    cursor: 1,
    onMove: () => {},
    onOpen: (index) => opened.push(index),
    onSelectAll: () => {},
    onClear: () => {},
  });

  const onButton = handlerEvent('Enter');
  onButton.event.target = { tagName: 'BUTTON', getAttribute: () => null } as unknown as HTMLElement;
  handle(onButton.event);
  expect(opened).toEqual([]);
  expect(onButton.wasPrevented()).toBe(false);

  const onPane = handlerEvent('Enter');
  onPane.event.target = { tagName: 'DIV', getAttribute: () => null } as unknown as HTMLElement;
  handle(onPane.event);
  expect(opened).toEqual([1]);
});
