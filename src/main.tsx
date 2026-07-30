import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import OnboardingApp from "./OnboardingApp";
import "./styles.css";

const rendererWindow = new URLSearchParams(window.location.search).get(
  "window",
);
const RootApp = rendererWindow === "onboarding" ? OnboardingApp : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootApp />
  </StrictMode>,
);
