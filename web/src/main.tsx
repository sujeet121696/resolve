import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import Home from "./pages/Home";
import Chat from "./pages/Chat";
import Ops from "./pages/Ops";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename="/app">
      <Routes>
        <Route element={<App />}>
          <Route index element={<Home />} />
          <Route path="chat" element={<Chat />} />
          <Route path="ops" element={<Ops />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
