import * as Session from "supertokens-node/recipe/session"
import ThirdPartyEmailPassword from "supertokens-node/recipe/thirdpartyemailpassword"
import type { TypeInput } from "supertokens-node/types"

const websiteDomain = process.env.SUPERTOKENS_WEBSITE_DOMAIN || 'http://localhost:8910';
const apiDomain = process.env.SUPERTOKENS_API_DOMAIN || 'http://localhost:8911';
const apiGatewayPath = process.env.SUPERTOKENS_API_GATEWAY_PATH || "/auth";

export const config: TypeInput = {
  framework: "express",
  isInServerlessEnv: false,
  appInfo: {
    appName: process.env.SUPERTOKENS_APP_NAME || 'Checkpoint VCS',
    apiDomain,
    websiteDomain,
    apiGatewayPath,
    websiteBasePath: "/auth",
    apiBasePath: "/auth",
  },
  supertokens: {
    connectionURI: process.env.SUPERTOKENS_CONNECTION_URI || 'https://try.supertokens.com',
    apiKey: process.env.SUPERTOKENS_API_KEY,
  },
  recipeList: [
    ThirdPartyEmailPassword.init(),
    Session.init({
      getTokenTransferMethod: () => {
        return "header"
      },
    }),
  ],
}
