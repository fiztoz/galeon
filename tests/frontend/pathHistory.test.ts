import { test, expect } from 'bun:test';
import {
  backPath,
  forwardPath,
  initialPathHistory,
  moveWithinHistory,
  parentPrefix,
  pushPath,
  type PathHistoryState,
} from '../../src/pathHistory';

test('pushing the current path returns the same state', () => {
  const state = initialPathHistory('a/');
  expect(pushPath(state, 'a/')).toBe(state);
});

test('pushing truncates the future stack', () => {
  let state: PathHistoryState = initialPathHistory('a/');
  state = pushPath(state, 'b/');
  state = backPath(state)!;
  expect(state.future).toEqual(['b/']);
  state = pushPath(state, 'c/');
  expect(state.future).toEqual([]);
  expect(state.current).toBe('c/');
});

test('back then forward restores the path that was current', () => {
  let state: PathHistoryState = initialPathHistory('a/');
  state = pushPath(state, 'b/');
  state = pushPath(state, 'c/');
  expect(state.current).toBe('c/');

  state = backPath(state)!;
  expect(state.current).toBe('b/');
  expect(state.past).toEqual(['a/']);
  expect(state.future).toEqual(['c/']);

  state = forwardPath(state)!;
  expect(state.current).toBe('c/');
  expect(state.past).toEqual(['a/', 'b/']);
  expect(state.future).toEqual([]);
});

test('back on an empty past returns null', () => {
  expect(backPath(initialPathHistory('a/'))).toBeNull();
});

test('forward on an empty future returns null', () => {
  expect(forwardPath(initialPathHistory('a/'))).toBeNull();
});

test('the 51st push drops the oldest past entry', () => {
  let state = initialPathHistory('p0');
  for (let i = 1; i <= 51; i++) state = pushPath(state, `p${i}`);
  expect(state.past.length).toBe(50);
  expect(state.past[0]).toBe('p1');
  expect(state.past[49]).toBe('p50');
  expect(state.current).toBe('p51');
});

test('moving within the history does not record the location again', () => {
  let state: PathHistoryState = initialPathHistory('a/');
  state = pushPath(state, 'b/');
  state = pushPath(state, 'c/');

  const back = moveWithinHistory(state, 'b/');
  expect(back.current).toBe('b/');
  expect(back.past).toEqual(['a/']);
  expect(back.future).toEqual(['c/']);

  const forward = moveWithinHistory(back, 'c/');
  expect(forward.current).toBe('c/');
  expect(forward.past).toEqual(['a/', 'b/']);
  expect(forward.future).toEqual([]);
});

test('moving to an unknown location leaves the history alone', () => {
  const state = initialPathHistory('a/');
  expect(moveWithinHistory(state, 'z/')).toBe(state);
});

test('parentPrefix of an object prefix', () => {
  expect(parentPrefix('', false)).toBeNull();
  expect(parentPrefix('a/', false)).toBe('');
  expect(parentPrefix('a/b/', false)).toBe('a/');
  expect(parentPrefix('a/b', false)).toBe('a/');
  expect(parentPrefix('/', false)).toBeNull();
});

test('parentPrefix of an absolute path', () => {
  expect(parentPrefix('/', true)).toBeNull();
  expect(parentPrefix('', true)).toBeNull();
  expect(parentPrefix('/var/log', true)).toBe('/var');
  expect(parentPrefix('/var', true)).toBe('/');
});
