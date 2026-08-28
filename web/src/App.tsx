import { NavLink, Outlet } from "react-router-dom";
import ElevenLabsWidget from "./components/ElevenLabsWidget";
import ThemeToggle from "./components/ThemeToggle";

export default function App() {
  return (
    <div className="app">
      <header className="nav">
        <NavLink to="/" className="brand">
          Resolve 🎙️💸
        </NavLink>
        <nav>
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/chat">Chat</NavLink>
          <NavLink to="/ops">Ops</NavLink>
        </nav>
        <ThemeToggle />
      </header>
      <Outlet />
      <ElevenLabsWidget />
    </div>
  );
}
