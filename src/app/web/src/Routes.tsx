// Routes configuration using React Router
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { canHandleRoute, getRoutingComponent } from "supertokens-auth-react/ui";

import { useAuth, PreBuiltUI } from "./authentication";
import HomePage from "./pages/HomePage/HomePage";
import ApiTokensPage from "./pages/ApiTokensPage/ApiTokensPage";
import NotFoundPage from "./pages/NotFoundPage/NotFoundPage";

const AppRoutes = () => {
  const { isAuthenticated } = useAuth();

  // Handle SuperTokens authentication routes
  if (canHandleRoute(PreBuiltUI)) {
    return getRoutingComponent(PreBuiltUI);
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/tokens" element={<ApiTokensPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
};

export default AppRoutes;
