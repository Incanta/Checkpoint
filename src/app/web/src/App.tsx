import type { ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";

import FatalErrorPage from "src/pages/FatalErrorPage";
import { TRPCProvider } from "src/components/TRPCProvider";

import { AuthProvider } from "./authentication";

import "./index.css";

interface AppProps {
  children?: ReactNode;
}

function ErrorFallback({ error }: { error: Error }) {
  return <FatalErrorPage error={error} />;
}

const App = ({ children }: AppProps) => (
  <ErrorBoundary FallbackComponent={ErrorFallback}>
    <AuthProvider>
      <TRPCProvider>
        {children}
      </TRPCProvider>
    </AuthProvider>
  </ErrorBoundary>
);

export default App;
