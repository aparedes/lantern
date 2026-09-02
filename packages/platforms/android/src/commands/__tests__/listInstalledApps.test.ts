import { describe, it, expect, afterAll, spyOn, mock } from "bun:test";
import { listInstalledApps, parsePackageList } from "../listInstalledApps";
import * as adbModule from "../adb";

const adbSpy = spyOn(adbModule, "adb");

describe("parsePackageList", () => {
  it("returns an empty list for a blank output", () => {
    expect(parsePackageList("\n\n")).toEqual([]);
  });

  it("sorts the packages alphabetically", () => {
    expect(parsePackageList("package:com.zebra.app\npackage:com.example.app\n")).toEqual([
      { bundleId: "com.example.app", name: "com.example.app" },
      { bundleId: "com.zebra.app", name: "com.zebra.app" },
    ]);
  });
});

describe("listInstalledApps", () => {
  it("only lists third party packages", async () => {
    adbSpy.mockImplementation((args) => {
      expect(args).toEqual(["shell", "pm", "list", "packages", "-3"]);

      return "package:com.example.app\n";
    });

    expect(await listInstalledApps()).toEqual([
      { bundleId: "com.example.app", name: "com.example.app" },
    ]);
  });
});

afterAll(() => mock.restore());
