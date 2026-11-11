import { describe, it, expect } from "bun:test";
import { render, fireEvent, screen } from "@testing-library/react";
import { IterationsReporterView } from "../ReporterView";
import { TestCaseResult } from "@lantern/types";
import { getText } from "../utils/testUtils";

describe("<ReporterView />", () => {
  it("renders the comparison view", () => {
    const testCaseResults: TestCaseResult[] = [
      require("../../../commands/report/src/example-reports/results1.json"),
      require("../../../commands/report/src/example-reports/results2.json"),
    ];

    const { baseElement } = render(<IterationsReporterView results={testCaseResults} />);
    expect(screen.getAllByLabelText("Score")[0].textContent).toEqual("70");

    fireEvent.click(screen.getByText("Other threads"));

    expect(getText(baseElement)).toMatchSnapshot();
    expect(baseElement.innerHTML).toMatchSnapshot();

    /**
     * TESTING iteration selection
     */
    fireEvent.click(screen.getByLabelText("Show each iteration individually"));

    // iteration 10
    fireEvent.click(screen.getByLabelText("See previous iteration"));
    // iteration 9
    fireEvent.click(screen.getByLabelText("See previous iteration"));
    // back to iteration 10
    fireEvent.click(screen.getByLabelText("See next iteration"));

    expect(screen.getAllByLabelText("Score")[0].textContent).toEqual("65");

    expect(getText(baseElement)).toMatchSnapshot();
    expect(baseElement.innerHTML).toMatchSnapshot();
    /**
     * =========================
     */
  });

  it("keeps the failed iterations of a test whose retries were exhausted browsable", () => {
    const successful: TestCaseResult = require("../../../commands/report/src/example-reports/results1.json");
    const failed: TestCaseResult = {
      ...successful,
      name: "Failed test",
      status: "FAILURE",
      iterations: successful.iterations
        .slice(0, 2)
        .map((iteration) => ({ ...iteration, status: "FAILURE" as const })),
    };

    // The failed report first: the charts are shown based on the first report's measures
    render(<IterationsReporterView results={[failed, successful]} />);

    expect(
      screen.getByText("The maximum number of retries has been exceeded for this test.")
    ).toBeTruthy();
    // The charts are still there for both reports...
    expect(screen.getByText("Other threads")).toBeTruthy();
    // ...and so is the iteration selector, over the 2 failed iterations
    expect(screen.getByText("Showing average of 2 test iterations")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Show each iteration individually"));
    fireEvent.click(screen.getByLabelText("See next iteration"));
    // The counter is split over nested spans
    expect(
      screen.getByText(
        (_, element) => element?.tagName === "SPAN" && element.textContent === "Iteration 2/2"
      )
    ).toBeTruthy();
  });

  it("renders the comparison view with videos", () => {
    const testCaseResults: TestCaseResult[] = [
      require("../../../commands/report/src/example-reports/video/results_417dd25e-d901-4b1e-9d43-3b78305a48e2.json"),
      require("../../../commands/report/src/example-reports/video/results_c7d5d17d-42ed-4354-8b43-bb26e2d6feee.json"),
    ];

    const { baseElement } = render(<IterationsReporterView results={testCaseResults} />);
    expect(screen.getAllByLabelText("Score")[0].textContent).toEqual("51");

    expect(getText(baseElement)).toMatchSnapshot();
    expect(baseElement.innerHTML).toMatchSnapshot();
  });

  describe("device specs", () => {
    const base: TestCaseResult = require("../../../commands/report/src/example-reports/results1.json");

    it("shows the device line and an FPS band following the refresh rate", () => {
      const withSpecs: TestCaseResult = {
        ...base,
        specs: { refreshRate: 120, platform: "android", deviceName: "Pixel 8" },
      };

      const { baseElement } = render(<IterationsReporterView results={[withSpecs]} />);

      expect(screen.getByTestId("device-specs").textContent).toEqual("Android · Pixel 8 · 120 Hz");
      expect(baseElement.innerHTML).toContain("114");
      expect(baseElement.innerHTML).toContain("Safe Zone");
      expect(baseElement.innerHTML).not.toContain('"y":57');
    });

    it("renders no device line when the result recorded no specs", () => {
      render(<IterationsReporterView results={[base]} />);

      expect(screen.queryByTestId("device-specs")).toBeNull();
    });

    it("still renders the FPS chart when the first sample has no fps", () => {
      const withoutFirstFps: TestCaseResult = {
        ...base,
        iterations: base.iterations.map((iteration) => ({
          ...iteration,
          measures: iteration.measures.map((measure, i) => {
            if (i !== 0) return measure;
            const { fps: _fps, ...rest } = measure;
            return rest;
          }),
        })),
      };

      render(<IterationsReporterView results={[withoutFirstFps]} />);

      expect(screen.getByText("Frame rate (FPS)")).toBeTruthy();
    });
  });
});
