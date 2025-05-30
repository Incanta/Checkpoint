import SuperTokens, { SuperTokensWrapper } from "supertokens-auth-react";
import Session from "supertokens-auth-react/recipe/session";
import ThirdPartyEmailPassword from "supertokens-auth-react/recipe/thirdpartyemailpassword";
import { ThirdPartyEmailPasswordPreBuiltUI } from "supertokens-auth-react/recipe/thirdpartyemailpassword/prebuiltui";

import { createAuth } from "@redwoodjs/auth-supertokens-web";
import { isBrowser } from "@redwoodjs/prerender/browserUtils";

const websiteDomain =
  // @ts-ignore
  process.env.SUPERTOKENS_WEBSITE_DOMAIN;
// @ts-ignore
const apiDomain = process.env.SUPERTOKENS_API_DOMAIN || websiteDomain;
const apiGatewayPath =
  // @ts-ignore
  process.env.SUPERTOKENS_API_GATEWAY_PATH || "/.redwood/functions";

const superTokensClient = {
  sessionRecipe: Session,
  redirectToAuth: SuperTokens.redirectToAuth,
};

export const PreBuiltUI = [ThirdPartyEmailPasswordPreBuiltUI];

isBrowser &&
  SuperTokens.init({
    appInfo: {
      // @ts-ignore
      appName: process.env.SUPERTOKENS_APP_NAME,
      apiDomain,
      websiteDomain,
      apiGatewayPath,
      websiteBasePath: "/auth",
      apiBasePath: "/auth",
    },
    // useShadowDom: true,
    recipeList: [Session.init(), ThirdPartyEmailPassword.init()],
  });

const { AuthProvider: SuperTokensAuthProvider, useAuth } =
  createAuth(superTokensClient);

interface Props {
  children: React.ReactNode;
}

const AuthProvider = ({ children }: Props) => {
  return (
    <SuperTokensWrapper>
      <SuperTokensAuthProvider>{children}</SuperTokensAuthProvider>
    </SuperTokensWrapper>
  );
};

export { AuthProvider, useAuth };
