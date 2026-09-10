import { AndroidIcon, AppleIcon } from "@lantern/web-reporter-ui";
import { Platform } from "@lantern/types";

export const platformLabel = (platform: Platform) => (platform === "ios" ? "iOS" : "Android");

export const PlatformIcon = ({ platform }: { platform: Platform }) =>
  platform === "ios" ? <AppleIcon /> : <AndroidIcon />;

export const PlatformBadge = ({ platform }: { platform: Platform }) => (
  <div
    className="flex flex-row items-center gap-1 text-neutral-300 pr-4"
    data-testid="platform-badge"
  >
    <PlatformIcon platform={platform} />
    <span className="font-bold">{platformLabel(platform)}</span>
  </div>
);
