/**
 * W14 — the report panel's host.
 *
 * 🔴 The load-bearing test is the last describe block. "Layout is not
 * negotiable by untrusted content" is only a real rule if something goes red
 * when it is broken, and a test that merely dispatches a `message` and then
 * checks the height would still pass if this component were a bare `<div>`.
 * So it is asserted twice, from opposite directions:
 *
 *   - the height is the CLAMP, before and after the message; and
 *   - the component registers no `message` listener on `window` at all,
 *     spied at mount time. Adding a resize listener later fails that.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { ThemeProvider } from "@mui/material/styles";
import ReportFrameHost, { REPORT_PANEL_HEIGHT } from "./ReportFrameHost.js";
import { lightTheme } from "../theme.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function renderHost(child = <div data-testid="panel-child">the report frame</div>) {
  return render(
    <ThemeProvider theme={lightTheme}>
      <ReportFrameHost>{child}</ReportFrameHost>
    </ThemeProvider>,
  );
}

describe("the height is explicit and never negotiated", () => {
  it("is exactly clamp(480px, 70vh, 900px) with internal scroll", () => {
    renderHost();
    const host = screen.getByTestId("report-frame-host");
    const style = getComputedStyle(host);
    expect(style.height).toBe(REPORT_PANEL_HEIGHT);
    expect(REPORT_PANEL_HEIGHT).toBe("clamp(480px, 70vh, 900px)");
    expect(style.overflow).toBe("auto");
  });

  it("holds the child inside the fixed box", () => {
    renderHost();
    expect(within(screen.getByTestId("report-frame-host")).getByTestId("panel-child")).toBeInTheDocument();
  });
});

describe("the expand control", () => {
  it("opens a full-viewport dialog rendering the SAME child", () => {
    renderHost();
    expect(screen.queryByTestId("report-frame-host-expanded")).toBeNull();
    fireEvent.click(screen.getByTestId("report-expand"));
    const expanded = screen.getByTestId("report-frame-host-expanded");
    expect(within(expanded).getByTestId("panel-child")).toBeInTheDocument();
  });

  it("restores the boxed copy when the dialog closes", () => {
    renderHost();
    fireEvent.click(screen.getByTestId("report-expand"));
    fireEvent.click(screen.getByTestId("report-collapse"));
    expect(within(screen.getByTestId("report-frame-host")).getByTestId("panel-child")).toBeInTheDocument();
  });
});

describe("🔴 exactly ONE copy of the child is mounted at a time", () => {
  it("counts one instance boxed, one expanded, and one again after closing", () => {
    renderHost();
    // Boxed: one, and it is inside the fixed-height box.
    expect(screen.getAllByTestId("panel-child").length).toBe(1);
    expect(
      within(screen.getByTestId("report-frame-host")).getAllByTestId("panel-child").length,
    ).toBe(1);

    fireEvent.click(screen.getByTestId("report-expand"));
    // Expanded: still ONE. Two would mean two `srcdoc` loads of the same
    // report, two lots of script, and two independent scroll positions for
    // one document — W23 must not inherit that.
    expect(screen.getAllByTestId("panel-child").length).toBe(1);
    expect(
      within(screen.getByTestId("report-frame-host-expanded")).getAllByTestId("panel-child").length,
    ).toBe(1);
    expect(within(screen.getByTestId("report-frame-host")).queryByTestId("panel-child")).toBeNull();

    fireEvent.click(screen.getByTestId("report-collapse"));
    expect(screen.getAllByTestId("panel-child").length).toBe(1);
  });

  it("counts one real sandboxed iframe, expanded or not", () => {
    // The shape W23 actually mounts. An iframe is the thing that costs a load,
    // so it is the thing worth counting.
    const { container } = renderHost(
      <iframe data-testid="panel-child" title="report" sandbox="allow-scripts" srcDoc="<p>hi</p>" />,
    );
    expect(container.ownerDocument.querySelectorAll("iframe").length).toBe(1);
    fireEvent.click(screen.getByTestId("report-expand"));
    expect(container.ownerDocument.querySelectorAll("iframe").length).toBe(1);
  });

  it("keeps the box at its clamp height while the dialog is open, so nothing below it jumps", () => {
    renderHost();
    fireEvent.click(screen.getByTestId("report-expand"));
    expect(getComputedStyle(screen.getByTestId("report-frame-host")).height).toBe(
      REPORT_PANEL_HEIGHT,
    );
  });
});

describe("🔴 no postMessage-driven resize", () => {
  it("registers NO `message` listener on window", () => {
    const spy = vi.spyOn(window, "addEventListener");
    renderHost();
    const messageCalls = (): unknown[] => spy.mock.calls.filter(([type]) => type === "message");
    expect(messageCalls()).toEqual([]);

    // …and prove the spy would have SEEN one, so the assertion above is not
    // green merely because the spy was installed wrong.
    const probe = (): void => {};
    window.addEventListener("message", probe);
    expect(messageCalls().length).toBe(1);
    window.removeEventListener("message", probe);
  });

  it("ignores a height posted by the framed content, expanded or not", () => {
    renderHost();
    const host = screen.getByTestId("report-frame-host");
    expect(getComputedStyle(host).height).toBe(REPORT_PANEL_HEIGHT);

    act(() => {
      // Exactly the shape an iframe-resizer script posts. A report asking for
      // 40000px would push the verdict buttons off the screen.
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "resize", height: 40000 },
          origin: "null",
        }),
      );
      window.dispatchEvent(new MessageEvent("message", { data: "height:40000px" }));
    });

    expect(getComputedStyle(screen.getByTestId("report-frame-host")).height).toBe(REPORT_PANEL_HEIGHT);
    expect(screen.getByTestId("report-frame-host").getAttribute("style")).toBeNull();
  });
});
