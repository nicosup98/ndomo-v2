<script setup lang="ts">
import { ref } from "vue";
import { useAuth } from "@/composables/useAuth";

const password = ref("");
const submitting = ref(false);
const error = ref<string | null>(null);
const { submitPassword } = useAuth();

async function handleSubmit(): Promise<void> {
  if (!password.value.trim()) return;
  submitting.value = true;
  error.value = null;
  submitPassword(password.value);
  password.value = "";
  submitting.value = false;
}
</script>

<template>
  <div class="modal is-active" role="dialog" aria-modal="true" aria-label="Authentication required">
    <div class="modal-background"></div>
    <div class="modal-content">
      <div class="box">
        <form @submit.prevent="handleSubmit">
          <h2 class="title is-4 has-text-centered">auth required</h2>
          <p class="subtitle is-6 has-text-grey has-text-centered mb-4">
            enter OPENCODE_SERVER_PASSWORD
          </p>
          <div class="field">
            <div class="control">
              <input
                v-model="password"
                class="input"
                type="password"
                placeholder="password"
                autofocus
                :disabled="submitting"
                aria-label="Password"
              />
            </div>
          </div>
          <div class="field">
            <div class="control">
              <button
                type="submit"
                class="button is-primary is-fullwidth"
                :disabled="submitting || !password.trim()"
              >
                submit
              </button>
            </div>
          </div>
          <p v-if="error" class="has-text-danger has-text-centered mt-3" role="alert">
            {{ error }}
          </p>
        </form>
      </div>
    </div>
  </div>
</template>
