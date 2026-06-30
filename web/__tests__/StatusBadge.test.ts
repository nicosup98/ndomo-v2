import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import StatusBadge from "../src/components/StatusBadge.vue";

describe("StatusBadge — Bulma tag color mapping", () => {
  const cases = [
    // task statuses
    { status: "pending", expected: "is-light" },
    { status: "running", expected: "is-info" },
    { status: "done", expected: "is-success" },
    { status: "failed", expected: "is-danger" },
    { status: "blocked", expected: "is-warning" },
    // plan statuses
    { status: "draft", expected: "is-light" },
    { status: "approved", expected: "is-primary" },
    { status: "executing", expected: "is-info" },
    { status: "completed", expected: "is-success" },
    { status: "abandoned", expected: "is-dark" },
  ];

  for (const { status, expected } of cases) {
    it(`maps ${status} → ${expected}`, () => {
      const wrapper = mount(StatusBadge, { props: { status } });
      expect(wrapper.classes()).toContain("tag");
      expect(wrapper.classes()).toContain(expected);
    });
  }

  it("falls back to is-light for unknown status", () => {
    const wrapper = mount(StatusBadge, {
      props: { status: "unknown" as any },
    });
    expect(wrapper.classes()).toContain("tag");
    expect(wrapper.classes()).toContain("is-light");
  });
});
