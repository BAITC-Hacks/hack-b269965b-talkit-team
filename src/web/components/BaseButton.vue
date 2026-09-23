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
