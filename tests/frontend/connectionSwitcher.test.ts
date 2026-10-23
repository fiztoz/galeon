import { test, expect } from 'bun:test';
import { isCurrentProfile, switcherSubtitle } from '../../src/connectionSwitcher';

test('an SFTP subtitle names the protocol, the user, the host, and the port', () => {
  const subtitle = switcherSubtitle({
    id: '1',
    name: 'Home NAS',
    protocol: 'sftp',
    username: 'fizto',
    host: 'nas.local',
    port: '2222',
  });
  expect(subtitle).toContain('SFTP');
  expect(subtitle).toContain('fizto');
  expect(subtitle).toContain('nas.local');
  expect(subtitle).toContain('2222');
});

test('an S3 subtitle names the protocol and the bucket', () => {
  const subtitle = switcherSubtitle({
    id: '1',
    name: 'Backups',
    protocol: 's3',
    bucket: 'my-bucket',
  });
  expect(subtitle).toContain('S3');
  expect(subtitle).toContain('my-bucket');
});

test('a profile without a protocol is treated as S3', () => {
  const subtitle = switcherSubtitle({ id: '1', name: 'Backups', bucket: 'my-bucket' });
  expect(subtitle).toContain('S3');
  expect(subtitle).toContain('my-bucket');
});

test('the current profile is the one the session came from', () => {
  expect(isCurrentProfile('abc', 'abc')).toBe(true);
  expect(isCurrentProfile('abc', 'other')).toBe(false);
});

test('an ad-hoc connection is never a current profile', () => {
  expect(isCurrentProfile('abc', undefined)).toBe(false);
});
