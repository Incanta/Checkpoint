import SuperTokens, { SuperTokensWrapper } from "supertokens-auth-react";
import Session from "supertokens-auth-react/recipe/session";
import ThirdPartyEmailPassword from "supertokens-auth-react/recipe/thirdpartyemailpassword";
import { ThirdPartyEmailPasswordPreBuiltUI } from "supertokens-auth-react/recipe/thirdpartyemailpassword/prebuiltui";
import { createContext, useContext, useEffect, useState, ReactNode } from "react";

const websiteDomain = process.env.SUPERTOKENS_WEBSITE_DOMAIN;
const apiDomain = process.env.SUPERTOKENS_API_DOMAIN || websiteDomain;
const apiGatewayPath = process.env.SUPERTOKENS_API_GATEWAY_PATH || "/auth";

export const PreBuiltUI = [ThirdPartyEmailPasswordPreBuiltUI];

// Initialize SuperTokens only in browser
if (typeof window !== 'undefined') {
  SuperTokens.init({
    appInfo: {
      appName: process.env.SUPERTOKENS_APP_NAME || 'Checkpoint VCS',
      apiDomain: apiDomain || 'http://localhost:8911',
      websiteDomain: websiteDomain || 'http://localhost:8910',
      apiGatewayPath,
      websiteBasePath: "/auth",
      apiBasePath: "/auth",
    },
    recipeList: [Session.init(), ThirdPartyEmailPassword.init()],
  });
}

// Auth context
interface AuthContextType {
  isAuthenticated: boolean;
  currentUser: any;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  isAuthenticated: false,
  currentUser: null,
  loading: true,
  signOut: async () => {},
});

interface AuthProviderProps {
  children: ReactNode;
}

const CustomAuthProvider = ({ children }: AuthProviderProps) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const sessionExists = await Session.doesSessionExist();
        setIsAuthenticated(sessionExists);
        
        if (sessionExists) {
          // You can fetch user data here if needed
          // const userInfo = await Session.getAccessTokenPayloadSecurely();
          // setCurrentUser(userInfo);
        }
      } catch (error) {
        console.error('Auth check failed:', error);
        setIsAuthenticated(false);
        setCurrentUser(null);
      } finally {
        setLoading(false);
      }
    };

    checkAuth();
  }, []);

  const signOut = async () => {
    try {
      await Session.signOut();
      setIsAuthenticated(false);
      setCurrentUser(null);
    } catch (error) {
      console.error('Sign out failed:', error);
    }
  };

  return (
    <AuthContext.Provider value={{ 
      isAuthenticated, 
      currentUser, 
      loading, 
      signOut 
    }}>
      {children}
    </AuthContext.Provider>
  );
};

const AuthProvider = ({ children }: AuthProviderProps) => {
  return (
    <SuperTokensWrapper>
      <CustomAuthProvider>{children}</CustomAuthProvider>
    </SuperTokensWrapper>
  );
};

const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export { AuthProvider, useAuth };
