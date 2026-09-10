import React from "react";

export type SvgIconProps = {
  /** Icon size in px; `"inherit"` follows the surrounding font size like MUI's `fontSize="inherit"`. */
  size?: number | "inherit";
  /** Accessible name; icons without one are decorative and hidden from assistive technology. */
  title?: string;
} & Omit<React.SVGProps<SVGSVGElement>, "width" | "height">;

/**
 * Renders a Material Design icon path (24x24 viewBox) with `currentColor`, which is all the UI
 * ever used from `@mui/icons-material` — pulling that package in cost the whole `@mui/material`
 * SvgIcon/emotion stack in the bundle. Path data is from Material Icons (Apache 2.0).
 */
export const SvgIcon = ({
  size = 24,
  title,
  path,
  ...svgProps
}: SvgIconProps & { path: string }) => (
  <svg
    width={size === "inherit" ? "1em" : size}
    height={size === "inherit" ? "1em" : size}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden={title ? undefined : true}
    role={title ? "img" : undefined}
    {...svgProps}
  >
    {title ? <title>{title}</title> : null}
    <path d={path} />
  </svg>
);

const material = (path: string) => {
  const Icon = (props: SvgIconProps) => <SvgIcon path={path} {...props} />;
  return Icon;
};

export const MoreVertIcon = material(
  "M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2m0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2m0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2"
);
export const FileDownloadIcon = material("M19 9h-4V3H9v6H5l7 7zM5 18v2h14v-2z");
export const ArrowBackIcon = material("M17.77 3.77 16 2 6 12l10 10 1.77-1.77L9.54 12z");
export const ArrowForwardIcon = material("M6.23 20.23 8 22l10-10L8 2 6.23 3.77 14.46 12z");
export const AppleIcon = material(
  "M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"
);
export const AndroidIcon = material(
  "m17.6 9.48 1.84-3.18c.16-.31.04-.69-.26-.85-.29-.15-.65-.06-.83.22l-1.88 3.24c-2.86-1.21-6.08-1.21-8.94 0L5.65 5.67c-.19-.29-.58-.38-.87-.2-.28.18-.37.54-.22.83L6.4 9.48C3.3 11.25 1.28 14.44 1 18h22c-.28-3.56-2.3-6.75-5.4-8.52M7 15.25c-.69 0-1.25-.56-1.25-1.25s.56-1.25 1.25-1.25 1.25.56 1.25 1.25-.56 1.25-1.25 1.25m10 0c-.69 0-1.25-.56-1.25-1.25s.56-1.25 1.25-1.25 1.25.56 1.25 1.25-.56 1.25-1.25 1.25"
);
export const DeleteIcon = material(
  "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"
);
export const PlayArrowIcon = material("M8 5v14l11-7z");
export const StopIcon = material("M6 6h12v12H6z");
