import { S3Fields, type S3FieldsProps } from './S3Fields';
import { SftpFields, type SftpOptions } from './SftpFields';
import { FtpFields } from './FtpFields';
import type { RemoteFieldsProps } from './RemoteFields';

interface ProtocolFieldsProps {
  protocol: 's3' | 'sftp' | 'ftp' | 'ftps';
  s3: S3FieldsProps;
  remote: RemoteFieldsProps;
  ssh: SftpOptions;
}

export function ProtocolFields({ protocol, s3, remote, ssh }: ProtocolFieldsProps) {
  switch (protocol) {
    case 's3': return <S3Fields {...s3} />;
    case 'sftp': return <SftpFields remote={remote} ssh={ssh} />;
    case 'ftp':
    case 'ftps': return <FtpFields {...remote} />;
  }
}
