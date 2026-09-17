import { afterEach, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { hookHarness } from './harness';

const harness = hookHarness();
mock.module('react-dom', () => ({ createPortal: (children: unknown) => children }));
const { Select } = await import('../../src/components/Select');
const oldDocument = globalThis.document;
const oldWindow = globalThis.window;
afterEach(() => {
  harness.unmount();
  globalThis.document = oldDocument;
  globalThis.window = oldWindow;
});

function control() {
  globalThis.document = Object.assign(new EventTarget(), { body: {} }) as unknown as Document;
  globalThis.window = new EventTarget() as unknown as Window & typeof globalThis;
  const change = mock(() => {});
  const props = {
    value: 'aws', onValueChange: change,
    children: ['aws', 'disabled', 'minio', 'wasabi'].map(value => createElement('option', { value, disabled: value === 'disabled', key: value }, value)),
  };
  const render = () => harness.render(() => Select(props));
  const button = () => render().props.children[0].props;
  const press = (key: string) => button().onKeyDown({ key, preventDefault() {}, stopPropagation() {} });
  return { change, button, press, render };
}

test('dropdown arrows skip disabled choices and commit only on Enter', () => {
  const c = control();
  c.press('ArrowDown');
  c.press('ArrowDown');
  expect(c.change).not.toHaveBeenCalled();
  c.press('Enter');
  expect(c.change).toHaveBeenCalledWith('minio');
  expect(c.button()['aria-expanded']).toBe(false);
});

test('typeahead finds options while Escape and Tab dismiss without changing value', () => {
  const c = control();
  c.press('w');
  expect(c.button()['aria-activedescendant']).toEndWith('-3');
  c.press('Escape');
  expect(c.button()['aria-expanded']).toBe(false);
  expect(c.change).not.toHaveBeenCalled();
  c.press('ArrowDown');
  c.press('End');
  c.press('Tab');
  expect(c.button()['aria-expanded']).toBe(false);
  expect(c.change).not.toHaveBeenCalled();
});

test('mouse selection uses the same value contract and rejects disabled options', () => {
  const c = control();
  c.button().onClick();
  const options = c.render().props.children[1].props.children;
  options[1].props.onClick();
  expect(c.change).not.toHaveBeenCalled();
  options[2].props.onClick();
  expect(c.change).toHaveBeenCalledWith('minio');
});
