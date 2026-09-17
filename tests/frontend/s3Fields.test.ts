import { afterEach, expect, test } from 'bun:test';
import { Children, isValidElement, type ReactNode } from 'react';
import { Select } from '../../src/components/Select';
import { hookHarness } from './harness';
import type { S3FieldsProps } from '../../src/components/connection/S3Fields';

const harness = hookHarness();
const { S3Fields } = await import('../../src/components/connection/S3Fields');
afterEach(() => harness.unmount());

interface FieldProps {
  children?: ReactNode;
  value?: string;
  placeholder?: string;
  onValueChange?: (value: string) => void;
  onChange?: (event: { target: { value: string } }) => void;
}

function fields(tree: ReactNode, type: string | typeof Select): FieldProps[] {
  const found: FieldProps[] = [];
  Children.forEach(tree, (node) => {
    if (!isValidElement<FieldProps>(node)) return;
    if (node.type === type) found.push(node.props);
    found.push(...fields(node.props.children, type));
  });
  return found;
}

function form(endpoint = '', region = 'us-east-1') {
  const noop = () => {};
  const props: S3FieldsProps = {
    bucket: 'test-bucket', setBucket: noop, accessKey: '', setAccessKey: noop,
    secretKey: '', setSecretKey: noop, endpoint, region,
    setEndpoint: value => { props.endpoint = typeof value === 'function' ? value(props.endpoint) : value; },
    setRegion: value => { props.region = typeof value === 'function' ? value(props.region) : value; },
    dangerDisableSsl: false, setDangerDisableSsl: noop,
    showAdvanced: false, setShowAdvanced: noop,
    useVirtualHostStyle: false, setUseVirtualHostStyle: noop,
    storageClass: 'STANDARD', setStorageClass: noop,
    maxBandwidth: '', setMaxBandwidth: noop, bandwidthRules: null,
  };
  // The runner makes render-phase state updates explicit.
  const render = () => { harness.render(() => S3Fields(props)); return harness.render(() => S3Fields(props)); };
  return { props, render };
}

test('loading another profile refreshes provider without rewriting its settings', () => {
  const { props, render } = form();
  expect(fields(render(), Select)[0].value).toBe('aws');
  props.endpoint = 'http://localhost:9000';
  props.region = 'local-region';
  expect(fields(render(), Select)[0].value).toBe('minio');
  expect(props.endpoint).toBe('http://localhost:9000');
  expect(props.region).toBe('local-region');
});

test('R2 account follows the loaded endpoint, including switching between R2 profiles', () => {
  const { props, render } = form('https://first-account.r2.cloudflarestorage.com', 'auto');
  const account = () => fields(render(), 'input').find(field => field.placeholder === 'R2 account ID');
  expect(account()?.value).toBe('first-account');
  props.endpoint = 'https://second-account.r2.cloudflarestorage.com';
  expect(account()?.value).toBe('second-account');
  account()?.onChange?.({ target: { value: 'third-account' } });
  expect(props.endpoint).toBe('https://third-account.r2.cloudflarestorage.com');
});

test('explicit provider choices survive their own endpoint updates', () => {
  const { props, render } = form();
  fields(render(), Select)[0].onValueChange?.('r2');
  expect(fields(render(), Select)[0].value).toBe('r2');
  fields(render(), 'input').find(field => field.placeholder === 'R2 account ID')?.onChange?.({ target: { value: 'test-account' } });
  expect(fields(render(), Select)[0].value).toBe('r2');
  fields(render(), Select)[0].onValueChange?.('custom');
  expect(fields(render(), Select)[0].value).toBe('custom');
  expect(props.endpoint).toBe('https://test-account.r2.cloudflarestorage.com');
});

test('regions outside preset suggestions remain visible and editable', () => {
  const { props, render } = form('', 'custom-region-1');
  const region = fields(render(), 'input').find(field => field.value === 'custom-region-1');
  expect(region).toBeDefined();
  region?.onChange?.({ target: { value: 'custom-region-2' } });
  expect(props.region).toBe('custom-region-2');
});

test('switching profiles replaces stale region-driven provider behavior', () => {
  const { props, render } = form('https://s3.us-east-1.wasabisys.com');
  render();
  props.endpoint = 'http://localhost:9000';
  const region = fields(render(), 'input').find(field => field.value === 'us-east-1');
  region?.onChange?.({ target: { value: 'local-region' } });
  expect(props.region).toBe('local-region');
  expect(props.endpoint).toBe('http://localhost:9000');
});

test('free-text regions still update region-derived provider endpoints', () => {
  const { props, render } = form('https://s3.us-east-1.wasabisys.com');
  const region = fields(render(), 'input').find(field => field.value === 'us-east-1');
  region?.onChange?.({ target: { value: 'custom-region-1' } });
  expect(props.endpoint).toBe('https://s3.custom-region-1.wasabisys.com');
  expect(fields(render(), Select)[0].value).toBe('wasabi');
});
