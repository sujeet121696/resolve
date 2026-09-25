import { NavLink, Outlet, useLocation } from "react-router-dom";
import ElevenLabsWidget from "./components/ElevenLabsWidget";
import ThemeToggle from "./components/ThemeToggle";

export default function App() {
  // The Chat page hosts the Freshworks widget in the same bottom-right corner as
  // the voice bubble, so the voice bubble steps aside there (Home keeps it).
  const onChatPage = useLocation().pathname.startsWith("/chat");
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
          <NavLink to="/costs">Costs</NavLink>
          <NavLink to="/admin">Admin</NavLink>
        </nav>
        <ThemeToggle />
      </header>
      <Outlet />
      {!onChatPage && <ElevenLabsWidget />}
    </div>
  );
}
