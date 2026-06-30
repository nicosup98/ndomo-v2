<script setup lang="ts">
/**
 * CreatePlanView — hosts CreatePlanForm, routes on success/cancel.
 */
import { useRouter } from "vue-router";
import CreatePlanForm from "@/components/CreatePlanForm.vue";
import type { Plan } from "@/types/api";

const router = useRouter();

function handleCreated(plan: Plan): void {
  router.push(`/plans/${plan.id}`);
}

function handleCancel(): void {
  router.back();
}
</script>

<template>
  <div class="card">
    <div class="card-body">
      <h2 class="card-title text-lg mb-4">Create New Plan</h2>
      <CreatePlanForm @created="handleCreated" @cancel="handleCancel" />
    </div>
  </div>
</template>
