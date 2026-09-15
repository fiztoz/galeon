import { test, expect } from 'bun:test';
import { S3_PRESETS, endpointForPreset, guessPreset } from '../../src/components/connection/presets';

test('every preset has a unique id and a label', () => {
  const ids = S3_PRESETS.map((p) => p.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain('custom');
  for (const preset of S3_PRESETS) {
    expect(preset.label.length).toBeGreaterThan(0);
  }
});

test('endpointForPreset builds provider hostnames from region or account id', () => {
  const byId = Object.fromEntries(S3_PRESETS.map((p) => [p.id, p]));
  expect(endpointForPreset(byId.r2, { accountId: 'abc123' })).toBe(
    'https://abc123.r2.cloudflarestorage.com',
  );
  expect(endpointForPreset(byId.r2, {})).toBe('');
  expect(endpointForPreset(byId.b2, { region: 'eu-central-003' })).toBe(
    'https://s3.eu-central-003.backblazeb2.com',
  );
  expect(endpointForPreset(byId.wasabi, { region: 'eu-central-1' })).toBe(
    'https://s3.eu-central-1.wasabisys.com',
  );
  expect(endpointForPreset(byId.spaces, { region: 'sgp1' })).toBe(
    'https://sgp1.digitaloceanspaces.com',
  );
  expect(endpointForPreset(byId.minio, {})).toBe('http://localhost:9000');
  expect(endpointForPreset(byId.aws, {})).toBe('');
  expect(endpointForPreset(byId.custom, {})).toBe('');
});

test('guessPreset maps stored endpoints back to the matching provider', () => {
  expect(guessPreset(undefined)).toBe('aws');
  expect(guessPreset('')).toBe('aws');
  expect(guessPreset('https://s3.us-west-2.amazonaws.com')).toBe('aws');
  expect(guessPreset('https://deadbeef.r2.cloudflarestorage.com')).toBe('r2');
  expect(guessPreset('https://s3.us-west-004.backblazeb2.com')).toBe('b2');
  expect(guessPreset('https://s3.us-east-1.wasabisys.com')).toBe('wasabi');
  expect(guessPreset('https://nyc3.digitaloceanspaces.com')).toBe('spaces');
  expect(guessPreset('http://localhost:9000')).toBe('minio');
  expect(guessPreset('http://127.0.0.1:9000')).toBe('minio');
  expect(guessPreset('https://minio.example.com:9000')).toBe('minio');
  expect(guessPreset('https://s3.garage.example.com')).toBe('custom');
});
