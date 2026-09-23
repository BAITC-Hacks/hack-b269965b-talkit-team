<script setup lang="ts">
defineProps<{ status: string; healthy: boolean }>();
</script>
<template>
  <header class="topbar">
    <a class="brand" href="/">TalkIt <span>/ HackAlem Starter</span></a>
    <span class="status" :class="{ healthy }" role="status">{{ status }}</span>
  </header>
</template>

<style scoped>
.topbar {
  height: 88px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--line);
  gap: 16px;
}
.brand {
  font-weight: 750;
  font-size: 20px;
}
.brand span {
  color: var(--muted);
  font-size: 14px;
  font-weight: 500;
}
.status {
  font-size: 12px;
  border: 1px solid var(--line);
  padding: 7px 12px;
  border-radius: 20px;
}
.status.healthy {
  color: var(--success);
  background: #eef9f2;
  border-color: #cbe7d5;
}
@media (max-width: 720px) {
  .brand span {
    display: none;
  }
}
</style>
