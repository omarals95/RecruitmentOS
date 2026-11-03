"use client";

import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "system";
const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (theme: Theme) => void;
}>({ theme: "system", setTheme: () => {} });
function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener("recruitmentos-theme", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("recruitmentos-theme", callback);
  };
}
function getSnapshot(): Theme {
  try {
    const saved = localStorage.getItem("recruitmentos.theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => "system" as Theme,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.style.colorScheme =
        document.documentElement.dataset.theme;
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);
  const setTheme = (value: Theme) => {
    try {
      localStorage.setItem("recruitmentos.theme", value);
      window.dispatchEvent(new Event("recruitmentos-theme"));
    } catch {
      document.documentElement.dataset.theme =
        value === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : value;
    }
  };
  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
export function useTheme() {
  return useContext(ThemeContext);
}
