// S3 provider presets: endpoint formats, region conventions, URL style.
//
// New users should not have to look up whether R2 wants `auto` as the region
// or whether MinIO defaults to path-style. Each preset captures those
// conventions in one place so `S3Fields` can prefill endpoint / region /
// virtual-host style when the provider changes.
//
// `Custom` is intentionally unconstrained — it leaves every field alone.

export type S3ProviderId =
  | 'aws'
  | 'r2'
  | 'b2'
  | 'minio'
  | 'wasabi'
  | 'spaces'
  | 'custom';

export interface S3Preset {
  id: S3ProviderId;
  label: string;
  /** Prefilled when the preset is picked (empty = leave the field alone). */
  defaultEndpoint: string;
  endpointPlaceholder: string;
  defaultRegion: string;
  regionPlaceholder: string;
  /** Suggestions only; users can also enter regions absent from this list. */
  regionOptions?: string[];
  useVirtualHostStyle: boolean;
  /** R2 builds its endpoint from an account ID; show that field. */
  needsAccountId?: boolean;
  help: string;
}

export const S3_PRESETS: S3Preset[] = [
  {
    id: 'aws',
    label: 'Amazon S3',
    defaultEndpoint: '',
    endpointPlaceholder: 'Leave empty for AWS',
    defaultRegion: 'us-east-1',
    regionPlaceholder: 'us-east-1',
    regionOptions: [
      'us-east-1',
      'us-east-2',
      'us-west-1',
      'us-west-2',
      'eu-west-1',
      'eu-central-1',
      'ap-southeast-1',
      'ap-northeast-1',
    ],
    useVirtualHostStyle: true,
    help: 'Standard AWS endpoints. Leave the endpoint empty unless you use a VPC endpoint.',
  },
  {
    id: 'r2',
    label: 'Cloudflare R2',
    defaultEndpoint: '',
    endpointPlaceholder: 'https://<account_id>.r2.cloudflarestorage.com',
    defaultRegion: 'auto',
    regionPlaceholder: 'auto',
    useVirtualHostStyle: false,
    needsAccountId: true,
    help: 'Enter your R2 account ID to build the endpoint. Region is always “auto”, path-style URLs.',
  },
  {
    id: 'b2',
    label: 'Backblaze B2',
    defaultEndpoint: '',
    endpointPlaceholder: 'https://s3.<region>.backblazeb2.com',
    defaultRegion: 'us-west-004',
    regionPlaceholder: 'us-west-004',
    regionOptions: ['us-west-004', 'us-west-003', 'eu-central-003'],
    useVirtualHostStyle: false,
    help: 'Endpoint follows https://s3.<region>.backblazeb2.com. Pick the region your bucket lives in.',
  },
  {
    id: 'minio',
    label: 'MinIO',
    defaultEndpoint: 'http://localhost:9000',
    endpointPlaceholder: 'http://localhost:9000 or https://minio.example.com:9000',
    defaultRegion: '',
    regionPlaceholder: 'us-east-1 (optional for MinIO)',
    useVirtualHostStyle: false,
    help: 'Self-hosted or local MinIO. Path-style URLs, region optional.',
  },
  {
    id: 'wasabi',
    label: 'Wasabi',
    defaultEndpoint: '',
    endpointPlaceholder: 'https://s3.<region>.wasabisys.com',
    defaultRegion: 'us-east-1',
    regionPlaceholder: 'us-east-1',
    regionOptions: ['us-east-1', 'us-west-1', 'eu-west-1', 'eu-central-1', 'ap-northeast-1'],
    useVirtualHostStyle: false,
    help: 'Endpoint follows https://s3.<region>.wasabisys.com. Pick the region your bucket lives in.',
  },
  {
    id: 'spaces',
    label: 'DigitalOcean Spaces',
    defaultEndpoint: '',
    endpointPlaceholder: 'https://<region>.digitaloceanspaces.com',
    defaultRegion: 'nyc3',
    regionPlaceholder: 'nyc3',
    regionOptions: ['nyc3', 'sfo3', 'ams3', 'sgp1', 'fra1'],
    useVirtualHostStyle: true,
    help: 'Endpoint follows https://<region>.digitaloceanspaces.com. Virtual-host style URLs.',
  },
  {
    id: 'custom',
    label: 'Custom (S3-compatible)',
    defaultEndpoint: '',
    endpointPlaceholder: 'https://s3.example.com:9000',
    defaultRegion: '',
    regionPlaceholder: 'us-east-1 (optional)',
    useVirtualHostStyle: false,
    help: 'Any other S3-compatible API. All fields are free-form.',
  },
];

/** Build an endpoint URL for presets that derive it from other fields. */
export const endpointForPreset = (
  preset: S3Preset,
  opts: { accountId?: string; region?: string },
): string => {
  if (preset.id === 'r2') {
    const accountId = (opts.accountId || '').trim();
    if (!accountId) return '';
    return `https://${accountId}.r2.cloudflarestorage.com`;
  }
  if (preset.id === 'b2') {
    const region = (opts.region || preset.defaultRegion).trim() || preset.defaultRegion;
    return `https://s3.${region}.backblazeb2.com`;
  }
  if (preset.id === 'wasabi') {
    const region = (opts.region || preset.defaultRegion).trim() || preset.defaultRegion;
    return `https://s3.${region}.wasabisys.com`;
  }
  if (preset.id === 'spaces') {
    const region = (opts.region || preset.defaultRegion).trim() || preset.defaultRegion;
    return `https://${region}.digitaloceanspaces.com`;
  }
  return preset.defaultEndpoint;
};

/** Guess the preset from a stored endpoint so saved profiles open on the right tab. */
export const guessPreset = (endpoint?: string | null): S3ProviderId => {
  if (!endpoint) return 'aws';
  const host = endpoint.toLowerCase();
  if (host.includes('r2.cloudflarestorage.com')) return 'r2';
  if (host.includes('backblazeb2.com')) return 'b2';
  if (host.includes('wasabisys.com')) return 'wasabi';
  if (host.includes('digitaloceanspaces.com')) return 'spaces';
  if (host.includes('localhost') || host.includes('127.0.0.1') || host.includes(':9000')) return 'minio';
  if (host.includes('amazonaws.com')) return 'aws';
  return 'custom';
};
