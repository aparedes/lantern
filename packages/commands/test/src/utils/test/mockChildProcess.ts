import * as childProcess from "child_process";
import { spyOn } from "bun:test";

const PROFILER_PATH = "/data/local/tmp/lantern-android-profiler";
export const MOCK_SERIAL = "emulator-5554";

/**
 * Stand-in for every synchronous `adb` call the Android profiler makes (`adb(...)` in
 * @lantern/android runs `execFileSync("adb", args)`). Calls bound to the resolved device carry
 * `-s <serial>` first; `adb devices -l` does not.
 */
const adbOutput = (args: readonly string[]): string => {
  const [maybeSerial, serial, ...rest] = args;
  const command = maybeSerial === "-s" ? rest : args;
  if (maybeSerial === "-s" && serial !== MOCK_SERIAL) {
    throw new Error(`adb: device '${serial}' not found`);
  }

  if (command[0] === "push" && command[2] === PROFILER_PATH) return "";

  switch (command.join(" ")) {
    case `shell ${PROFILER_PATH} printCpuClockTick`:
      return "100";
    case "shell dumpsys window windows":
      return "      mSurface=Surface(name=com.example/com.example.MainActivity$_21455)/@0x9110fea";
    case `shell ${PROFILER_PATH} printRAMPageSize`:
      return "4096";
    case "shell getprop ro.product.cpu.abi":
      return "arm64-v8a";
    case "shell getprop ro.build.version.sdk":
      return "30";
    case 'shell dumpsys display | grep -E "mRefreshRate|DisplayDeviceInfo"':
      return "fps=120";
    case "shell setprop debug.hwui.profile true":
    case "shell atrace --async_stop":
    case "shell pkill -INT screenrecord":
    case `shell chmod 755 ${PROFILER_PATH}`:
      return "";
    case "shell pm list packages -3":
      return "package:com.other\npackage:com.example\n";
    case "devices -l":
      return `List of devices attached\n${MOCK_SERIAL} device product:sdk model:Pixel_7 device:generic\n`;
    default:
      console.error(`Unknown command: adb ${args.join(" ")}`);
      return "";
  }
};

spyOn(require("child_process") as typeof childProcess, "execFileSync").mockImplementation(((
  file: string,
  args: readonly string[]
) => {
  if (file !== "adb") throw new Error(`Unexpected execFileSync(${file})`);
  return adbOutput(args);
}) as unknown as typeof childProcess.execFileSync);
