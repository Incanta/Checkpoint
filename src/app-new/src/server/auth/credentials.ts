import config from "@incanta/config";
import { pbkdf2 } from "crypto";

export async function computePasswordHash(
  password: string,
  salt: string
): Promise<string> {
  const hash = await new Promise<string>((resolve, reject) => {
    pbkdf2(
      password,
      salt,
      config.get<number>("auth.credentials.hash.iterations"),
      config.get<number>("auth.credentials.hash.length"),
      "sha512",
      (err, derivedKey) => {
        if (err) {
          reject(err);
        } else {
          resolve(derivedKey.toString("hex"));
        }
      }
    );
  });

  return hash;
}
