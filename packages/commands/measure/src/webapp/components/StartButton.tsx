import { Button, PlayArrowIcon, StopIcon } from "@lantern/web-reporter-ui";

export const StartButton = ({
  isMeasuring,
  start,
  stop,
}: {
  isMeasuring: boolean;
  start: () => void;
  stop: () => void;
}) =>
  isMeasuring ? (
    <Button onClick={stop} icon={<StopIcon />}>
      Stop Measuring
    </Button>
  ) : (
    <Button onClick={start} icon={<PlayArrowIcon />}>
      Start Measuring
    </Button>
  );
