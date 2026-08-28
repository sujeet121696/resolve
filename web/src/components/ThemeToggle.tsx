import { useEffect, useState } from "react";

type Mode = "system" | "light" | "dark";

const STORAGE_KEY = "resolve-theme";
const MODES: { mode: Mode; icon: string; label: string }[] = [
  { mode: "system", icon: "◐", label: "Follow system theme" },
  { mode: "light", icon: "☀", label: "Light theme" },
  { mode: "dark", icon: "🌙", label: "Dark theme" },
];

function apply(mode: Mode) {
  const dark =
    mode === "dark" ||
    (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export default function ThemeToggle() {
  const [mode, setMode] = useState<Mode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  });

  useEffect(() => {
    apply(mode);
    localStorage.setItem(STORAGE_KEY, mode);
    if (mode !== "system") return;
    // In system mode, re-apply live when the OS theme flips.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [mode]);

  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {MODES.map(({ mode: m, icon, label }) => (
        <button
          key={m}
          type="button"
          className={mode === m ? "active" : ""}
          title={label}
          aria-label={label}
          onClick={() => setMode(m)}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
