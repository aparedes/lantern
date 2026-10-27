import fs from "fs";
import { POLLING_INTERVAL, TestCaseResult } from "@lantern/types";
import path from "path";
import { readResults } from "@lantern/analyze";

const assertTimeIntervalMultiple = (n: number) => {
  if (n % POLLING_INTERVAL !== 0) {
    throw new Error(`Only multiples of the measure interval (${POLLING_INTERVAL}ms) are supported`);
  }
};

export const getMeasuresForTimeInterval = ({
  duration,
  skip,
  results,
}: {
  duration: number | null;
  skip: number;
  results: TestCaseResult[];
}): TestCaseResult[] => {
  assertTimeIntervalMultiple(skip);
  if (duration !== null) assertTimeIntervalMultiple(duration);

  const firstMeasureIndex = skip / POLLING_INTERVAL;

  return results.map((result) => ({
    ...result,
    iterations: result.iterations.map((iteration) => ({
      ...iteration,
      measures: iteration.measures.slice(
        firstMeasureIndex,
        duration ? firstMeasureIndex + duration / POLLING_INTERVAL + 1 : iteration.measures.length
      ),
    })),
  }));
};

const copyVideoFiles = (results: TestCaseResult[], outputDir: string) => {
  results.forEach((result) => {
    result.iterations.forEach((iteration) => {
      const videoPath = iteration.videoInfos?.path;
      if (videoPath && fs.existsSync(videoPath)) {
        const videoName = path.basename(videoPath);
        const destinationPath = path.join(outputDir, videoName);
        fs.copyFileSync(videoPath, destinationPath);
      }
    });
  });
};

/** Results files and folders → their results; see `readResults` for the checks. */
export const getResultsFromPaths = (jsonPaths: string[]): TestCaseResult[] =>
  readResults(jsonPaths).map(({ result }) => result);

const getAssetsDir = () => process.env.LANTERN_REPORT_ASSETS_PATH || __dirname;

/**
 * The token `App.tsx` initialises the results with. Vite builds a single self-contained
 * `index.html` (see vite.config.ts + vite-plugin-singlefile), so the placeholder — quoted by the
 * minifier as a string or a template literal — appears exactly once in the built HTML.
 */
const RESULTS_PLACEHOLDER =
  /(["'`])THIS_IS_A_VERY_LONG_STRING_THAT_IS_UNLIKELY_TO_BE_FOUND_IN_A_TEST_CASE_RESULT\1/;

export const injectResults = (html: string, results: TestCaseResult[]): string => {
  const occurrences = html.match(new RegExp(RESULTS_PLACEHOLDER.source, "g"))?.length ?? 0;
  if (occurrences === 0) {
    throw new Error("Could not find the results placeholder in the report HTML");
  }
  if (occurrences > 1) {
    throw new Error(
      `Found the results placeholder ${occurrences} times in the report HTML, expected exactly one`
    );
  }

  // `<` is escaped so that a `</script>` sequence inside the data cannot end the inline script.
  const payload = JSON.stringify(results).replace(/</g, "\\u003c");

  // A replacer function keeps `$&`, `$1`, ... sequences in the data from being interpreted.
  return html.replace(RESULTS_PLACEHOLDER, () => payload);
};

/**
 * A report name derived from the first results file, so that successive reports written to a shared
 * folder (the OS temp dir by default) do not overwrite each other. `exists` is checked for the
 * candidate names so that an existing report is never clobbered.
 */
export const getReportFileName = ({
  firstJsonPath,
  exists,
}: {
  firstJsonPath: string;
  exists: (fileName: string) => boolean;
}): string => {
  const base = `report-${path.basename(firstJsonPath).replace(/\.json$/, "")}`;

  let candidate = `${base}.html`;
  for (let index = 2; exists(candidate); index++) {
    candidate = `${base}-${index}.html`;
  }
  return candidate;
};

export const writeReport = ({
  jsonPaths,
  outputDir,
  duration,
  skip = 0,
  fileName = "report.html",
}: {
  jsonPaths: string[];
  outputDir: string;
  duration: number | null;
  skip: number;
  fileName?: string;
}) => {
  const html = fs.readFileSync(`${getAssetsDir()}/index.html`, "utf8");

  const results = getResultsFromPaths(jsonPaths);

  const reportHtml = injectResults(html, getMeasuresForTimeInterval({ results, skip, duration }));

  fs.mkdirSync(outputDir, { recursive: true });
  const htmlFilePath = `${outputDir}/${fileName}`;
  // Videos stay next to the report as separate files, by design.
  copyVideoFiles(results, outputDir);
  fs.writeFileSync(htmlFilePath, reportHtml);
  return htmlFilePath;
};
