export type ConnectionState = 'NOT_CONNECTED' | 'CONNECTED' | 'TOKEN_EXPIRED' | 'TOKEN_REVOKED';

export const ConnectionStates = {
  NOT_CONNECTED: 'NOT_CONNECTED' as ConnectionState,
  CONNECTED: 'CONNECTED' as ConnectionState,
  TOKEN_EXPIRED: 'TOKEN_EXPIRED' as ConnectionState,
  TOKEN_REVOKED: 'TOKEN_REVOKED' as ConnectionState
} as const;

export interface DriveQuota {
  limit: number;
  used: number;
}

export interface ProfileInfo {
  email: string;
  name: string;
  picture: string;
  storage: DriveQuota;
}

export interface ProfileResponse {
  state: ConnectionState;
  profile?: ProfileInfo;
}
