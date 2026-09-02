import React, { useEffect, useState } from "react";
import { Logger } from "@lantern/logger";
import { socket } from "../socket";
import { useLogSocketEvents } from "../../common/useLogSocketEvents";
import { SocketEvents } from "../../socket/socketInterface";

const useSocketState = (onError: (error: string) => void) => {
  useLogSocketEvents(socket);
  const [isConnected, setIsConnected] = useState(socket.connected);

  useEffect(() => {
    function onConnect() {
      setIsConnected(true);
    }

    function onDisconnect(reason: string) {
      setIsConnected(false);

      Logger.info(`socket disconnected with reason: ${reason}`);

      if (reason === "transport close" || reason === "transport error") {
        onError("lantern CLI command exited. Restart from the CLI.");
      }
    }

    socket.on(SocketEvents.CONNECT, onConnect);
    socket.on(SocketEvents.DISCONNECT, onDisconnect);
    socket.on(SocketEvents.SEND_ERROR, onError);

    return () => {
      socket.off(SocketEvents.CONNECT, onConnect);
      socket.off(SocketEvents.DISCONNECT, onDisconnect);
      socket.off(SocketEvents.SEND_ERROR, onError);
    };
  }, [onError]);

  useEffect(() => {
    return () => {
      socket.close();
    };
  }, []);

  return { isConnected };
};

const ErrorDialog = ({ message, onClose }: { message: string; onClose: () => void }) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    // The backdrop closes the dialog; clicks inside the panel must not bubble up to it
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="alert-dialog-title"
        aria-describedby="alert-dialog-description"
        onClick={(event) => event.stopPropagation()}
        className="max-w-lg rounded bg-white p-6 text-black shadow-xl"
      >
        <h2 id="alert-dialog-title" className="text-xl font-medium">
          🚨 Woups, something happened
        </h2>
        <p id="alert-dialog-description" className="mt-4 text-neutral-600">
          {message}
        </p>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className="rounded px-4 py-2 font-medium uppercase text-light-sky-blue hover:bg-light-sky-blue/10"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export const SocketState = () => {
  const [error, setError] = React.useState<string | null>(null);
  const closeModal = () => setError(null);
  useSocketState(setError);

  return error !== null ? <ErrorDialog message={error} onClose={closeModal} /> : null;
};
