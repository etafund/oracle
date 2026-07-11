// DOM/CDP-boundary tests for the Project Sources upload orchestration
// (src/browser/actions/projectSources.ts). These are the async, Runtime-driving
// functions that stage repo files for a full-price ChatGPT Pro run
// (src/browser/projectSourcesRunner.ts:219-235). If a readiness/settle wait
// reports success too early, or an upload "completes" without the batch actually
// landing in the Sources list, the paid model answers without the repo context.
//
// The existing tests/browser/projectSources.test.ts only exercises the pure
// expression builders; nothing drives these async functions. Following the fake
// Runtime.evaluate style of tests/browser/attachmentsCompletion.test.ts, these
// tests route Runtime.evaluate by expression content and assert the timeout
// paths fail (throw) rather than silently continuing.

import { describe, expect, test, vi } from "vitest";
import {
  listProjectSources,
  markProjectSourcesUploadInput,
  uploadProjectSources,
  waitForProjectSourcesListSettled,
  waitForProjectSourcesReady,
} from "../../src/browser/actions/projectSources.js";
import type { BrowserAttachment, BrowserLogger, ChromeClient } from "../../src/browser/types.js";
import type { ProjectSourceEntry } from "../../src/projectSources/types.js";

const useFakeTime = () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
};

const useRealTime = () => {
  vi.useRealTimers();
};

const makeLogger = () => vi.fn() as unknown as BrowserLogger;

// Routes Runtime.evaluate to a per-expression handler keyed off a distinctive
// substring of each builder's generated source. Any expression whose handler is
// omitted falls through to the dialog-ready boolean default.
type EvalRoutes = {
  list?: () => unknown;
  ready?: () => unknown;
  addDialog?: () => unknown;
  markInput?: () => unknown;
  confirm?: () => unknown;
};

function routedRuntime(routes: EvalRoutes): ChromeClient["Runtime"] {
  const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
    if (expression.includes("Project Sources panel not found")) {
      return { result: { value: routes.list?.() } };
    }
    if (expression.includes("sources surface not detected")) {
      return { result: { value: routes.ready?.() } };
    }
    if (expression.includes("Project Sources add control not found")) {
      return { result: { value: routes.addDialog?.() } };
    }
    if (expression.includes("Project Sources Add dialog missing")) {
      return { result: { value: routes.markInput?.() } };
    }
    if (expression.includes("upload anyway")) {
      return { result: { value: routes.confirm?.() } };
    }
    if (expression.includes("new Event('input'")) {
      return { result: { value: true } };
    }
    return { result: { value: true } };
  });
  return { evaluate } as unknown as ChromeClient["Runtime"];
}

function makeDom(querySelectorResult: { nodeId?: number } = { nodeId: 99 }): ChromeClient["DOM"] {
  return {
    getDocument: vi.fn(async () => ({ root: { nodeId: 1 } })),
    querySelector: vi.fn(async () => querySelectorResult),
    setFileInputFiles: vi.fn(async () => undefined),
  } as unknown as ChromeClient["DOM"];
}

const attachment = (name: string): BrowserAttachment => ({
  path: `/repo/${name}`,
  displayPath: name,
});

describe("listProjectSources", () => {
  test("throws when the panel probe reports failure", async () => {
    const runtime = routedRuntime({
      list: () => ({ ok: false, error: "Project Sources panel not found." }),
    });
    await expect(listProjectSources(runtime)).rejects.toThrow(/Project Sources panel not found/);
  });

  test("returns the filtered source entries on success", async () => {
    const runtime = routedRuntime({
      list: () => ({ ok: true, sources: [{ name: "a.txt", index: 0 }, { name: "bad" }] }),
    });
    // The second entry is missing a numeric `index` and is filtered out.
    await expect(listProjectSources(runtime)).resolves.toEqual([{ name: "a.txt", index: 0 }]);
  });
});

