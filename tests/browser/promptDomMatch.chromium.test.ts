import { existsSync } from "node:fs";

import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { readExactComposerPromptText } from "../../src/browser/promptDomMatch.js";
import { buildGpt56SolProFinalDispatchGuard } from "../../src/browser/providers/chatgptDomProvider.js";

const chromePath = process.env.ORACLE_CHROMIUM_PATH ?? "";
const enabled =
  process.env.ORACLE_CHROMIUM_EXACT_PROMPT_TEST === "1" &&
  chromePath.length > 0 &&
  existsSync(chromePath);

describe.skipIf(!enabled)("exact composer plaintext in real Chromium", () => {
  let browser: Browser;
  let page: Page;
  let cdp: CDPSession;

  type BlurMutation = "none" | "root-class" | "descendant";

  interface GuardPageState {
    ancestorCapture: Array<{
      status?: string;
      routeProofStatus?: string | null;
      lastEvent?: string | null;
    }>;
    applicationClicks: number;
    applicationTrustFlags: boolean[];
    bindingPayloads: string[];
    blurCount: number;
    blurTextBefore: string | null;
    blurTextAfter: string | null;
    initialInnerHtml: string;
    blurredInnerHtml: string | null;
    replayReturn: boolean | null;
  }

  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-background-networking", "--disable-default-apps"],
    });
    page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => void request.abort());
    cdp = await page.createCDPSession();
  });

  afterAll(async () => {
    await cdp?.detach().catch(() => undefined);
    await browser?.close();
  });

  async function insertAndRead(prompt: string) {
    await page.setContent(`
      <!doctype html>
      <button id="send" type="button">Send</button>
      <div id="editor" role="textbox" contenteditable="true"
           style="white-space: pre-wrap"></div>
    `);
    await page.focus("#editor");
    await cdp.send("Input.insertText", { text: prompt });
    return await page.evaluate((readerSource) => {
      const reader = Function(`return (${readerSource})`)() as (editor: Element) => {
        ok: boolean;
        value: string;
        reason: string | null;
        selectionRestored: boolean;
        focusPreserved: boolean;
      };
      const editor = document.querySelector("#editor")!;
      const selection = document.getSelection()!;
      const before = {
        rangeCount: selection.rangeCount,
        anchorNode: selection.anchorNode,
        anchorOffset: selection.anchorOffset,
        focusNode: selection.focusNode,
        focusOffset: selection.focusOffset,
      };
      const read = reader(editor);
      const selectionRestored =
        selection.rangeCount === before.rangeCount &&
        selection.anchorNode === before.anchorNode &&
        selection.anchorOffset === before.anchorOffset &&
        selection.focusNode === before.focusNode &&
        selection.focusOffset === before.focusOffset;
      return {
        read,
        innerText: (editor as HTMLElement).innerText,
        selectionRestored,
        activeId: (document.activeElement as HTMLElement | null)?.id ?? null,
      };
    }, readExactComposerPromptText.toString());
  }

  async function evaluateExpression<T>(expression: string): Promise<T> {
    const response = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error("Real-Chromium guard expression threw.");
    }
    return response.result.value as T;
  }

  async function installProductionGuard(
    prompt: string,
    blurMutation: BlurMutation,
    replayCapturedClick = false,
  ) {
    const token = "chromium-production-guard";
    await page.setContent(`
      <!doctype html>
      <style>
        #composer { width: 640px; padding: 12px; }
        #editor { min-height: 80px; white-space: pre-wrap; }
        #send { width: 80px; height: 32px; }
      </style>
      <form id="composer" data-testid="unified-composer">
        <div id="editor" class="ProseMirror ProseMirror-focused"
             role="textbox" contenteditable="true"></div>
        <button id="send" data-testid="send-button" type="button">Send</button>
      </form>
    `);
    await page.focus("#editor");
    await cdp.send("Input.insertText", { text: prompt });

    const guard = buildGpt56SolProFinalDispatchGuard(undefined, token, {
      exactSubmission: { prompt, attachments: [] },
    });
    const bindingName = guard.verdictBinding!.name;
    const statusExpression = guard.immediatelyBeforeDispatchExpression!;
    await page.evaluate(
      ({ bindingName, blurMutation, replayCapturedClick, statusExpression, token }) => {
        const root = window as unknown as Record<string, unknown>;
        const editor = document.querySelector("#editor") as HTMLElement;
        const composer = document.querySelector("#composer") as HTMLElement;
        const send = document.querySelector("#send") as HTMLButtonElement;
        editor.setAttribute("data-oracle-send-editor-binding", token);
        composer.setAttribute("data-oracle-send-composer-binding", token);
        send.setAttribute("data-oracle-send-binding", token);

        const state: GuardPageState = {
          ancestorCapture: [],
          applicationClicks: 0,
          applicationTrustFlags: [],
          bindingPayloads: [],
          blurCount: 0,
          blurTextBefore: null,
          blurTextAfter: null,
          initialInnerHtml: editor.innerHTML,
          blurredInnerHtml: null,
          replayReturn: null,
        };
        root.__oracleChromiumGuardState = state;
        root[bindingName] = (payload: string) => state.bindingPayloads.push(payload);

        const proof = {
          version: 1,
          token,
          status: "valid",
          reason: null as string | null,
          guardArmed: false,
          validate: () =>
            proof.status === "valid"
              ? { ok: true, reason: null }
              : { ok: false, reason: proof.reason ?? proof.status },
          armGuard: () => {
            if (proof.status !== "valid" || proof.guardArmed) return false;
            proof.guardArmed = true;
            return true;
          },
          consume: () => {
            if (proof.status !== "valid" || !proof.guardArmed) {
              return { ok: false, reason: proof.reason ?? proof.status };
            }
            proof.status = "consumed";
            proof.reason = null;
            return { ok: true, reason: null };
          },
          burn: (reason: string) => {
            if (proof.status === "consumed") return;
            proof.status = "burned";
            proof.reason = reason;
          },
          cleanup: () => undefined,
        };
        root.__oracleProtectedPublicRouteProofsV1 = new Map([[token, proof]]);

        editor.addEventListener("blur", () => {
          state.blurCount += 1;
          state.blurTextBefore = editor.textContent;
          if (blurMutation === "root-class") {
            editor.classList.remove("ProseMirror-focused");
          } else if (blurMutation === "descendant") {
            const replacement = document.createElement("span");
            replacement.dataset.blurRewrite = "true";
            replacement.textContent = editor.textContent;
            editor.replaceChildren(replacement);
          }
          state.blurTextAfter = editor.textContent;
          state.blurredInnerHtml = editor.innerHTML;
        });
        composer.addEventListener(
          "click",
          () => {
            const readStatus = Function(`return (${statusExpression})`) as () => {
              status?: string;
              routeProofStatus?: string | null;
              lastEvent?: string | null;
            };
            state.ancestorCapture.push(readStatus());
          },
          { capture: true },
        );
        send.addEventListener("click", (event) => {
          state.applicationClicks += 1;
          state.applicationTrustFlags.push(event.isTrusted);
          if (replayCapturedClick && state.applicationClicks === 1) {
            setTimeout(() => {
              state.replayReturn = send.dispatchEvent(event);
            }, 0);
          }
        });
      },
      { bindingName, blurMutation, replayCapturedClick, statusExpression, token },
    );

    const installed = await evaluateExpression<unknown>(guard.expression);
    expect(() => guard.assertResult(installed)).not.toThrow();
    return guard;
  }

  async function dispatchTrustedSendClick(): Promise<void> {
    const point = await page.$eval("#send", (send) => {
      const rect = send.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      clickCount: 1,
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  }

  async function readGuardPageState(): Promise<GuardPageState & { activeId: string | null }> {
    return await page.evaluate(() => {
      const root = window as unknown as Record<string, unknown>;
      return {
        ...(root.__oracleChromiumGuardState as GuardPageState),
        activeId: (document.activeElement as HTMLElement | null)?.id ?? null,
      };
    });
  }

  test("round-trips the incident shape and controlled blank-line canaries", async () => {
    const blankIndexes = new Set([2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35, 37]);
    const incidentShape = Array.from({ length: 39 }, (_, index) =>
      blankIndexes.has(index) ? "" : `line ${index + 1}`,
    ).join("\n");
    expect(incidentShape.split("\n")).toHaveLength(39);
    expect(incidentShape.split("\n").filter((line) => line === "")).toHaveLength(13);

    const cases = [
      "a\nb",
      "a\n\nb",
      "a\n\n\nb",
      "\na",
      "\n\na",
      "a\n",
      "a\n\n",
      ["- item", "", "```ts", "const answer = 42;", "```"].join("\n"),
      incidentShape,
    ];
    for (const prompt of cases) {
      const result = await insertAndRead(prompt);
      expect(result.read, JSON.stringify(prompt)).toEqual({
        ok: true,
        value: prompt,
        reason: null,
        selectionRestored: true,
        focusPreserved: true,
      });
      expect(result.selectionRestored, JSON.stringify(prompt)).toBe(true);
      expect(result.activeId, JSON.stringify(prompt)).toBe("editor");
    }

    const distorted = await insertAndRead("a\n\nb");
    expect(distorted.innerText).not.toBe("a\n\nb");
    expect(distorted.read.value).toBe("a\n\nb");
  });

  test("refuses an unfocused editor without stealing send-button focus", async () => {
    await insertAndRead("a\n\nb");
    const result = await page.evaluate((readerSource) => {
      const reader = Function(`return (${readerSource})`)() as (editor: Element) => {
        ok: boolean;
        reason: string | null;
      };
      const editor = document.querySelector("#editor")!;
      const send = document.querySelector("#send") as HTMLButtonElement;
      send.focus();
      const selection = document.getSelection()!;
      const before = {
        anchorNode: selection.anchorNode,
        anchorOffset: selection.anchorOffset,
        focusNode: selection.focusNode,
        focusOffset: selection.focusOffset,
      };
      const read = reader(editor);
      return {
        read,
        activeId: (document.activeElement as HTMLElement | null)?.id ?? null,
        selectionUnchanged:
          selection.anchorNode === before.anchorNode &&
          selection.anchorOffset === before.anchorOffset &&
          selection.focusNode === before.focusNode &&
          selection.focusOffset === before.focusOffset,
      };
    }, readExactComposerPromptText.toString());
    expect(result.read).toMatchObject({ ok: false, reason: "editor-not-focused" });
    expect(result.activeId).toBe("send");
    expect(result.selectionUnchanged).toBe(true);
  });

  test("consumes the protected proof before an ancestor capture handler observes the click", async () => {
    const guard = await installProductionGuard("exact protected prompt", "none");
    await dispatchTrustedSendClick();

    const state = await readGuardPageState();
    expect(state.ancestorCapture).toEqual([
      expect.objectContaining({
        status: "allowed",
        routeProofStatus: "consumed",
        lastEvent: "click",
      }),
    ]);
    expect(state.applicationClicks).toBe(1);
    expect(state.bindingPayloads).toHaveLength(1);
    expect(guard.verdictBinding?.parsePayload(state.bindingPayloads[0] ?? "")).toMatchObject({
      status: "allowed",
      lastEvent: "click",
    });
    const verdict = await evaluateExpression<unknown>(guard.afterDispatchExpression!);
    expect(verdict).toMatchObject({ status: "allowed", lastEvent: "click" });
    expect(() => guard.assertAfterDispatchResult?.(verdict)).not.toThrow();
  });

  test("allows normal ProseMirror root-class cleanup on blur", async () => {
    const prompt = "exact protected prompt";
    const guard = await installProductionGuard(prompt, "root-class");
    await dispatchTrustedSendClick();

    const state = await readGuardPageState();
    expect(state.blurCount).toBe(1);
    expect(state.blurTextBefore).toBe(prompt);
    expect(state.blurTextAfter).toBe(prompt);
    expect(state.blurredInnerHtml).toBe(state.initialInnerHtml);
    expect(state.activeId).toBe("send");
    expect(state.applicationClicks).toBe(1);
    const verdict = await evaluateExpression<unknown>(guard.afterDispatchExpression!);
    expect(verdict).toMatchObject({ status: "allowed", lastEvent: "click" });
  });

  test("blocks asynchronous redispatch of the original trusted click Event", async () => {
    const guard = await installProductionGuard("exact protected prompt", "none", true);
    await dispatchTrustedSendClick();
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

    const state = await readGuardPageState();
    expect(state.applicationClicks).toBe(1);
    expect(state.applicationTrustFlags).toEqual([true]);
    expect(state.replayReturn).toBe(false);
    expect(state.bindingPayloads).toHaveLength(1);
    expect(guard.verdictBinding?.parsePayload(state.bindingPayloads[0] ?? "")).toMatchObject({
      status: "allowed",
      lastEvent: "click",
    });
    const verdict = await evaluateExpression<unknown>(guard.afterDispatchExpression!);
    expect(verdict).toMatchObject({
      status: "blocked",
      reason: "duplicate-trusted-dispatch-event",
      lastEvent: "click",
    });
  });

  test("blocks a text-equivalent descendant rewrite during blur", async () => {
    const prompt = "exact protected prompt";
    const guard = await installProductionGuard(prompt, "descendant");
    await dispatchTrustedSendClick();

    const state = await readGuardPageState();
    expect(state.blurCount).toBe(1);
    expect(state.blurTextBefore).toBe(prompt);
    expect(state.blurTextAfter).toBe(prompt);
    expect(state.blurredInnerHtml).not.toBe(state.initialInnerHtml);
    expect(state.ancestorCapture).toEqual([]);
    expect(state.applicationClicks).toBe(0);
    expect(state.bindingPayloads).toHaveLength(1);
    expect(guard.verdictBinding?.parsePayload(state.bindingPayloads[0] ?? "")).toMatchObject({
      status: "blocked",
      reason: "exact-prompt-changed",
    });
    const verdict = await evaluateExpression<unknown>(guard.afterDispatchExpression!);
    expect(verdict).toMatchObject({
      status: "blocked",
      reason: "exact-prompt-changed",
    });
  });
});
