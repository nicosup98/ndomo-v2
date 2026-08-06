import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import CreateTaskForm from "../src/components/CreateTaskForm.vue";

// Mock useTaskMutations
const mockCreate = vi.fn();
vi.mock("../src/composables/useTaskMutations", () => ({
  useTaskMutations: () => ({
    create: mockCreate,
    isLoading: { value: false },
    error: { value: null },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CreateTaskForm", () => {
  it("submits valid data and emits created", async () => {
    const createdTask = { id: "t1", description: "Do the thing", agent: "craftsman" };
    mockCreate.mockResolvedValueOnce(createdTask);

    const wrapper = mount(CreateTaskForm, {
      props: { planId: "p1" },
    });

    // Fill description
    await wrapper.find("textarea").setValue("Do the thing");

    // Submit
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(mockCreate).toHaveBeenCalledWith("p1", {
      description: "Do the thing",
      agent: "craftsman",
      complexity: 2,
    });

    expect(wrapper.emitted("created")).toBeTruthy();
    expect(wrapper.emitted("created")![0]).toEqual([createdTask]);
  });

  it("rejects empty description", async () => {
    const wrapper = mount(CreateTaskForm, {
      props: { planId: "p1" },
    });

    // Submit with empty description
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(mockCreate).not.toHaveBeenCalled();

    // Button should be disabled
    const submitBtn = wrapper.find('button[type="submit"]');
    expect(submitBtn.attributes("disabled")).toBeDefined();
  });

  it("parses comma-separated files", async () => {
    const createdTask = { id: "t1", description: "test" };
    mockCreate.mockResolvedValueOnce(createdTask);

    const wrapper = mount(CreateTaskForm, {
      props: { planId: "p1" },
    });

    await wrapper.find("textarea").setValue("test task");
    await wrapper.find('input[placeholder*="comma-separated"]').setValue("src/a.ts, src/b.ts");

    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(mockCreate).toHaveBeenCalledWith("p1", {
      description: "test task",
      agent: "craftsman",
      complexity: 2,
      files: ["src/a.ts", "src/b.ts"],
    });
  });

  it("emits cancel when cancel button clicked", async () => {
    const wrapper = mount(CreateTaskForm, {
      props: { planId: "p1" },
    });

    await wrapper.find("button.btn-ghost").trigger("click");

    expect(wrapper.emitted("cancel")).toBeTruthy();
  });
});
