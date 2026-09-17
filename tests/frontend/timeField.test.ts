import { expect, test } from 'bun:test';
import { TimeField } from '../../src/components/TimeField';
test('time selectors retain the other part, including midnight and single-digit minutes', () => {
  let value = '22:06';
  const fields = () => TimeField({ value, label: 'Start', onValueChange: next => { value = next; } }).props.children;
  fields()[0].props.onValueChange('00');
  expect(value).toBe('00:06');
  fields()[2].props.onValueChange('09');
  expect(value).toBe('00:09');
  expect(fields()[0].props.children).toHaveLength(24);
  expect(fields()[2].props.children).toHaveLength(60);
});
