<script setup lang="ts">
import { Button } from "./button/index.ts";

withDefaults(
  defineProps<{ busy?: boolean; variant?: "primary" | "secondary"; type?: "button" | "submit" }>(),
  {
    busy: false,
    variant: "primary",
    type: "button",
  },
);
</script>
<template>
  <Button
    :type="type"
    :variant="variant === 'primary' ? 'default' : 'secondary'"
    :disabled="busy"
    :aria-busy="busy"
  >
    <span v-if="busy" class="spinner" aria-hidden="true"></span>
    <slot />
  </Button>
</template>

<style scoped>
.spinner {
  width: 13px;
  height: 13px;
  border: 2px solid #ffffff60;
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
}
</style>
