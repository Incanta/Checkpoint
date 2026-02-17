import React from "react";
import ReactDOM from "react-dom/client";
import { MemoryRouter as Router, Routes, Route } from "react-router";
import { Provider } from "jotai";
import { store } from "../common/state/store";
import "./index.css";
import "tailwindcss";
import Loading from "./pages/Loading/Loading";
import Welcome from "./pages/Welcome/Welcome";
import Login from "./pages/Login/Login";
import Dashboard from "./pages/Dashboard/Dashboard";
import Workspace from "./pages/Workspace/Workspace";
import FileHistory from "./components/FileHistory";
import ChangelistChanges from "./components/ChangelistChanges";

window.electron.ipcRenderer.on("set-renderer-url", (data: { url: string }) => {
  window.location.href = data.url;
});

const urlParams = new URLSearchParams(window.location.search);
const popoutType = urlParams.get("popout");

if (popoutType === "file-history") {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Provider store={store}>
        <FileHistory isPopout />
      </Provider>
    </React.StrictMode>,
  );
} else if (popoutType === "changelist-changes") {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Provider store={store}>
        <ChangelistChanges isPopout />
      </Provider>
    </React.StrictMode>,
  );
} else {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Provider store={store}>
        <Router>
          <Routes>
            <Route path="/" element={<Loading />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/welcome" element={<Welcome />} />
            <Route path="/login" element={<Login />} />
            <Route path="/workspace" element={<Workspace />} />
          </Routes>
        </Router>
      </Provider>
    </React.StrictMode>,
  );
}
