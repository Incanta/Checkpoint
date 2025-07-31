import type { ReactNode } from "react";

import { FatalErrorBoundary, RedwoodProvider } from "@redwoodjs/web";

import FatalErrorPage from "src/pages/FatalErrorPage";
import { TRPCProvider } from "src/components/TRPCProvider";

import { AuthProvider } from "./authentication";

import "./index.css";

interface AppProps {
  children?: ReactNode;
}

const App = ({ children }: AppProps) => (
  <FatalErrorBoundary page={FatalErrorPage}>
    <RedwoodProvider titleTemplate="%PageTitle | %AppTitle">
      <AuthProvider>
        <TRPCProvider>
          {children}
        </TRPCProvider>
      </AuthProvider>
    </RedwoodProvider>
  </FatalErrorBoundary>
);

export default App;
