/**
 * ndomo web — Auth composable.
 *
 * Password stored in sessionStorage (tab-scoped).
 * isAuthed is a module-level ref shared across components.
 */

import { ref } from "vue";
import { getPassword, setPassword, clearPassword } from "@/api/client";

const isAuthed = ref(getPassword() !== null);

export function useAuth() {
  function submitPassword(pw: string): void {
    setPassword(pw);
    isAuthed.value = true;
  }

  function logout(): void {
    clearPassword();
    isAuthed.value = false;
  }

  return { isAuthed, submitPassword, logout };
}
