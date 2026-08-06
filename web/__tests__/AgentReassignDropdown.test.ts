import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import AgentReassignDropdown from "../src/components/AgentReassignDropdown.vue";

// Mock useTaskMutations
const mockReassign = vi.fn();
vi.mock("../src/composables/useTaskMutations", () => ({
  useTaskMutations: () => ({
    reassign: mockReassign,
    isLoading: { value: false },
    error: { value: null },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentReassignDropdown", () => {
  it("renders current agent in button", () => {
    const wrapper = mount(AgentReassignDropdown, {
      props: { taskId: "t1", currentAgent: "craftsman" },
    });

    expect(wrapper.text()).toContain("craftsman");
  });

  it("lists all agents in dropdown", () => {
    const wrapper = mount(AgentReassignDropdown, {
      props: { taskId: "t1", currentAgent: "craftsman" },
    });

    const agentNames = [
      "craftsman", "js-smith", "vue-smith", "go-smith", "python-smith",
      "smith", "rust-smith", "ranger", "scout", "scribe", "inspector",
      "chronicler", "painter",
    ];

    for (const agent of agentNames) {
      expect(wrapper.text()).toContain(agent);
    }
  });

  it("calls reassign and emits reassigned on agent click", async () => {
    const reassignedTask = { id: "t1", agent: "js-smith" };
    mockReassign.mockResolvedValueOnce(reassignedTask);

    const wrapper = mount(AgentReassignDropdown, {
      props: { taskId: "t1", currentAgent: "craftsman" },
    });

    // Find the js-smith link and click it
    const links = wrapper.findAll("a");
    const jsSmithLink = links.find((l) => l.text().includes("js-smith"));
    expect(jsSmithLink).toBeTruthy();

    await jsSmithLink!.trigger("click");
    await flushPromises();

    expect(mockReassign).toHaveBeenCalledWith("t1", {
      agent: "js-smith",
      updatedBy: "craftsman",
    });
    expect(wrapper.emitted("reassigned")).toBeTruthy();
    expect(wrapper.emitted("reassigned")![0]).toEqual([reassignedTask]);
  });

  it("does not call reassign when clicking current agent", async () => {
    const wrapper = mount(AgentReassignDropdown, {
      props: { taskId: "t1", currentAgent: "craftsman" },
    });

    const links = wrapper.findAll("a");
    const craftsmanLink = links.find((l) => l.text().includes("craftsman"));
    await craftsmanLink!.trigger("click");
    await flushPromises();

    expect(mockReassign).not.toHaveBeenCalled();
    expect(wrapper.emitted("reassigned")).toBeFalsy();
  });
});
