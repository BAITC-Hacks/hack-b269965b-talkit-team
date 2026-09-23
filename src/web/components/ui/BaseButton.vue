<script setup lang="ts">
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
  <button :type="type" class="button" :class="variant" :disabled="busy" :aria-busy="busy">
    <span v-if="busy" class="spinner" aria-hidden="true"></span>
    <slot />
  </button>
</template>

<style scoped>
.button {
  border: 0;
  border-radius: 9px;
  padding: 12px 16px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 13px;
}
.button.primary {
  background: var(--brand);
  color: white;
}
.button.secondary {
  background: #eef0f5;
  color: #171717;
}
.button:disabled {
  opacity: 0.65;
  cursor: wait;
}
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
