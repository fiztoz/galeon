import { test, expect } from 'bun:test';
import {
  DEFAULT_PAGE_SIZE,
  TYPE_AHEAD_TIMEOUT_MS,
  appendTypeAhead,
  initialTypeAhead,
  pageSizeFor,
  typeAheadMatch,
  useFileListKeyboardNav,
} from '../../src/hooks/useFileListKeyboard';

const NAMES = ['alpha', 'Beta', 'backup', 'build', 'docs', 'README.md', 'readme-old.txt'];

test('a match is a case-insensitive prefix', () => {
  expect(typeAheadMatch(NAMES, 'BU', null)).toBe(3);
  expect(typeAheadMatch(NAMES, 'readme.', null)).toBe(5);
  expect(typeAheadMatch(NAMES, 'readme-', null)).toBe(6);
  expect(typeAheadMatch(NAMES, 'zzz', null)).toBeNull();
  expect(typeAheadMatch([], 'a', null)).toBeNull();
  expect(typeAheadMatch(NAMES, '', 0)).toBeNull();
});

test('one letter steps to the next match after the cursor and wraps', () => {
  expect(typeAheadMatch(NAMES, 'b', null)).toBe(1);
  expect(typeAheadMatch(NAMES, 'b', 1)).toBe(2);
  expect(typeAheadMatch(NAMES, 'b', 2)).toBe(3);
  expect(typeAheadMatch(NAMES, 'b', 3)).toBe(1);
  // The only match is the cursor row: stay on it.
  expect(typeAheadMatch(NAMES, 'd', 4)).toBe(4);
});

test('the same letter pressed again keeps cycling', () => {
  expect(typeAheadMatch(NAMES, 'bb', 1)).toBe(2);
  expect(typeAheadMatch(NAMES, 'bbb', 2)).toBe(3);
});

test('a longer query refines in place while the cursor row still matches', () => {
  expect(typeAheadMatch(NAMES, 'ba', 2)).toBe(2);
  expect(typeAheadMatch(NAMES, 'bu', 2)).toBe(3);
  expect(typeAheadMatch(NAMES, 're', 5)).toBe(5);
});

test('a pause starts a new query', () => {
  let typed = initialTypeAhead();
  typed = appendTypeAhead(typed, 'r', 1000);
  typed = appendTypeAhead(typed, 'e', 1000 + TYPE_AHEAD_TIMEOUT_MS);
  expect(typed.query).toBe('re');
  typed = appendTypeAhead(typed, 'd', 1001 + 2 * TYPE_AHEAD_TIMEOUT_MS);
  expect(typed).toEqual({ query: 'd', at: 1001 + 2 * TYPE_AHEAD_TIMEOUT_MS });
});

test('a page is one row less than the viewport holds', () => {
  expect(pageSizeFor(280, 28)).toBe(9);
  expect(pageSizeFor(30, 28)).toBe(1);
  expect(pageSizeFor(0, 28)).toBe(DEFAULT_PAGE_SIZE);
  expect(pageSizeFor(280, 0)).toBe(DEFAULT_PAGE_SIZE);
});

const typed = (k: string) => {
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
    },
    wasPrevented: () => prevented,
  };
};

test('the nav handler jumps to the typed name and scrolls to it', () => {
  const moves: { index: number; extend: boolean }[] = [];
  const scrolled: number[] = [];
  const state = { current: initialTypeAhead() };
  let clock = 5000;
  let cursor: number | null = null;
  const handler = () =>
    useFileListKeyboardNav({
      count: NAMES.length,
      cursor,
      onMove: (index, extend) => { moves.push({ index, extend }); cursor = index; },
      onOpen: () => {},
      onSelectAll: () => {},
      onClear: () => {},
      onScrollTo: (index) => scrolled.push(index),
      typeAhead: { names: NAMES, state },
      now: () => clock,
    });

  const r = typed('r');
  handler()(r.event);
  expect(r.wasPrevented()).toBe(true);
  clock += 100;
  handler()(typed('e').event);
  clock += 100;
  handler()(typed('a').event);
  clock += 100;
  handler()(typed('d').event);
  clock += 100;
  handler()(typed('m').event);
  clock += 100;
  handler()(typed('e').event);
  clock += 100;
  handler()(typed('-').event);

  expect(moves.map((move) => move.index)).toEqual([5, 5, 5, 5, 5, 5, 6]);
  expect(moves.every((move) => !move.extend)).toBe(true);
  expect(scrolled.at(-1)).toBe(6);

  // After a pause, one letter starts over.
  clock += TYPE_AHEAD_TIMEOUT_MS + 1;
  handler()(typed('a').event);
  expect(cursor).toBe(0);

  // No match: the key is swallowed but the cursor stays.
  clock += TYPE_AHEAD_TIMEOUT_MS + 1;
  handler()(typed('q').event);
  expect(cursor).toBe(0);
});

test('a lone space stays with the focused control', () => {
  const state = { current: initialTypeAhead() };
  const handle = useFileListKeyboardNav({
    count: NAMES.length,
    cursor: 0,
    onMove: () => {},
    onOpen: () => {},
    onSelectAll: () => {},
    onClear: () => {},
    typeAhead: { names: NAMES, state },
    now: () => 1,
  });
  const space = typed(' ');
  handle(space.event);
  expect(space.wasPrevented()).toBe(false);
  expect(state.current.query).toBe('');
});

test('a pane without type-ahead leaves letters alone', () => {
  const handle = useFileListKeyboardNav({
    count: NAMES.length,
    cursor: 0,
    onMove: () => { throw new Error('should not move'); },
    onOpen: () => {},
    onSelectAll: () => {},
    onClear: () => {},
  });
  const letter = typed('b');
  handle(letter.event);
  expect(letter.wasPrevented()).toBe(false);
});
