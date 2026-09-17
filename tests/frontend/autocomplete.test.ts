import { afterEach, expect, mock, test } from 'bun:test';
import { hookHarness } from './harness';
const harness = hookHarness();
mock.module('react-dom', () => ({ createPortal: (children: unknown) => children }));
const { Autocomplete } = await import('../../src/components/Autocomplete');
const oldDocument = globalThis.document;
const oldWindow = globalThis.window;
afterEach(() => { harness.unmount(); globalThis.document = oldDocument; globalThis.window = oldWindow; });
function control() {
  globalThis.document = Object.assign(new EventTarget(), { body: {} }) as unknown as Document;
  globalThis.window = new EventTarget() as unknown as Window & typeof globalThis;
  const props = { value: 'us-east-1', options: ['us-east-1', 'us-west-2'], onValueChange: (value: string) => { props.value = value; } };
  const render = () => harness.render(() => Autocomplete(props));
  const input = () => render().props.children[0].props;
  const press = (key: string) => input().onKeyDown({ key, nativeEvent: {}, preventDefault() {}, stopPropagation() {} });
  return { props, render, input, press };
}
test('custom regions survive unmatched suggestions and dismissal', () => {
  const c = control(); c.input().onFocus();
  c.input().onChange({ target: { value: 'custom-region-9' } });
  expect(c.props.value).toBe('custom-region-9');
  expect(c.input()['aria-expanded']).toBe(false);
  c.press('Escape');
  expect(c.props.value).toBe('custom-region-9');
});
test('filtered suggestions require explicit selection; Tab preserves typed text', () => {
  const c = control(); c.input().onChange({ target: { value: 'west' } });
  c.press('Tab'); expect(c.props.value).toBe('west');
  c.input().onChange({ target: { value: 'west' } });
  c.press('ArrowDown'); c.press('Enter');
  expect(c.props.value).toBe('us-west-2');
  expect(c.input()['aria-expanded']).toBe(false);
});
