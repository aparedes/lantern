import { Command } from "commander";
import { printResult, registerJsonOption } from "@lantern/cli-core";
import { CheckStatus, DoctorReport, runDoctor } from "@lantern/profiler";

const STATUS_ICONS: Record<CheckStatus, string> = { ok: "✔", warn: "⚠", fail: "✖", skip: "–" };

export const formatDoctorReport = ({ ready, checks }: DoctorReport) => {
  const lines = checks.flatMap(({ platform, status, message, fix }) => [
    `${STATUS_ICONS[status]} ${platform.padEnd(8)} ${message}`,
    ...(fix && status !== "ok" ? [`  → ${fix}`] : []),
  ]);
  const readyPlatforms = (Object.keys(ready) as (keyof typeof ready)[]).filter((key) => ready[key]);
  lines.push(
    "",
    readyPlatforms.length > 0
      ? `Ready to profile: ${readyPlatforms.join(", ")}`
      : "No device can be profiled yet: see the fixes above"
  );

  return lines.join("\n");
};

/** Exit code when no device of any platform can be profiled: a setup problem, see `exitCodeFor`. */
export const NOT_READY_EXIT_CODE = 3;

export const registerDoctorCommand = (program: Command) => {
  registerJsonOption(
    program
      .command("doctor")
      .summary("Check that this host and the connected devices are ready to profile")
      .description(
        `Check that this host and the connected devices are ready to profile: adb and the
connected Android devices (API level, ABI), the iOS profiler binary and the connected iOS
devices. Every problem comes with a fix. Exits with ${NOT_READY_EXIT_CODE} when no device can be profiled.`
      )
  ).action(async () => {
    const report = await runDoctor();

    printResult(report, (value) => console.log(formatDoctorReport(value)));
    if (!report.ready.android && !report.ready.ios) process.exitCode = NOT_READY_EXIT_CODE;
  });
};
