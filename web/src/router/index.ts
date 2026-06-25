import { createRouter, createWebHashHistory } from "vue-router";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      name: "dashboard",
      component: () => import("@/views/DashboardView.vue"),
    },
    {
      path: "/plans",
      name: "plans",
      component: () => import("@/views/PlanListView.vue"),
    },
    {
      path: "/plans/:id",
      name: "plan-detail",
      component: () => import("@/views/PlanDetailView.vue"),
      props: true,
    },
    {
      path: "/tasks/:id",
      name: "task-detail",
      component: () => import("@/views/TaskDetailView.vue"),
      props: true,
    },
    {
      path: "/:pathMatch(.*)*",
      name: "not-found",
      component: () => import("@/views/NotFoundView.vue"),
    },
  ],
});

export default router;
