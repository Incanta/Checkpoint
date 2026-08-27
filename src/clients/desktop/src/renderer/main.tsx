import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import {
  MemoryRouter as Router,
  Routes,
  Route,
  useNavigate,
} from "react-router";
import { Provider } from "jotai";
import { store } from "../common/state/store";
import { ThemeProvider } from "./theme";
import "./index.css";
import "file-icon-vectors/dist/file-icon-square-o.min.css";
import Loading from "./pages/Loading/Loading";
import Login from "./pages/Login/Login";
import Dashboard from "./pages/Dashboard/Dashboard";
import Workspace from "./pages/Workspace/Workspace";
import TeamSync from "./pages/TeamSync/TeamSync";
import FileHistory from "./components/FileHistory";
import ChangelistChanges from "./components/ChangelistChanges";
import UpdateNotification from "./components/UpdateNotification";
import VersionNotification from "./components/VersionNotification";
import ServerStatusBanner from "./components/ServerStatusBanner";

// Bridges main-process navigation requests into react-router. The app uses a
// MemoryRouter, so we must navigate via the router rather than mutating
// window.location. In the packaged app the renderer is loaded over file://,
// where setting window.location.href = "/workspace" resolves to
// file:///C:/workspace, 404s, and blanks the window (white screen).
function RendererUrlListener(): null {
  const navigate = useNavigate();

  useEffect(() => {
    return window.electron.ipcRenderer.on("set-renderer-url", (data) => {
      navigate(data.url);
    });
  }, [navigate]);

  return null;
}

const urlParams = new URLSearchParams(window.location.search);
const popoutType = urlParams.get("popout");

if (popoutType === "file-history") {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Provider store={store}>
        <ThemeProvider>
          <FileHistory isPopout />
        </ThemeProvider>
      </Provider>
    </React.StrictMode>,
  );
} else if (popoutType === "changelist-changes") {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Provider store={store}>
        <ThemeProvider>
          <ChangelistChanges isPopout />
        </ThemeProvider>
      </Provider>
    </React.StrictMode>,
  );
} else {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Provider store={store}>
        <ThemeProvider>
          <Router>
            <RendererUrlListener />
            <Routes>
              <Route path="/" element={<Loading />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/login" element={<Login />} />
              <Route path="/workspace" element={<Workspace />} />
              <Route path="/team-sync" element={<TeamSync />} />
            </Routes>
            <UpdateNotification />
            <VersionNotification />
            <ServerStatusBanner />
          </Router>
        </ThemeProvider>
      </Provider>
    </React.StrictMode>,
  );
}
