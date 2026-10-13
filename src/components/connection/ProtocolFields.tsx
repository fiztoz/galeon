import { S3Fields, type S3FieldsProps } from './S3Fields';
import { SftpFields, type SftpOptions } from './SftpFields';
import { FtpFields } from './FtpFields';
import { WebdavFields, type WebdavFieldsProps } from './WebdavFields';
import { AzureFields, type AzureFieldsProps } from './AzureFields';
import { GcsFields, type GcsFieldsProps } from './GcsFields';
import type { RemoteFieldsProps } from './RemoteFields';
import type { StorageProtocol } from '../../types';

interface ProtocolFieldsProps {
  protocol: StorageProtocol;
  s3: S3FieldsProps;
  remote: RemoteFieldsProps;
  ssh: SftpOptions;
  webdav: WebdavFieldsProps;
  azure: AzureFieldsProps;
  gcs: GcsFieldsProps;
}

export function ProtocolFields({ protocol, s3, remote, ssh, webdav, azure, gcs }: ProtocolFieldsProps) {
  switch (protocol) {
    case 's3': return <S3Fields {...s3} />;
    case 'sftp': return <SftpFields remote={remote} ssh={ssh} />;
    case 'ftp':
    case 'ftps': return <FtpFields {...remote} />;
    case 'webdav': return <WebdavFields {...webdav} />;
    case 'azure': return <AzureFields {...azure} />;
    case 'gcs': return <GcsFields {...gcs} />;
  }
}
