import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { styled, alpha } from "@mui/material/styles";
import InputBase from "@mui/material/InputBase";
import Autocomplete from "@mui/material/Autocomplete";
import { AppInfo, Platform } from "@lantern/types";
import { PlatformIcon } from "./PlatformBadge";

/**
 * Every bundle id change is sent to the CLI, which answers with the whole measure state. Emitting
 * on each keystroke would broadcast that state — results included — as fast as the user types.
 */
const BUNDLE_ID_EMIT_DEBOUNCE_MS = 150;

const Search = styled("div")(({ theme }) => ({
  position: "relative",
  borderRadius: theme.shape.borderRadius,
  backgroundColor: alpha(theme.palette.common.white, 0.15),
  "&:hover": {
    backgroundColor: alpha(theme.palette.common.white, 0.25),
  },
  marginLeft: 0,
  // Wide enough for the placeholder and a typical reverse-DNS bundle id
  width: 400,
}));

const SearchIconWrapper = styled("div")(() => ({
  paddingLeft: 10,
  paddingRight: 10,
  height: "100%",
  position: "absolute",
  pointerEvents: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
}));

const StyledInputBase = styled(InputBase)(({ theme }) => ({
  color: "inherit",
  // The rest of the page uses Tailwind's system font stack; MUI would default to Roboto
  fontFamily: "inherit",
  "& .MuiInputBase-input": {
    padding: 10,
    // vertical padding + font size from searchIcon
    paddingLeft: 45,
    transition: theme.transitions.create("width"),
    // The Autocomplete sizes its input with `flex-grow: 1` inside the (full width) root, so
    // the visible text must not be clipped by an ellipsis of our own
    textOverflow: "ellipsis",
  },
}));

/**
 * Keeps the typed text local and emits it debounced. The `value` prop is adopted when it changes
 * for another reason than our own emits (auto-detect, a reset…): the CLI echoes every emitted id
 * back through the state, and an echo can lag behind what has been typed — and emitted — since,
 * so every emit not echoed back yet is remembered and its echo ignored, whichever order they
 * come back in.
 */
const useDebouncedBundleId = (value: string, onChange: (bundleId: string) => void) => {
  const [inputValue, setInputValue] = useState(value);
  const outstandingEmitsRef = useRef(new Set<string>());
  const pendingEmitRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingEmit = () => {
    if (pendingEmitRef.current !== null) {
      clearTimeout(pendingEmitRef.current);
      pendingEmitRef.current = null;
    }
  };

  useEffect(() => {
    // The echo of one of our own emits: the input is already at or past it
    if (outstandingEmitsRef.current.delete(value)) return;

    // Changed for another reason: the CLI state has moved past whatever we emitted
    outstandingEmitsRef.current.clear();
    cancelPendingEmit();
    setInputValue(value);
  }, [value]);

  useEffect(() => cancelPendingEmit, []);

  const handleInputChange = (newValue: string) => {
    setInputValue(newValue);

    cancelPendingEmit();
    pendingEmitRef.current = setTimeout(() => {
      pendingEmitRef.current = null;
      outstandingEmitsRef.current.add(newValue);
      onChange(newValue);
    }, BUNDLE_ID_EMIT_DEBOUNCE_MS);
  };

  return { inputValue, handleInputChange };
};

export const AppPicker = ({
  apps,
  platform,
  value,
  onChange,
  onOpen,
}: {
  apps: AppInfo[];
  platform: Platform;
  value: string;
  onChange: (bundleId: string) => void;
  onOpen: () => void;
}) => {
  const { inputValue, handleInputChange } = useDebouncedBundleId(value, onChange);

  return (
    <Search>
      <SearchIconWrapper>
        <PlatformIcon platform={platform} />
      </SearchIconWrapper>
      <Autocomplete
        // Explicit id: MUI falls back to React's `useId`, whose counter depends on how many
        // components rendered before it in the process — which makes the DOM snapshot test
        // order-dependent.
        id="bundle-id-picker"
        freeSolo
        options={apps}
        getOptionLabel={(option) => (typeof option === "string" ? option : option.bundleId)}
        inputValue={inputValue}
        onInputChange={(_, newValue) => handleInputChange(newValue)}
        onOpen={onOpen}
        slotProps={{
          // The list is anchored to the search box but must not be squeezed to its width: a
          // bundle id plus its app name is wider than the box
          popper: { style: { width: "auto" }, placement: "bottom-start" },
          paper: { sx: { fontFamily: "inherit", minWidth: 300, maxWidth: "80vw" } },
        }}
        renderOption={(props, option) => (
          <li {...props} key={option.bundleId} className={`${props.className} whitespace-nowrap`}>
            <span>{option.name}</span>
            <span className="text-neutral-500 ml-2">{option.bundleId}</span>
            {option.isRunning ? <span className="ml-2 text-success">● running</span> : null}
          </li>
        )}
        renderInput={(params) => (
          <StyledInputBase
            ref={params.slotProps.input.ref}
            className={params.slotProps.input.className}
            // Without it the root keeps its intrinsic width and the input shrinks to MUI's
            // 30px minimum, clipping the bundle id (and the list anchored to the root)
            fullWidth={params.fullWidth}
            endAdornment={params.slotProps.input.endAdornment}
            inputProps={params.slotProps.htmlInput}
            placeholder="Bundle id — type or pick an installed app"
          />
        )}
      />
    </Search>
  );
};
