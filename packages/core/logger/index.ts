import kleur from "kleur";

const info = kleur.blue;
const success = kleur.bold().green;
const warn = kleur.bold().yellow().bgRed;
const error = kleur.bold().red;
const timestampColor = kleur.grey;

export const LogLevel = {
  SILENT: -1,
  ERROR: 0,
  WARN: 1,
  SUCCESS: 2,
  INFO: 3,
  DEBUG: 4,
  TRACE: 5,
} as const;

type ValueOf<T> = T[keyof T];

export type LogLevelValue = ValueOf<typeof LogLevel>;

let logLevel: number = LogLevel.INFO;

// `HH:mm:ss` in the local time zone. `Intl` does what luxon did here, and the measure web app
// logs through this module too: luxon alone was 69 kB of its bundle.
const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const formatLine = (message: string) => {
  const timestamp = timeFormat.format(new Date());
  const timestampLog = timestampColor(`[${timestamp}]`);
  return `${timestampLog} ${message}`;
};

const log = (message: string) => {
  console.log(formatLine(message));
};

/** Warnings and errors go to stderr so that a piped stdout (JSON results, reports…) stays clean. */
const logError = (message: string) => {
  console.error(formatLine(message));
};

/**
 * A message, or a thunk producing it. Pass a thunk when building the message is costly (e.g. a
 * `JSON.stringify` of a payload): it is only invoked when the level is enabled.
 */
type LogMessage = string | (() => string);

const resolveMessage = (message: LogMessage) =>
  typeof message === "function" ? message() : message;

export const Logger = {
  setLogLevel: (level: LogLevelValue) => {
    logLevel = level;
  },
  /** Whether a message logged at `level` would currently be printed. */
  isEnabled: (level: LogLevelValue): boolean => logLevel >= level,
  trace: (message: LogMessage) => {
    if (logLevel < LogLevel.TRACE) return;
    log(resolveMessage(message));
  },
  debug: (message: LogMessage) => {
    if (logLevel < LogLevel.DEBUG) return;

    const time = performance.now();
    log(`🚧  ${Math.floor(time)}: ${resolveMessage(message)}`);
  },
  info: (message: LogMessage) => {
    if (logLevel < LogLevel.INFO) return;

    log(info(`ℹ️  ${resolveMessage(message)}`));
  },
  success: (message: LogMessage) => {
    if (logLevel < LogLevel.SUCCESS) return;

    log(success(`✅  ${resolveMessage(message)}`));
  },
  warn: (message: LogMessage) => {
    if (logLevel < LogLevel.WARN) return;

    logError(warn(`⚠️  ${resolveMessage(message)}`));
  },
  error: (message: LogMessage) => {
    if (logLevel < LogLevel.ERROR) return;

    logError(error(`🚨  ${resolveMessage(message)}`));
  },
};

const NON_MESSAGE_METHODS: ReadonlySet<keyof typeof Logger> = new Set(["setLogLevel", "isEnabled"]);

export const printExampleMessages = () => {
  Logger.setLogLevel(LogLevel.TRACE);
  (Object.keys(Logger) as (keyof typeof Logger)[]).forEach((key) => {
    if (NON_MESSAGE_METHODS.has(key)) return;

    (Logger[key] as typeof Logger.debug)(`This is an awesome ${key} message`);
  });
};
