import { afterEach, expect, test } from 'bun:test';
import { Children, isValidElement, type ReactNode } from 'react';
import { hookHarness } from './harness';

const harness = hookHarness();
const { WebdavFields } = await import('../../src/components/connection/WebdavFields');
const { AzureFields } = await import('../../src/components/connection/AzureFields');
const { GcsFields } = await import('../../src/components/connection/GcsFields');
afterEach(() => harness.unmount());

interface FieldProps {
  id?: string;
  children?: ReactNode;
  value?: string;
  placeholder?: string;
  onChange?: (event: { target: { value: string } }) => void;
}

function fields(tree: ReactNode, type: string): FieldProps[] {
  const found: FieldProps[] = [];
  Children.forEach(tree, (node) => {
    if (!isValidElement<FieldProps>(node)) return;
    if (node.type === type) found.push(node.props);
    found.push(...fields(node.props.children, type));
  });
  return found;
}

/** Input by its label's htmlFor id. */
function input(tree: ReactNode, id: string): FieldProps | undefined {
  return fields(tree, 'input').find((field) => field.id === id);
}

test('webdav form exposes the DAV root URL plus shared auth', () => {
  const props = {
    endpoint: '', setEndpoint: () => {},
    username: 'me', setUsername: () => {},
    sftpPassword: '', setSftpPassword: () => {},
  };
  const tree = harness.render(() => WebdavFields(props));
  expect(input(tree, 'webdav-endpoint')?.placeholder).toContain('remote.php/dav');
  expect(input(tree, 'webdav-username')?.value).toBe('me');
  expect(input(tree, 'webdav-password')).toBeDefined();
});

test('azure form maps account name and account key onto shared auth state', () => {
  const props = {
    endpoint: '', setEndpoint: () => {},
    username: 'mystorageaccount', setUsername: () => {},
    sftpPassword: 'base64key', setSftpPassword: () => {},
    bucket: 'my-container', setBucket: () => {},
  };
  const tree = harness.render(() => AzureFields(props));
  expect(input(tree, 'azure-account')?.value).toBe('mystorageaccount');
  expect(input(tree, 'azure-container')?.value).toBe('my-container');
  expect(input(tree, 'azure-key')?.value).toBe('base64key');
  // Endpoint stays optional — the backend derives it from the account name.
  expect(input(tree, 'azure-endpoint')?.value).toBe('');
});

test('gcs form prefers a credential file but allows pasted JSON', async () => {
  const props = {
    endpoint: '', setEndpoint: () => {},
    bucket: 'my-bucket', setBucket: () => {},
    credentialPath: '/keys/gcs.json', setCredentialPath: () => {},
    sftpPassword: '', setSftpPassword: () => {},
  };
  const tree = harness.render(() => GcsFields(props));
  expect(input(tree, 'gcs-bucket')?.value).toBe('my-bucket');
  expect(input(tree, 'gcs-credential-path')?.value).toBe('/keys/gcs.json');
  // Pasted JSON lives in a textarea (multi-line key contents).
  expect(fields(tree, 'textarea').find((field) => field.id === 'gcs-credential')).toBeDefined();
});
