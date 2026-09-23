<script lang="ts">
import {
  computed,
  defineComponent,
  onActivated,
  onDeactivated,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  watch,
  type PropType,
} from 'vue'

export type VoiceVisualizerVariant = 'waves' | 'lines' | 'hybrid'

const TAU = Math.PI * 2
const CENTER = 160
const LINE_COUNT = 88
const WAVE_SAMPLES = 80

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

function duration(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, value) : fallback
}

/** Decorative geometry, NOT a frequency spectrum reconstructed from one value. */
function shapeAt(angle: number, time: number): number {
  return (
    (0.5 + 0.5 * Math.sin(angle * 4 + time * 2.8)) * 0.45 +
    (0.5 + 0.5 * Math.cos(angle * 7 - time * 1.9)) * 0.30 +
    (0.5 + 0.5 * Math.sin(angle * 2 + time * 1.2)) * 0.25
  )
}

function wavePath(layer: number, amplitude: number, time: number): string {
  const points = Array.from({ length: WAVE_SAMPLES }, (_, index) => {
    const angle = (index / WAVE_SAMPLES) * TAU
    const displacement =
      Math.sin(angle * 3 + time * 1.5 + layer * 0.58) * 5.5 +
      Math.sin(angle * 5 - time * 1.1 + layer * 0.35) * 3.5 +
      Math.cos(angle * 2 + time * 0.7) * 2
    const radius = 99 + layer * 10 + amplitude * (5 + displacement)
    return [
      CENTER + Math.cos(angle) * radius,
      CENTER + Math.sin(angle) * radius,
    ] as const
  })

  // Closed quadratic spline: no visible seam where the ring meets itself.
  const first = points[0]!
  const last = points[points.length - 1]!
  let path = `M${((first[0] + last[0]) / 2).toFixed(2)},${((first[1] + last[1]) / 2).toFixed(2)}`
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!
    const next = points[(index + 1) % points.length]!
    path += `Q${point[0].toFixed(2)},${point[1].toFixed(2)} ${((point[0] + next[0]) / 2).toFixed(2)},${((point[1] + next[1]) / 2).toFixed(2)}`
  }
  return `${path}Z`
}

export default defineComponent({
  name: 'VoiceVisualizer',
  props: {
    /** An externally supplied amplitude. The component never reads audio. */
    value: { type: Number, required: true },
    variant: {
      type: String as PropType<VoiceVisualizerVariant>,
      default: 'hybrid',
      validator: (value: string) => ['waves', 'lines', 'hybrid'].includes(value),
    },
    size: { type: [Number, String] as PropType<number | string>, default: 280 },
    active: { type: Boolean, default: true },
    /** Time constants in milliseconds; independent of display refresh rate. */
    attack: { type: Number, default: 55 },
    release: { type: Number, default: 240 },
    /** Omit for a decorative visual. Supply a static accessible name if needed. */
    label: { type: String, default: undefined },
  },
  setup(props) {
    const root = ref<HTMLElement | null>(null)
    const target = computed(() => (props.active ? clamp01(props.value) : 0))
    const frame = shallowRef({ amplitude: target.value, time: 0 })
    const dimensions = computed(() => ({
      width: typeof props.size === 'number'
        ? `${Number.isFinite(props.size) ? Math.max(1, props.size) : 280}px`
        : props.size,
    }))

    const lines = computed(() => {
      const { amplitude, time } = frame.value
      const spread = props.variant === 'hybrid' ? 25 : 39
      return Array.from({ length: LINE_COUNT }, (_, index) => {
        const angle = (index / LINE_COUNT) * TAU - Math.PI / 2
        const shape = shapeAt(angle, time)
        const start = 82 + amplitude * Math.sin(angle * 3 + time) * 2
        const end = start + 4 + amplitude * (8 + shape * spread)
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        return {
          x1: CENTER + cos * start,
          y1: CENTER + sin * start,
          x2: CENTER + cos * end,
          y2: CENTER + sin * end,
          opacity: 0.20 + amplitude * (0.24 + shape * 0.56),
        }
      })
    })

    const waves = computed(() => {
      const { amplitude, time } = frame.value
      return Array.from({ length: 4 }, (_, layer) => ({
        d: wavePath(layer, amplitude, time),
        opacity: props.variant === 'waves'
          ? (0.20 + amplitude * 0.56) * (1 - layer * 0.22)
          : (0.10 + amplitude * 0.28) * (1 - layer * 0.22),
      }))
    })

    const centerBars = computed(() => {
      const { amplitude, time } = frame.value
      return [0.32, 0.68, 1, 0.68, 0.32].map((weight, index) => {
        const motion = 0.5 + 0.5 * Math.sin(time * 5.5 + index * 1.1)
        const height = 4 + weight * 5 + amplitude * weight * (10 + motion * 9)
        return { x: 8 + index * 6, y1: 20 - height / 2, y2: 20 + height / 2 }
      })
    })

    let mounted = false
    let visible = true
    let deactivated = false
    let reducedMotion = false
    let animationId: number | null = null
    let previousTime: number | null = null
    let media: MediaQueryList | undefined
    let observer: IntersectionObserver | undefined

    function stop(): void {
      if (animationId !== null) cancelAnimationFrame(animationId)
      animationId = null
      previousTime = null
    }

    function canAnimate(): boolean {
      return mounted && visible && !deactivated && !document.hidden
    }

    function tick(timestamp: number): void {
      animationId = null
      if (!canAnimate()) return

      const dt = previousTime === null ? 1000 / 60 : Math.min(50, timestamp - previousTime)
      previousTime = timestamp
      const current = frame.value.amplitude
      const goal = target.value
      const tau = goal > current ? duration(props.attack, 55) : duration(props.release, 240)
      const interpolated = current + (goal - current) * (1 - Math.exp(-dt / tau))
      const amplitude = Math.abs(goal - interpolated) < 0.0005 ? goal : interpolated
      frame.value = {
        amplitude,
        time: frame.value.time + (dt / 1000) * (0.6 + amplitude * 0.8),
      }

      // Zero becomes truly still: no perpetual idle loop or fake speech.
      if (amplitude > 0 || goal > 0) animationId = requestAnimationFrame(tick)
      else previousTime = null
    }

    function wake(): void {
      if (!mounted) return
      if (reducedMotion) {
        stop()
        frame.value = { amplitude: target.value, time: 0 }
        return
      }
      if (!canAnimate() || animationId !== null) return
      if (target.value === 0 && frame.value.amplitude === 0) return
      animationId = requestAnimationFrame(tick)
    }

    function onVisibility(): void {
      if (document.hidden) stop()
      else wake()
    }

    function onMotionChange(event: MediaQueryListEvent): void {
      reducedMotion = event.matches
      wake()
    }

    watch(target, wake)

    onMounted(() => {
      mounted = true
      media = window.matchMedia('(prefers-reduced-motion: reduce)')
      reducedMotion = media.matches
      media.addEventListener('change', onMotionChange)
      document.addEventListener('visibilitychange', onVisibility)

      if ('IntersectionObserver' in window && root.value) {
        observer = new IntersectionObserver(([entry]) => {
          visible = entry?.isIntersecting ?? true
          if (visible) wake()
          else stop()
        })
        observer.observe(root.value)
      }
      wake()
    })

    onActivated(() => { deactivated = false; wake() })
    onDeactivated(() => { deactivated = true; stop() })
    onUnmounted(() => {
      mounted = false
      stop()
      observer?.disconnect()
      media?.removeEventListener('change', onMotionChange)
      document.removeEventListener('visibilitychange', onVisibility)
    })

    return { root, frame, dimensions, lines, waves, centerBars }
  },
})
</script>

