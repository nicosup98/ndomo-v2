import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import StatusActions from "../src/components/StatusActions.vue";
import type { Plan, Task } from "../src/types/api";

// Mock mutations
const mockPlanApprove = vi.fn();
const mockPlanPatchStatus = vi.fn();
const mockPlanRemove = vi.fn();
const mockTaskPatchStatus = vi.fn();
const mockTaskRemove = vi.fn();

vi.mock("../src/composables/usePlanMutations", () => ({
  usePlanMutations: () => ({
    approve: mockPlanApprove,
    patchStatus: mockPlanPatchStatus,
    remove: mockPlanRemove,
    isLoading: { value: false },
    error: { value: null },
  }),
}));

vi.mock("../src/composables/useTaskMutations", () => ({
  useTaskMutations: () => ({
    patchStatus: mockTaskPatchStatus,
    remove: mockTaskRemove,
    isLoading: { value: false },
    error: { value: null },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const basePlan: Plan = {
  id: "p1",
  slug: "test",
  title: "Test",
  status: "draft",
  priority: 5,
  complexity: 3,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  approvedAt: null,
  completedAt: null,
  sessionId: null,
  overview: "overview",
  approach: null,
  createdBy: "user",
  updatedBy: "user",
  sourceSessionId: null,
  sourceMessageId: null,
  category: null,
  metadata: {},
  archivedAt: null,
};

const baseTask: Task = {
  id: "t1",
  planId: "p1",
  orderIndex: 0,
  description: "do stuff",
  agent: "craftsman",
  files: [],
  complexity: 2,
  status: "pending",
  startedAt: null,
  completedAt: null,
  result: null,
  error: null,
  dependencies: [],
  createdBy: "user",
  updatedBy: "user",
  sourceSessionId: null,
  sourceMessageId: null,
  reviewedBy: null,
  tokensUsed: null,
  durationMs: null,
  artifacts: [],
  metadata: {},
  archivedAt: null,
};

describe("StatusActions", () => {
  describe("plan=draft", () => {
    it("shows Approve button, hides Mark Complete", () => {
      const wrapper = mount(StatusActions, {
        props: { kind: "plan", plan: { ...basePlan, status: "draft" } },
      });

      expect(wrapper.text()).toContain("Approve");
      expect(wrapper.text()).not.toContain("Mark Complete");
      expect(wrapper.text()).not.toContain("Fail");
      expect(wrapper.text()).not.toContain("Archive");
    });

    it("calls approve on click", async () => {
      mockPlanApprove.mockResolvedValueOnce({});
      const wrapper = mount(StatusActions, {
        props: { kind: "plan", plan: { ...basePlan, status: "draft" } },
      });

      await wrapper.find("button").trigger("click");
      await flushPromises();

      expect(mockPlanApprove).toHaveBeenCalledWith("p1", "craftsman");
      expect(wrapper.emitted("changed")).toBeTruthy();
    });
  });

  describe("plan=approved", () => {
    it("shows Mark Complete and Fail, hides Approve", () => {
      const wrapper = mount(StatusActions, {
        props: { kind: "plan", plan: { ...basePlan, status: "approved" } },
      });

      expect(wrapper.text()).toContain("Mark Complete");
      expect(wrapper.text()).toContain("Fail");
      expect(wrapper.text()).not.toContain("Approve");
      expect(wrapper.text()).not.toContain("Archive");
    });
  });

  describe("plan=completed", () => {
    it("shows Archive only", () => {
      const wrapper = mount(StatusActions, {
        props: { kind: "plan", plan: { ...basePlan, status: "completed" } },
      });

      expect(wrapper.text()).toContain("Archive");
      expect(wrapper.text()).not.toContain("Approve");
      expect(wrapper.text()).not.toContain("Mark Complete");
    });
  });

  describe("task=pending", () => {
    it("shows Mark Done and Mark Failed", () => {
      const wrapper = mount(StatusActions, {
        props: { kind: "task", task: { ...baseTask, status: "pending" } },
      });

      expect(wrapper.text()).toContain("Mark Done");
      expect(wrapper.text()).toContain("Mark Failed");
      expect(wrapper.text()).not.toContain("Delete");
    });
  });

  describe("task=done", () => {
    it("shows Delete only", () => {
      const wrapper = mount(StatusActions, {
        props: { kind: "task", task: { ...baseTask, status: "done" } },
      });

      expect(wrapper.text()).toContain("Delete");
      expect(wrapper.text()).not.toContain("Mark Done");
    });
  });
});
