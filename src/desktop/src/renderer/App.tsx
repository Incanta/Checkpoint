import { MemoryRouter as Router, Routes, Route } from "react-router-dom";
import React from "react";
import "./App.css";
import { Provider } from "jotai";
import { store } from "../common/state/store";
import Loading from "./pages/Loading/Loading";

export default function App(): React.ReactElement {
  return (
    <Router>
      <Provider store={store}>
        <Routes>
          <Route path="/" element={<Loading />} />
        </Routes>
      </Provider>
    </Router>
  );
}
