/**
 * A cached snapshot of the user's profile, saved after a successful `me`
 * lookup so the desktop app can still render the account (and decide where to
 * route on launch) when the remote server is temporarily unreachable.
 */
export interface AuthConfigUserProfile {
  id: string;
  email: string;
  name: string | null;
  username: string | null;
  image: string | null;
}

export interface AuthConfigUser {
  endpoint: string;
  apiToken: string | null;
  /**
   * Optional display name the user gave this account, so two accounts for the
   * same person (or the same email on two servers) can be told apart.
   */
  label?: string | null;
  /**
   * Last-known profile for this account. Optional because it's only populated
   * once we've successfully reached the server at least once.
   */
  profile?: AuthConfigUserProfile | null;
}

export interface AuthConfig {
  users: Record<string, AuthConfigUser>;
}
