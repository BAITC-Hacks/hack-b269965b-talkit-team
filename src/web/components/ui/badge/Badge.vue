<script setup lang="ts">
import type { PrimitiveProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import type { BadgeVariants } from "./index.ts";
import { reactiveOmit } from "@vueuse/core";
import { Primitive } from "reka-ui";
import { cn, omitUndefinedProps } from "../../../lib/utils.ts";
import { badgeVariants } from "./index.ts";

const props = defineProps<
  PrimitiveProps & {
    variant?: BadgeVariants["variant"];
    class?: HTMLAttributes["class"];
  }
>();

const delegatedProps = omitUndefinedProps(reactiveOmit(props, "class"));
</script>

<template>
  <Primitive
    data-slot="badge"
    :class="cn(badgeVariants({ variant }), props.class)"
    v-bind="delegatedProps"
  >
    <slot />
  </Primitive>
</template>
