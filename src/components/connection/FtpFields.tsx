import { RemoteFields, type RemoteFieldsProps } from './RemoteFields';

/** FTP and explicit FTPS use the same authentication fields. */
export function FtpFields(props: RemoteFieldsProps) {
  return <RemoteFields {...props} passwordHelp="Stored securely in your OS keyring when you save this profile." />;
}
