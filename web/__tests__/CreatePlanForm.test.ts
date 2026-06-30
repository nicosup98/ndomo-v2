import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import CreatePlanForm from "../src/components/CreatePlanForm.vue";

// Mock usePlanMutations
const mockCreate = vi.fn();
vi.mock("../src/composables/usePlanMutations", () => ({
  usePlanMutations: () => ({
    create: mockCreate,
    isLoading: { value: false },
    error: { value: null },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CreatePlanForm", () => {
  it("submits valid data and emits created", async () => {
    const createdPlan = { id: "p1", slug: "test-plan", title: "Test" };
    mockCreate.mockResolvedValueOnce(createdPlan);

    const wrapper = mount(CreatePlanForm);

    // Fill form
    await wrapper.find('input[placeholder="my-plan"]').setValue("test-plan");
    await wrapper.find('input[placeholder="Plan title"]').setValue("Test Plan");
    await wrapper.find('textarea').setValue("A valid overview with enough characters");

    // Submit
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "test-plan",
        title: "Test Plan",
        overview: "A valid overview with enough characters",
        createdBy: "craftsman",
        priority: 5,
        complexity: 3,
        category: "feature",
      }),
    );

    expect(wrapper.emitted("created")).toBeTruthy();
    expect(wrapper.emitted("created")![0]).toEqual([createdPlan]);
  });

  it("rejects empty slug — shows inline error, no submit", async () => {
    const wrapper = mount(CreatePlanForm);

    // Leave slug empty, fill other fields
    await wrapper.find('input[placeholder="Plan title"]').setValue("Title");
    await wrapper.find('textarea').setValue("A valid overview with enough characters");

    // Submit should not call create
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(mockCreate).not.toHaveBeenCalled();

    // Button should be disabled
    const submitBtn = wrapper.find('button[type="submit"]');
    expect(submitBtn.attributes("disabled")).toBeDefined();
  });

  it("rejects invalid slug format", async () => {
    const wrapper = mount(CreatePlanForm);

    await wrapper.find('input[placeholder="my-plan"]').setValue("Invalid Slug!");
    await wrapper.find('input[placeholder="Plan title"]').setValue("Title");
    await wrapper.find('textarea').setValue("A valid overview with enough characters");

    const submitBtn = wrapper.find('button[type="submit"]');
    expect(submitBtn.attributes("disabled")).toBeDefined();
  });

  it("rejects overview shorter than 10 chars", async () => {
    const wrapper = mount(CreatePlanForm);

    await wrapper.find('input[placeholder="my-plan"]').setValue("plan");
    await wrapper.find('input[placeholder="Plan title"]').setValue("Title");
    await wrapper.find('textarea').setValue("Short");

    const submitBtn = wrapper.find('button[type="submit"]');
    expect(submitBtn.attributes("disabled")).toBeDefined();
  });

  it("emits cancel when cancel button clicked", async () => {
    const wrapper = mount(CreatePlanForm);

    await wrapper.find("button.btn-ghost").trigger("click");

    expect(wrapper.emitted("cancel")).toBeTruthy();
  });
});
