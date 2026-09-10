import {
  Button,
  DeleteIcon,
  setThemeAtRandom,
  IterationsReporterView,
  getThemeColorPalette,
} from "@lantern/web-reporter-ui";
import { useEffect } from "react";

import { BundleIdSelector } from "./components/BundleIdSelector";
import { StartButton } from "./components/StartButton";
import { AppBar } from "./components/AppBar";
import { useMeasures } from "./useMeasures";
import { SocketState } from "./components/SocketState";
import { PlatformBadge, platformLabel } from "./components/PlatformBadge";

setThemeAtRandom();

export const MeasureWebApp = () => {
  const {
    autodetect,
    bundleId,
    start,
    stop,
    results,
    isMeasuring,
    reset,
    setBundleId,
    platform,
    apps,
    refreshApps,
  } = useMeasures();

  useEffect(() => {
    document.title = `Lantern · ${platformLabel(platform)}`;
  }, [platform]);

  return (
    <div className="bg-light-charcoal h-full text-black">
      <SocketState />
      <AppBar>
        <PlatformBadge platform={platform} />
        <BundleIdSelector
          autodetect={autodetect}
          bundleId={bundleId}
          onChange={setBundleId}
          apps={apps}
          platform={platform}
          refreshApps={refreshApps}
        />
        {bundleId ? (
          <div className="flex flex-row gap-2">
            <StartButton start={start} stop={stop} isMeasuring={isMeasuring} />
            {/* It's assumed that the color palette is fixed randomly by setThemeAtRandom
             and is an array of >= 4 colors */}
            <div data-theme={getThemeColorPalette()[1]}>
              <Button onClick={reset} icon={<DeleteIcon />}>
                Reset
              </Button>
            </div>
          </div>
        ) : null}
      </AppBar>
      <IterationsReporterView results={results} />
    </div>
  );
};
