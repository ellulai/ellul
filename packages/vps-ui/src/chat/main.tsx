// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initTheme } from "@shared/theme";
import { IntlRoot } from "@shared/i18n/IntlRoot";
import { WelcomeOverlay } from "@shared/WelcomeOverlay";
import { LocaleMismatchBanner } from "@shared/LocaleMismatchBanner";
import "./styles.css";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IntlRoot>
      <App />
      <LocaleMismatchBanner />
      <WelcomeOverlay />
    </IntlRoot>
  </StrictMode>
);
