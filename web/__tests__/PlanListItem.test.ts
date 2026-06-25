import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import PlanListItem from "../src/components/PlanListItem.vue";
import type { Plan } from "../src/types/api";

const mockPlan: Plan = {
  id: "abc-123",
  slug: "test-plan",
  title: "Test Plan",
  status: "executing",
  priority: 2,
  complexity: 3,
  createdAt: Date.now() - 100_000,
  updatedAt: Date.now() - 10_000,
  approvedAt: null,
  completedAt: null,
  sessionId: null,
  overview: "A test plan",
  approach: null,
  createdBy: "test-user",
  updatedBy: "test-user",
  sourceSessionId: null,
  sourceMessageId: null,
  category: null,
  metadata: {},
  archivedAt: null,
};

describe("PlanListItem", () => {
  it("renders plan slug", () => {
    const wrapper = mount(PlanListItem, { props: { plan: mockPlan } });
    expect(wrapper.text()).toContain("test-plan");
  });

  it("renders status badge", () => {
    const wrapper = mount(PlanListItem, { props: { plan: mockPlan } });
    expect(wrapper.text()).toContain("executing");
  });

  it("renders priority and complexity", () => {
    const wrapper = mount(PlanListItem, { props: { plan: mockPlan } });
    expect(wrapper.text()).toContain("2");
    expect(wrapper.text()).toContain("3");
  });

  it("emits click on row click", async () => {
    const wrapper = mount(PlanListItem, { props: { plan: mockPlan } });
    await wrapper.find("tr").trigger("click");
    expect(wrapper.emitted("click")).toHaveLength(1);
    expect(wrapper.emitted("click")![0]).toEqual(["abc-123"]);
  });
});
