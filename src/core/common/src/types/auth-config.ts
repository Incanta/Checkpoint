export interface AuthConfigUser {
  endpoint: string;
  apiToken: string | null;
}

export interface AuthConfig {
  users: Record<string, AuthConfigUser>;
}
