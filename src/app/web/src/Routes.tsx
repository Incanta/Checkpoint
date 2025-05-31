// In this file, all Page components from 'src/pages` are auto-imported. Nested
// directories are supported, and should be uppercase. Each subdirectory will be
// prepended onto the component name.
//
// Examples:
//
// 'src/pages/HomePage/HomePage.js'         -> HomePage
// 'src/pages/Admin/BooksPage/BooksPage.js' -> AdminBooksPage

import { canHandleRoute, getRoutingComponent } from "supertokens-auth-react/ui";

import { Router, Route } from "@redwoodjs/router";

import { useAuth, PreBuiltUI } from "./authentication";
import ApiTokens from "./pages/ApiTokensPage/ApiTokensPage";

const Routes = () => {
  if (canHandleRoute(PreBuiltUI)) {
    return getRoutingComponent(PreBuiltUI);
  }

  return (
    <Router useAuth={useAuth}>
      <Route path="/" page={HomePage} name="home" />
      <Route path="/tokens" page={ApiTokens} name="api-tokens" />
      <Route notfound page={NotFoundPage} />
    </Router>
  );
};

export default Routes;
