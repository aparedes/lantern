import React, { FunctionComponent, useEffect, useRef } from "react";
import { MoreVertIcon } from "./icons/SvgIcon";

export type MenuOption = {
  label: string;
  icon: React.JSX.Element;
  onClick: () => void;
};

type HeaderProps = {
  menuOptions: MenuOption[];
};

export const Header: FunctionComponent<HeaderProps> = ({ menuOptions }) => {
  const [open, setOpen] = React.useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // A click anywhere else, or Escape, dismisses the menu — what a modal popover did for us before.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (menuOptions.length === 0) {
    return null;
  }

  return (
    <div ref={containerRef} className="relative float-right">
      <button
        type="button"
        id="report-menu-button"
        aria-controls={open ? "report-menu" : undefined}
        aria-haspopup="true"
        aria-expanded={open ? "true" : undefined}
        aria-label="Report menu"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="p-2 m-1 rounded-full text-neutral-300 hover:bg-white/10"
      >
        <MoreVertIcon />
      </button>
      {open ? (
        <ul
          id="report-menu"
          role="menu"
          aria-labelledby="report-menu-button"
          className="absolute right-1 top-1 z-50 min-w-48 py-2 rounded bg-white text-black shadow-lg"
        >
          {menuOptions.map((option: MenuOption) => (
            <li key={option.label} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  option.onClick();
                  setOpen(false);
                }}
                className="flex items-center gap-3 w-full px-4 py-1.5 text-left hover:bg-black/5"
              >
                <span className="text-neutral-600">{option.icon}</span>
                <span>{option.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};
