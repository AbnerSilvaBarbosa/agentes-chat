import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, fireEvent, render } from "@testing-library/react";
import { Breadcrumb } from "../src";

afterEach(() => cleanup());

describe("Breadcrumb", () => {
  test("every item but the last is a link, the last is plain text", () => {
    const { container } = render(
      <Breadcrumb
        label="Caminho"
        items={[
          { label: "Tarefas", href: "/issues" },
          { label: "Clínica Teo", href: "/issues?space=1" },
          { label: "Site novo" },
        ]}
      />,
    );
    const nav = container.querySelector("nav[aria-label='Caminho']") as HTMLElement;
    const items = [...nav.querySelectorAll("li")];
    expect(items.map((li) => li.querySelector(".ac-breadcrumb__label")?.textContent)).toEqual([
      "Tarefas",
      "Clínica Teo",
      "Site novo",
    ]);
    expect([...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/issues", "/issues?space=1"]);
    const last = items[2] as HTMLElement;
    expect(last.querySelector("a, button")).toBeNull();
    expect(last.querySelector("[aria-current='page']")?.textContent).toBe("Site novo");
    // Even an item given a link is text when it is the last.
    const again = render(<Breadcrumb label="Caminho" items={[{ label: "Tarefas", href: "/issues" }]} />);
    expect(again.container.querySelector("a")).toBeNull();
  });

  test("an item can carry a mark before its words, and an in-page item answers a click", () => {
    let chosen = 0;
    const { container } = render(
      <Breadcrumb
        label="Caminho"
        items={[
          { label: "Tarefas", onSelect: () => chosen++ },
          { label: "Clínica", href: "/x", mark: <i className="the-mark" />, onSelect: () => chosen++ },
          { label: "Board", mark: <i className="the-mark" /> },
        ]}
      />,
    );
    const marks = [...container.querySelectorAll(".the-mark")];
    expect(marks.length).toBe(2);
    expect(marks[0]?.nextElementSibling?.textContent).toBe("Clínica");
    fireEvent.click(container.querySelector("button") as HTMLElement);
    fireEvent.click(container.querySelector("a") as HTMLElement);
    expect(chosen).toBe(2);
  });
});
