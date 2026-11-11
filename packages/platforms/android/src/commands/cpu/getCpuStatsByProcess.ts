import { ThreadNames } from "@lantern/types";

export interface ProcessStat {
  processId: string;
  processName: string;
  totalCpuTime: number;
  cpuNumber: string;
}

/**
 * Gives every thread a display name that stays the same for as long as the thread lives.
 * Threads sharing a name are told apart with a ` (n)` suffix — "OkHttp Dispatch",
 * "OkHttp Dispatch (2)"… A thread keeps its suffix from sample to sample; a suffix is only
 * handed out again once the thread that held it is gone or has renamed itself.
 */
export class ThreadNamer {
  private labels = new Map<string, { baseName: string; index: number }>();
  private usedIndexes = new Map<string, Set<number>>();

  /** `threads`: every thread of one sample as `[tid, baseName]`, in output order. */
  name(threads: [tid: string, baseName: string][]): string[] {
    const current = new Map(threads);

    // Free the labels of the threads that died or renamed themselves since the last sample
    for (const [tid, { baseName, index }] of this.labels) {
      if (current.get(tid) !== baseName) {
        this.usedIndexes.get(baseName)?.delete(index);
        this.labels.delete(tid);
      }
    }

    return threads.map(([tid, baseName]) => {
      let label = this.labels.get(tid);
      if (!label) {
        const used = this.usedIndexes.get(baseName) ?? new Set<number>();
        this.usedIndexes.set(baseName, used);
        let index = 1;
        while (used.has(index)) index++;
        used.add(index);
        label = { baseName, index };
        this.labels.set(tid, label);
      }

      return label.index === 1 ? baseName : `${baseName} (${label.index})`;
    });
  }
}

export const processOutput = (
  output: string,
  pid: string,
  namer: ThreadNamer = new ThreadNamer()
): ProcessStat[] => {
  /**
   * We can have multiple processes with the same name but a different pid
   *
   * Say your app dispatches multiple "OkHttp Dispatch" processes to make several requests at the same time
   *
   * We'll display:
   *  - OkHttp Dispatch: xx%
   *  - OkHttp Dispatch (2): xx%
   *  - OkHttp Dispatch (3): xx%
   *  ...
   *
   * The suffix belongs to the thread (see `ThreadNamer`): given the same `namer` from sample
   * to sample, a thread keeps its label even when the output lists the threads in another order.
   */
  const rows = output
    .split(/\r\n|\n|\r/)
    .filter(Boolean)
    .map((stats) => {
      const match = stats.match(/^(\d+) \((.*)\) (.*)/);
      if (!match) {
        throw new Error(`Invalid line: ${stats}`);
      }

      const [, processId, processName, remaining] = match;
      const parts = remaining.split(" ");

      return [processId, processName, ...parts];
    })
    .filter(Boolean);

  const baseName = (subProcessStats: string[]): string => {
    const processId = subProcessStats[0];
    let processName = processId === pid ? ThreadNames.ANDROID.UI : subProcessStats[1];

    if (processName.includes(`Binder:${pid}_`)) {
      processName = processName.replace(`Binder:${pid}_`, "Binder #");
    }

    if (processName === "") {
      processName = "Empty name";
    }

    return processName;
  };

  const labels = namer.name(rows.map((row) => [row[0], baseName(row)]));

  return rows.map((subProcessStats, i) => {
    const processId = subProcessStats[0];
    const processName = labels[i];

    const utime = parseInt(subProcessStats[13], 10);
    const stime = parseInt(subProcessStats[14], 10);

    const cpuNumber = subProcessStats[38];

    const totalCpuTime = utime + stime;

    return { processId, processName, totalCpuTime, cpuNumber };
  });
};
