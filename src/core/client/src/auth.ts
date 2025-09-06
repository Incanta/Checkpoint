import config from "@incanta/config";
import {
  CreateApiClient,
  SaveAuthToken
} from "@checkpointvcs/common";
import open from "open";

export async function AuthenticateDevice(onCodeForDisplay: (code: string) => void): Promise<void> {
  const client = await CreateApiClient();

  const deviceCodeResponse = await client.apiToken.getCode.query();

  if (!deviceCodeResponse) {
    throw new Error("Failed to get device code");
  }

  const { code } = deviceCodeResponse;

  onCodeForDisplay(code);

  await open(`${config.get<string>("checkpoint.host")}/devices?${code}`);

  let apiToken: string;
  while (true) {
    try {
      const apiTokenResponse = await client.apiToken.getApiToken.query({
        code,
      });

      apiToken = apiTokenResponse.apiToken;
      break;
    } catch (error) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      continue;
    }
  }

  await SaveAuthToken(apiToken);
}
