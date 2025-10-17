import React from "react";
import ReactDOM from "react-dom/client";
import { MemoryRouter as Router, Routes, Route } from "react-router-dom";
import { Provider } from "jotai";
import { store } from "../common/state/store";
import "./index.css";
import "tailwindcss";
import Loading from "./pages/Loading/Loading";
import Welcome from "./pages/Welcome/Welcome";
import Login from "./pages/Login/Login";
import Dashboard from "./pages/Dashboard/Dashboard";
import Workspace from "./pages/Workspace/Workspace";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Provider store={store}>
      <Router>
        <Routes>
          <Route path="/" element={<Loading />} />
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/workspace" element={<Workspace />} />
        </Routes>
      </Router>
    </Provider>
  </React.StrictMode>,
);
