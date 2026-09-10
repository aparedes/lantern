import { EventEmitter } from "events";
import { PassThrough } from "stream";
import * as childProcess from "child_process";
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { LogLevel, Logger } from "@lantern/logger";
import { ScreenRecorder } from "../ScreenRecorder";

Logger.setLogLevel(LogLevel.SILENT);

const SERIAL = "R58M12345Z";

/** Every `adb` argv run synchronously, in order: the call log the ordering assertions read. */
let adbCalls: string[][] = [];
/** How many more `pidof screenrecord` calls report the device process as still running. */
let screenrecordAlive = 0;

let recorderChild: EventEmitter & { stdout: PassThrough; kill: ReturnType<typeof jest.fn> };

spyOn(childProcess, "spawn").mockImplementation(((command: string, args: readonly string[]) => {
  expect([command, args.slice(0, 3)]).toEqual(["adb", ["-s", SERIAL, "shell"]]);
  expect(args).toContain("screenrecord");
  return recorderChild;
}) as unknown as typeof childProcess.spawn);

spyOn(childProcess, "execFileSync").mockImplementation(((file: string, args: readonly string[]) => {
  expect(file).toBe("adb");
  adbCalls.push([...args]);
  if (args.includes("pidof")) {
    return screenrecordAlive-- > 0 ? "4321\n" : "";
  }
  return "";
}) as unknown as typeof childProcess.execFileSync);

beforeEach(() => {
  adbCalls = [];
  screenrecordAlive = 0;
  const child = new EventEmitter() as typeof recorderChild;
  child.stdout = new PassThrough();
  child.kill = jest.fn();
  recorderChild = child;
});
afterAll(() => mock.restore());

/** A recorder whose device-side `screenrecord` has reported it is up. */
const startedRecorder = async () => {
  const recorder = new ScreenRecorder("video.mp4", SERIAL);
  const starting = recorder.startRecording();
  recorderChild.stdout.write("Content area is 1080x2400\n");
  await starting;
  return recorder;
};

/** The adb calls that matter to the finalization ordering, as verbs. */
const finalizationOrder = () =>
  adbCalls
    .map((args) => (args.includes("pkill") ? "pkill" : args.includes("pidof") ? "pidof" : args[2]))
    .filter((verb) => verb === "pkill" || verb === "pidof" || verb === "pull");

describe("ScreenRecorder", () => {
  it("waits for screenrecord to exit before pulling the file", async () => {
    const recorder = await startedRecorder();
    screenrecordAlive = 2;

    await recorder.stopRecording();
    await recorder.pullRecording("/tmp");

    expect(finalizationOrder()).toEqual(["pkill", "pidof", "pidof", "pidof", "pull"]);
    // `stopRecording` sleeps 5s first, to capture the end of the run
  }, 15000);

  it("still waits for finalization when dispose() already signalled screenrecord", async () => {
    const recorder = await startedRecorder();
    // What a failing test does: force-stop the session (which disposes the recorder), then stop
    // it gracefully to keep the video for debugging
    recorder.dispose();
    screenrecordAlive = 2;

    await recorder.stopRecording();
    await recorder.pullRecording("/tmp");

    // No second pkill (dispose sent it), but the file is only pulled once the device is done
    expect(finalizationOrder()).toEqual(["pkill", "pidof", "pidof", "pidof", "pull"]);
  });

  it("does nothing when the recording was never started", async () => {
    const recorder = new ScreenRecorder("video.mp4", SERIAL);
    await recorder.stopRecording();
    expect(adbCalls).toEqual([]);
  });
});
