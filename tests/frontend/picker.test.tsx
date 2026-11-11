import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppPicker } from "../../src/components/modals";

const base = { gameName: "Cyberpunk 2077", reason: "No match", candidates: [], apps: ["Desktop", "Steam Big Picture", "Virtual Display"], done: () => {} };

describe("Apollo app picker", () => {
  it("offers adding the game to Apollo as the first option", () => {
    const html = renderToString(createElement(AppPicker, { ...base, canCreate: true })).replace(/<!-- -->/g, "");
    const add = html.indexOf("Add “Cyberpunk 2077” to Apollo on the PC");
    expect(add).toBeGreaterThan(-1);
    expect(add).toBeLessThan(html.indexOf("Apollo apps"));
    expect(add).toBeLessThan(html.indexOf("Reload app list from PC"));
  });

  it("hides the option when web UI access is off (or for non-Steam games)", () => {
    const html = renderToString(createElement(AppPicker, { ...base, canCreate: false })).replace(/<!-- -->/g, "");
    expect(html).not.toContain("to Apollo on the PC");
  });
});