describe("waitForProjectSourcesReady", () => {
  test("resolves immediately once the surface reports ready", async () => {
    const runtime = routedRuntime({ ready: () => ({ ready: true }) });
    await expect(waitForProjectSourcesReady(runtime, 1_000, makeLogger())).resolves.toBeUndefined();
  });

  test("throws when the surface never becomes ready before timeout", async () => {
    useFakeTime();
    const runtime = routedRuntime({
      ready: () => ({ ready: false, reason: "sources surface not detected" }),
    });
    const promise = waitForProjectSourcesReady(runtime, 800, makeLogger());
    const assertion = expect(promise).rejects.toThrow(/did not become ready before timeout/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });
});

describe("markProjectSourcesUploadInput", () => {
  test("throws the probe reason when no Sources-scoped file input is found", async () => {
    const runtime = routedRuntime({
      markInput: () => ({ ok: false, reason: "file input missing" }),
    });
    await expect(markProjectSourcesUploadInput(runtime)).rejects.toThrow(/file input missing/);
  });

  test("throws a default message when the probe returns no ok flag", async () => {
    const runtime = routedRuntime({ markInput: () => ({}) });
    await expect(markProjectSourcesUploadInput(runtime)).rejects.toThrow(
      /upload input did not appear/i,
    );
  });

  test("resolves when the input is marked", async () => {
    const runtime = routedRuntime({ markInput: () => ({ ok: true }) });
    await expect(markProjectSourcesUploadInput(runtime)).resolves.toBeUndefined();
  });
});

describe("waitForProjectSourcesListSettled", () => {
  test("returns the settled list once it is stable long enough", async () => {
    useFakeTime();
    const stable: ProjectSourceEntry[] = [{ name: "stable.txt", index: 0 }];
    const runtime = routedRuntime({ list: () => ({ ok: true, sources: stable }) });
    const promise = waitForProjectSourcesListSettled(runtime, 30_000, makeLogger());
    // Settling requires >=2500ms observed AND >=700ms stable; advance past both.
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(promise).resolves.toEqual(stable);
    useRealTime();
  });

  test("fails open on a list that never settles: returns latest observed and logs", async () => {
    // Truthful characterization: waitForProjectSourcesListSettled does NOT throw
    // on a never-settling list — it logs and returns the latest observed list.
    // The upstream runner treats this returned list as the settled baseline, so
    // this fail-OPEN behavior is what a regression would need to preserve.
    useFakeTime();
    const logger = makeLogger();
    let n = 0;
    const runtime = routedRuntime({
      list: () => {
        n += 1;
        return { ok: true, sources: [{ name: `changing-${n}`, index: 0 }] };
      },
    });
    const promise = waitForProjectSourcesListSettled(runtime, 5_000, logger);
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toMatch(/^changing-/);
    expect(logger).toHaveBeenCalledWith(expect.stringMatching(/did not settle/i));
    useRealTime();
  });
});

describe("uploadProjectSources", () => {
  test("throws when the Chrome DOM domain is unavailable", async () => {
    const runtime = routedRuntime({ list: () => ({ ok: true, sources: [] }) });
    await expect(
      uploadProjectSources({ runtime, dom: undefined }, [attachment("a.txt")], makeLogger(), 1_000),
    ).rejects.toThrow(/DOM domain unavailable/i);
  });

  test("returns the current list unchanged when there are no attachments", async () => {
    const current: ProjectSourceEntry[] = [{ name: "existing.txt", index: 0 }];
    const runtime = routedRuntime({ list: () => ({ ok: true, sources: current }) });
    await expect(
      uploadProjectSources({ runtime, dom: makeDom() }, [], makeLogger(), 1_000),
    ).resolves.toEqual(current);
  });

  test("resolves only after the uploaded batch is observed in the list", async () => {
    let listCall = 0;
    const runtime = routedRuntime({
      // First read is the pre-upload baseline (empty); subsequent reads show the
      // uploaded batch present, satisfying the has-uploaded-batch check.
      list: () => {
        listCall += 1;
        return listCall === 1
          ? { ok: true, sources: [] }
          : { ok: true, sources: [{ name: "a.txt", index: 0 }] };
      },
      addDialog: () => ({ ok: true, alreadyOpen: true }),
      markInput: () => ({ ok: true }),
      confirm: () => ({ ok: false }),
    });
    const result = await uploadProjectSources(
      { runtime, dom: makeDom() },
      [attachment("a.txt")],
      makeLogger(),
      1_000,
    );
    expect(result).toEqual([{ name: "a.txt", index: 0 }]);
  });

  test("rejects (times out) when the uploaded batch never appears in the list", async () => {
    useFakeTime();
    const runtime = routedRuntime({
      // The list never shows the batch, so the readiness confirmation never fires.
      list: () => ({ ok: true, sources: [] }),
      addDialog: () => ({ ok: true, alreadyOpen: true }),
      markInput: () => ({ ok: true }),
      confirm: () => ({ ok: false }),
    });
    const promise = uploadProjectSources(
      { runtime, dom: makeDom() },
      [attachment("a.txt")],
      makeLogger(),
      1_000,
    );
    const assertion = expect(promise).rejects.toThrow(
      /Timed out waiting for uploaded project sources: a\.txt/,
    );
    // The batch-confirmation deadline floors at 30s regardless of timeoutMs.
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
    useRealTime();
  });

  test("throws when the Sources upload input node cannot be located in the DOM", async () => {
    const runtime = routedRuntime({
      list: () => ({ ok: true, sources: [] }),
      addDialog: () => ({ ok: true, alreadyOpen: true }),
      markInput: () => ({ ok: true }),
    });
    await expect(
      uploadProjectSources(
        { runtime, dom: makeDom({ nodeId: undefined }) },
        [attachment("a.txt")],
        makeLogger(),
        1_000,
      ),
    ).rejects.toThrow(/Unable to locate the Project Sources upload input/);
  });
});