<template>
  <div
    ref="root"
    class="voice-visualizer"
    :style="dimensions"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : true"
    :data-variant="variant"
    :data-active="active"
  >
    <svg class="voice-visualizer__canvas" viewBox="0 0 320 320" fill="none" aria-hidden="true">
      <circle cx="160" cy="160" r="147" stroke="currentColor" stroke-opacity="0.065" stroke-width="0.8" />
      <g fill="currentColor" opacity="0.20">
        <circle cx="160" cy="13" r="1.3" />
        <circle cx="307" cy="160" r="1.3" />
        <circle cx="160" cy="307" r="1.3" />
        <circle cx="13" cy="160" r="1.3" />
      </g>

      <g v-if="variant !== 'lines'" stroke="currentColor" stroke-width="1.05">
        <path v-for="(wave, index) in waves" :key="index" :d="wave.d" :opacity="wave.opacity" />
      </g>

      <g v-if="variant !== 'waves'" stroke="currentColor" stroke-width="1.65" stroke-linecap="round">
        <line v-for="(line, index) in lines" :key="index" v-bind="line" />
      </g>

      <circle cx="160" cy="160" :r="54 + frame.amplitude * 2" fill="currentColor" :fill-opacity="0.022 + frame.amplitude * 0.016" />
      <circle cx="160" cy="160" :r="54 + frame.amplitude * 2" stroke="currentColor" stroke-opacity="0.075" stroke-width="0.8" />
    </svg>

    <div class="voice-visualizer__center">
      <slot :value="frame.amplitude">
        <svg viewBox="0 0 40 40" class="voice-visualizer__glyph" fill="none" aria-hidden="true">
          <g stroke="currentColor" stroke-width="2.7" stroke-linecap="round" :opacity="0.45 + frame.amplitude * 0.5">
            <line v-for="(bar, index) in centerBars" :key="index" :x1="bar.x" :x2="bar.x" :y1="bar.y1" :y2="bar.y2" />
          </g>
        </svg>
      </slot>
    </div>
  </div>
</template>

<style scoped>
.voice-visualizer {
  position: relative;
  display: inline-grid;
  flex: none;
  max-width: 100%;
  aspect-ratio: 1;
  vertical-align: middle;
  isolation: isolate;
  user-select: none;
  /* Intentionally inherit color: text-foreground / text-primary work as-is. */
}
.voice-visualizer__canvas { display: block; width: 100%; height: 100%; grid-area: 1 / 1; }
.voice-visualizer__center {
  position: absolute;
  inset: 33%;
  display: grid;
  place-items: center;
  border-radius: 50%;
}
.voice-visualizer__glyph { width: 43%; height: 43%; overflow: visible; }
</style>
