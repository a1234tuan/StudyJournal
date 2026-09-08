import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./App";
import { cleanupNativeServiceWorker } from "./lib/nativeServiceWorker";
import { isDesktopPlatform, isNativePlatform } from "./lib/platform";
import { ReviewCoachPreviewApp } from "./preview/ReviewCoachPreviewApp";
import { isVoiceRecallPrototypeRequest, VoiceRecallPrototypeApp } from "./preview/VoiceRecallPrototypeApp";
import { isUiV2PrototypeRequest, UiV2PrototypeApp } from "./preview/UiV2PrototypeApp";
import { isJournalPerformancePreviewRequest, isReviewCoachPreviewRequest, isStage3PreviewRequest, isStage4PreviewRequest, isStage5PreviewRequest, isStage6PreviewRequest, isStage7PreviewRequest, seedJournalPerformancePreview, seedStage3Preview, seedStage4Preview, seedStage5Preview, seedStage6Preview, seedStage7Preview } from "./preview/stage3PreviewSeed";
import "./styles.css";
import "./styles/theme.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/pages.css";
import "./styles/motion.css";
import "./styles/visual-v2.css";

const startApplication = async () => {
  if (isVoiceRecallPrototypeRequest()) {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <VoiceRecallPrototypeApp />
      </React.StrictMode>,
    );
    return;
  }
  if (isUiV2PrototypeRequest()) {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <UiV2PrototypeApp />
      </React.StrictMode>,
    );
    return;
  }
  const reviewCoachPreview = isReviewCoachPreviewRequest();
  if (reviewCoachPreview || isJournalPerformancePreviewRequest() || isStage3PreviewRequest() || isStage4PreviewRequest() || isStage5PreviewRequest() || isStage6PreviewRequest() || isStage7PreviewRequest()) {
    try {
      if (isJournalPerformancePreviewRequest()) await seedJournalPerformancePreview();
      else if (reviewCoachPreview || isStage7PreviewRequest()) await seedStage7Preview();
      else if (isStage6PreviewRequest()) await seedStage6Preview();
      else if (isStage5PreviewRequest()) await seedStage5Preview();
      else if (isStage4PreviewRequest()) await seedStage4Preview();
      else await seedStage3Preview();
    } catch (error) {
      console.error("Review coach preview data initialization failed", error);
    }
  }
  if (reviewCoachPreview) {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <ReviewCoachPreviewApp />
      </React.StrictMode>,
    );
    return;
  }
  if (isNativePlatform()) {
    const shouldReload = await cleanupNativeServiceWorker();
    if (shouldReload) {
      window.location.reload();
      return;
    }
  } else if (!isDesktopPlatform()) {
    registerSW({ immediate: true });
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
};

void startApplication();
