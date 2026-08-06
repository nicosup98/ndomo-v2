import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createRouter, createMemoryHistory } from "vue-router";
import PlanListView from "../src/views/PlanListView.vue";
import type { Plan } from "../src/types/api";

// Mock the API modules
vi.mock("../src/api/plans", () => ({
  listPlans: vi.fn(),
}));

// Mock useSseRefresh — no EventSource in happy-dom
vi.mock("../src/composables/useSseRefresh", () => ({
  useSseRefresh: () => ({ status: { value: "CONNECTING" } }),
}));

import { listPlans } from "../src/api/plans";

const mockPlans: Plan[] = [
  {
    id: "p1",
    slug: "plan-alpha",
    title: "Alpha",
    status: "draft",
    priority: 1,
    complexity: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    approvedAt: null,
    completedAt: null,
    sessionId: null,
    overview: "First plan",
    approach: null,
    createdBy: "user",
    updatedBy: "user",
    sourceSessionId: null,
    sourceMessageId: null,
    category: null,
    metadata: {},
    archivedAt: null,
  },
  {
    id: "p2",
    slug: "plan-beta",
    title: "Beta",
    status: "completed",
    priority: 3,
    complexity: 4,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    approvedAt: Date.now(),
    completedAt: Date.now(),
    sessionId: null,
    overview: "Second plan",
    approach: null,
    createdBy: "user",
    updatedBy: "user",
    sourceSessionId: null,
    sourceMessageId: null,
    category: null,
    metadata: {},
    archivedAt: null,
  },
];

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div />" } },
      { path: "/plans", component: PlanListView },
      { path: "/plans/:id", component: { template: "<div />" } },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPlans).mockResolvedValue(mockPlans);
});

describe("PlanListView", () => {
  it("renders plans table after load", async () => {
    const router = createTestRouter();
    await router.push("/plans");
    await router.isReady();

    const wrapper = mount(PlanListView, {
      global: { plugins: [router] },
    });

    // Wait for async data
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("plan-alpha");
    });
    expect(wrapper.text()).toContain("plan-beta");
  });

  it("renders status badges", async () => {
    const router = createTestRouter();
    await router.push("/plans");
    await router.isReady();

    const wrapper = mount(PlanListView, {
      global: { plugins: [router] },
    });

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("draft");
    });
    expect(wrapper.text()).toContain("completed");
  });

  it("has filter select", async () => {
    const router = createTestRouter();
    await router.push("/plans");
    await router.isReady();

    const wrapper = mount(PlanListView, {
      global: { plugins: [router] },
    });

    const select = wrapper.find("select");
    expect(select.exists()).toBe(true);
  });
});
