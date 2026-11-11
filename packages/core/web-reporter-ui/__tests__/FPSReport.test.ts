import { describe, it, expect } from "bun:test";
import { getFpsSafeZones } from "../src/sections/FPSReport";

describe("getFpsSafeZones", () => {
  it("draws one unnamed band below the refresh rate", () => {
    expect(getFpsSafeZones([120])).toEqual([
      { y: 114, y2: 120, color: "#158000", label: "Safe Zone" },
    ]);
  });

  it("draws a band per refresh rate when the compared results differ", () => {
    expect(getFpsSafeZones([120, 60])).toEqual([
      { y: 114, y2: 120, color: "#158000", label: "Safe Zone (120 Hz)" },
      { y: 57, y2: 60, color: "#158000", label: "Safe Zone (60 Hz)" },
    ]);
  });
});
