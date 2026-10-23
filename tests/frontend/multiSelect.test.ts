import { test, expect } from 'bun:test';
import { hookHarness } from './harness';
const harness = hookHarness();
const { useMultiSelect, applySelection } = await import('../../src/hooks/useMultiSelect');

test('a plain click replaces the selection instead of toggling it', () => {
  const visible = ['z', 'filtered-third', 'a'].map(fullKey => ({fullKey}));
  const render = () => harness.render(() => useMultiSelect(visible));
  let hook = render();
  hook.handleSelectItem('z', 0); hook = render();
  hook.handleSelectItem('a', 2); hook = render();
  expect([...hook.selectedItems]).toEqual(['a']);
  expect(hook.lastSelectedIndex).toBe(2);
  expect(hook.cursorIndex).toBe(2);
  harness.unmount();
});

test('shift selection follows visible order and a later plain click replaces it', () => {
  const visible = ['z', 'filtered-third', 'a'].map(fullKey => ({fullKey}));
  const render = () => harness.render(() => useMultiSelect(visible));
  let hook = render();
  hook.handleSelectItem('z', 0); hook = render();
  hook.handleSelectItem('a', 2, { shift: true }); hook = render();
  expect([...hook.selectedItems]).toEqual(['z', 'filtered-third', 'a']);
  // The anchor stays on the original click, so the range can be re-aimed.
  expect(hook.lastSelectedIndex).toBe(0);
  hook.handleSelectItem('filtered-third', 1); hook = render();
  expect([...hook.selectedItems]).toEqual(['filtered-third']);
  harness.unmount();
});

test('a toggling gesture adds and removes one row', () => {
  const visible = ['z', 'filtered-third', 'a'].map(fullKey => ({fullKey}));
  const render = () => harness.render(() => useMultiSelect(visible));
  let hook = render();
  hook.handleSelectItem('z', 0, { toggle: true }); hook = render();
  expect([...hook.selectedItems]).toEqual(['z']);
  hook.handleSelectItem('z', 0, { toggle: true }); hook = render();
  expect([...hook.selectedItems]).toEqual([]);
  harness.unmount();
});

test('shift with no anchor selects only the clicked row', () => {
  const visible = ['z', 'filtered-third', 'a'].map(fullKey => ({fullKey}));
  const render = () => harness.render(() => useMultiSelect(visible));
  let hook = render();
  hook.handleSelectItem('a', 2, { shift: true }); hook = render();
  expect([...hook.selectedItems]).toEqual(['a']);
  harness.unmount();
});

test('clearing resets the anchor and the cursor', () => {
  const visible = ['z', 'filtered-third', 'a'].map(fullKey => ({fullKey}));
  const render = () => harness.render(() => useMultiSelect(visible));
  let hook = render();
  hook.handleSelectItem('z', 0); hook = render();
  hook.clearSelection(); hook = render();
  expect(hook.lastSelectedIndex).toBeNull();
  expect(hook.cursorIndex).toBeNull();
  hook.handleSelectItem('a', 2, { shift: true }); hook = render();
  expect([...hook.selectedItems]).toEqual(['a']);
  harness.unmount();
});

test('select all and clear the selection', () => {
  const visible = ['z', 'filtered-third', 'a'].map(fullKey => ({fullKey}));
  const render = () => harness.render(() => useMultiSelect(visible));
  let hook = render();
  hook.handleSelectAll(); hook = render();
  expect(hook.selectedItems.size).toBe(3);
  hook.handleSelectAll(); hook = render();
  expect(hook.selectedItems.size).toBe(0);
  harness.unmount();
});

test('applySelection keeps the anchor on a shift range', () => {
  const items = [{ fullKey: 'a' }, { fullKey: 'b' }, { fullKey: 'c' }];
  const result = applySelection(new Set(['a']), 0, items, 'c', 2, { shift: true });
  expect([...result.selected]).toEqual(['a', 'b', 'c']);
  expect(result.anchor).toBe(0);
});

test('applySelection replaces on a plain gesture', () => {
  const items = [{ fullKey: 'a' }, { fullKey: 'b' }];
  const result = applySelection(new Set(['a', 'b']), 0, items, 'b', 1, {});
  expect([...result.selected]).toEqual(['b']);
  expect(result.anchor).toBe(1);
});
