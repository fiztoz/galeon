import { test, expect } from 'bun:test';
import { randomProfileName, selectedProfileChanged, uniqueProfileName } from '../../src/components/connection/connect';

test('randomProfileName produces readable two-word names', () => {
  const name = randomProfileName();
  expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  for (let i = 0; i < 20; i++) expect(randomProfileName()).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
});

test('uniqueProfileName keeps a fresh base untouched', () => {
  expect(uniqueProfileName('Cobalt Otter', ['Quick Connect', ' work server '] )).toBe('Cobalt Otter');
});

test('uniqueProfileName trims whitespace on the way in', () => {
  expect(uniqueProfileName('  Cobalt Otter  ', [])).toBe('Cobalt Otter');
});

test('uniqueProfileName ignores case when checking existing names', () => {
  expect(uniqueProfileName('Cobalt Otter', ['cobalt otter'])).toBe('Cobalt Otter 2');
});

test('uniqueProfileName increments past every taken suffix', () => {
  expect(uniqueProfileName('Cobalt Otter', ['Cobalt Otter', 'cobalt otter 2'])).toBe('Cobalt Otter 3');
  expect(uniqueProfileName('Cobalt Otter', ['Cobalt Otter'])).toBe('Cobalt Otter 2');
});

test('uniqueProfileName falls back to a random name when the base is empty', () => {
  const name = uniqueProfileName('', ['Cobalt Otter']);
  expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
});

const savedProfile = (over: Partial<Parameters<typeof selectedProfileChanged>[0]> = {}) => ({
  id: 'p1', name: 'Demo', protocol: 's3' as const, bucket: 'bix', region: 'us-east-1',
  endpoint: 'https://s3.example.com', ...over,
});

test('selectedProfileChanged: an untouched profile is reported unchanged', () => {
  const stored = savedProfile();
  expect(selectedProfileChanged(stored, { ...stored })).toBe(false);
  // Defaults normalize: STANDARD storage class / false flags / absent secrets
  expect(selectedProfileChanged(savedProfile({ storageClass: 'STANDARD' }), { ...stored, storageClass: undefined })).toBe(false);
  expect(selectedProfileChanged(savedProfile({ dangerDisableSslVerification: false }), { ...stored })).toBe(false);
});

test('selectedProfileChanged flags meaningful edits', () => {
  const stored = savedProfile();
  expect(selectedProfileChanged(stored, { ...stored, bucket: 'other-bucket' })).toBe(true);
  expect(selectedProfileChanged(stored, { ...stored, region: 'eu-west-1' })).toBe(true);
  expect(selectedProfileChanged(savedProfile(), savedProfile({ port: 2222 }))).toBe(true);
  // Tunnel metadata counts too
  const tunnel = { host: 'bastion', port: 22, username: 'ops' };
  expect(selectedProfileChanged({ ...stored, sshTunnel: tunnel }, stored)).toBe(true);
  expect(selectedProfileChanged({ ...stored, sshTunnel: tunnel }, { ...stored, sshTunnel: tunnel })).toBe(false);
});

test('selectedProfileChanged ignores secret-only differences (they live in the keyring)', () => {
  const stored = savedProfile();
  expect(selectedProfileChanged(stored, { ...stored, accessKey: 'AKIAUPDATE', secretKey: 'new-secret' })).toBe(false);
});

test('selectedProfileChanged treats equal bandwidth values as unchanged', () => {
  // Both the stored profile and the form-built candidate carry bytes.
  const stored = savedProfile({ maxBandwidth: 1024 * 512 });
  expect(selectedProfileChanged(stored, { ...stored, maxBandwidth: 1024 * 512 })).toBe(false);
  expect(selectedProfileChanged(stored, { ...stored, maxBandwidth: 1024 * 700 })).toBe(true);
});

