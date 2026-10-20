import config from "@incanta/config";

/**
 * Which of Checkpoint's own sign-in methods auth.yaml turns on. Kept apart
 * from auth/config.ts so access checks can read them without building the
 * better-auth instance.
 */
export function emailPasswordEnabled(): boolean {
  return config.get<boolean>("auth.email-password.enabled");
}

export function passkeysEnabled(): boolean {
  return (
    emailPasswordEnabled() &&
    config.get<boolean>("auth.email-password.passkeys")
  );
}
