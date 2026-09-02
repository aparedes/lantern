import { open } from "@lantern/shell";
import { useEffect, useState } from "react";
import type { SocketType } from "../socket/socketInterface";
import { HostAndPortInfo } from "./components/HostAndPortInfo";
import { getWebAppUrl } from "./constants";
import { ServerSocketConnectionApp } from "./ServerSocketConnectionApp";
import { getInk, loadInk } from "./ink";
import { disposeAllSessions, getPlatform, profiler } from "@lantern/profiler";
import { createWebAppServer } from "./webAppServer";

const useCleanupOnManualExit = () => {
  const { useInput } = getInk();

  // `exitOnCtrlC` is off (see `runServerApp`), so Ctrl-C reaches us as `c` + `key.ctrl`. A bare
  // `c` keypress must not kill the CLI.
  useInput((input, key) => {
    if (input === "q" || (input === "c" && key.ctrl)) {
      // Ink's raw mode swallows the SIGINT that `installSignalHandlers` would otherwise get
      disposeAllSessions();
      profiler.dispose();
      process.exit();
    }
  });
};

const isAddressInUse = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code: unknown }).code === "EADDRINUSE";

export const getServerErrorMessage = (error: unknown, port: number): string =>
  isAddressInUse(error)
    ? `Port ${port} is already in use. Stop the process using it, or pick another port with --port <port>.`
    : `Could not start the web app server: ${error instanceof Error ? error.message : String(error)}`;

const ServerError = ({ message }: { message: string }) => {
  const { Box, Text } = getInk();

  return (
    <Box padding={1} flexDirection="column">
      <Text color="red">{message}</Text>
      <Text dimColor>Press q to quit.</Text>
    </Box>
  );
};

interface ServerAppProps {
  port: number;
}

export const ServerApp = ({ port }: ServerAppProps) => {
  const [socket, setSocket] = useState<SocketType | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const webAppUrl = getWebAppUrl(port);
  useEffect(() => {
    // `Bun.serve` throws synchronously when it cannot listen (typically `EADDRINUSE`): surface
    // that as a readable message instead of letting it take Ink down with a stack trace.
    let server: ReturnType<typeof createWebAppServer>;
    try {
      server = createWebAppServer({ port, onConnection: setSocket });
    } catch (error) {
      setServerError(getServerErrorMessage(error, port));
      return;
    }
    setServerError(null);

    // `Bun.serve` is listening as soon as it returns, so the browser can be opened right away.
    open(webAppUrl);

    return () => {
      // `true` closes the active WebSocket too, which the web app reports as a disconnection.
      server.stop(true);
    };
  }, [port, webAppUrl]);
  useCleanupOnManualExit();

  if (serverError) return <ServerError message={serverError} />;

  return socket ? (
    <ServerSocketConnectionApp socket={socket} url={webAppUrl} />
  ) : (
    <HostAndPortInfo url={webAppUrl} platform={getPlatform()} />
  );
};

export const runServerApp = async (port: number) => {
  const { render } = await loadInk();

  render(
    <ServerApp port={port} />,
    // handle it ourselves in the profiler to kill child processes thanks to useCleanupOnManualExit
    { exitOnCtrlC: false }
  );
};
