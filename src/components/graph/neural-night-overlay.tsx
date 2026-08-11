import { useEffect } from "react"
import { useSigma } from "@react-sigma/core"
import {
  isNeuralNightRingNode,
  neuralNightHash,
  neuralNightOverlayBudget,
} from "@/lib/graph-visual-style"

/**
 * Scene dressing for the Neural Night style, painted on two extra 2D
 * canvases around sigma's own WebGL layers:
 *
 *   glow canvas (below sigma's edges): multi-layer halos, starburst rays
 *     on hub nodes, and a sparkle field anchored to node clusters.
 *   core canvas (above sigma's nodes, below labels): near-white hot
 *     centers on hubs and the hollow look of ring nodes.
 *
 * Everything is deterministic (hash of node id / sparkle index), so the
 * scene is stable across renders and zooms. The per-frame budget comes
 * from neuralNightOverlayBudget and collapses to zero on huge graphs.
 */

const HOT_CENTER = "207,234,255" // #cfeaff
const RAY_JITTER = 0.9

function hexToRgbTriplet(hex: string): string {
  const value = hex.replace("#", "")
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value
  const num = Number.parseInt(full, 16)
  if (Number.isNaN(num)) return "77,166,255"
  return `${(num >> 16) & 255},${(num >> 8) & 255},${num & 255}`
}

function unitRandom(seed: number): number {
  // xorshift-style scramble of a 32-bit seed into [0, 1)
  let x = seed || 1
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  return ((x >>> 0) % 100000) / 100000
}

type OverlayNode = {
  id: string
  x: number
  y: number
  size: number
  color: string
}

export function NeuralNightOverlay({ nodeCount }: { nodeCount: number }) {
  const sigma = useSigma()

  useEffect(() => {
    const canvases = sigma.getCanvases()
    const edgesCanvas = canvases.edges
    const labelsCanvas = canvases.labels
    const parent = edgesCanvas?.parentElement
    if (!edgesCanvas || !parent) return

    const makeLayer = (before: HTMLElement | null): HTMLCanvasElement => {
      const canvas = document.createElement("canvas")
      canvas.style.position = "absolute"
      canvas.style.inset = "0"
      canvas.style.pointerEvents = "none"
      parent.insertBefore(canvas, before)
      return canvas
    }

    const glowCanvas = makeLayer(edgesCanvas)
    const coreCanvas = makeLayer(labelsCanvas ?? null)

    const syncSize = (canvas: HTMLCanvasElement, width: number, height: number, dpr: number) => {
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
      }
    }

    const paint = () => {
      const budget = neuralNightOverlayBudget(nodeCount)
      const width = parent.clientWidth
      const height = parent.clientHeight
      const dpr = window.devicePixelRatio || 1
      syncSize(glowCanvas, width, height, dpr)
      syncSize(coreCanvas, width, height, dpr)

      const glow = glowCanvas.getContext("2d")
      const core = coreCanvas.getContext("2d")
      if (!glow || !core) return
      glow.setTransform(dpr, 0, 0, dpr, 0, 0)
      core.setTransform(dpr, 0, 0, dpr, 0, 0)
      glow.clearRect(0, 0, width, height)
      core.clearRect(0, 0, width, height)
      if (budget.haloNodes === 0) return

      const graph = sigma.getGraph()
      const ratio = sigma.getCamera().ratio
      const sizeScale = 1 / Math.pow(ratio, 0.5)
      const margin = 160

      const visible: OverlayNode[] = []
      let maxSize = 1
      graph.forEachNode((id, attrs) => {
        const viewport = sigma.graphToViewport({ x: attrs.x as number, y: attrs.y as number })
        if (
          viewport.x < -margin || viewport.x > width + margin ||
          viewport.y < -margin || viewport.y > height + margin
        ) {
          return
        }
        const size = ((attrs.size as number) || 4) * sizeScale
        if (size > maxSize) maxSize = size
        visible.push({ id, x: viewport.x, y: viewport.y, size, color: (attrs.color as string) || "#4da6ff" })
      })
      if (visible.length === 0) return

      const bySize = [...visible].sort((a, b) => b.size - a.size)
      const haloNodes = bySize.slice(0, budget.haloNodes)
      const rayHubs = bySize.slice(0, budget.rayHubs)
      const rayHubIds = new Set(rayHubs.map((n) => n.id))

      // Sparkle field: tiny points orbiting real nodes, so the dust sits in
      // and around the clusters at any zoom level.
      glow.globalCompositeOperation = "lighter"
      for (let i = 0; i < budget.sparkles; i++) {
        const anchor = visible[neuralNightHash(`sparkle-${i}`) % visible.length]
        const angle = unitRandom(i * 2654435761) * Math.PI * 2
        const distance = 8 + unitRandom((i + 7) * 40503) * 46
        const x = anchor.x + Math.cos(angle) * distance
        const y = anchor.y + Math.sin(angle) * distance
        const alpha = 0.2 + unitRandom((i + 13) * 9176) * 0.4
        const radius = 0.6 + unitRandom((i + 3) * 15731) * 1
        glow.fillStyle = `rgba(190,225,255,${alpha.toFixed(3)})`
        glow.beginPath()
        glow.arc(x, y, radius, 0, Math.PI * 2)
        glow.fill()
      }

      // Multi-layer bloom halos. Hubs get a double layer (reference: big
      // soft #2979ff halos, 3-5x the core), satellites a single soft disc.
      for (const node of haloNodes) {
        const rgb = hexToRgbTriplet(node.color)
        const isHub = rayHubIds.has(node.id)
        const layers: Array<[number, number]> = isHub
          ? [[2.4, 0.32], [5, 0.14]]
          : [[3, 0.18]]
        for (const [reach, alpha] of layers) {
          const radius = Math.max(node.size * reach, 6)
          const gradient = glow.createRadialGradient(node.x, node.y, node.size * 0.4, node.x, node.y, radius)
          gradient.addColorStop(0, `rgba(${rgb},${alpha})`)
          gradient.addColorStop(1, `rgba(${rgb},0)`)
          glow.fillStyle = gradient
          glow.beginPath()
          glow.arc(node.x, node.y, radius, 0, Math.PI * 2)
          glow.fill()
        }
      }

      // Starburst rays on hubs: 20-40 thin spokes, 2-6x the node radius,
      // fading outwards. Two plain strokes per ray keep this cheap.
      glow.lineCap = "round"
      for (const hub of rayHubs) {
        const rgb = hexToRgbTriplet(hub.color)
        const rays = budget.raysPerHub
        const baseSeed = neuralNightHash(hub.id)
        for (let i = 0; i < rays; i++) {
          const jitter = (unitRandom(baseSeed + i * 101) - 0.5) * RAY_JITTER
          const angle = (i / rays) * Math.PI * 2 + jitter
          const length = hub.size * (2 + unitRandom(baseSeed + i * 211) * 4)
          const innerEnd = hub.size * 1.1 + (length - hub.size * 1.1) * 0.45
          const cos = Math.cos(angle)
          const sin = Math.sin(angle)

          glow.strokeStyle = `rgba(${rgb},0.4)`
          glow.lineWidth = 0.9
          glow.beginPath()
          glow.moveTo(hub.x + cos * hub.size * 1.05, hub.y + sin * hub.size * 1.05)
          glow.lineTo(hub.x + cos * innerEnd, hub.y + sin * innerEnd)
          glow.stroke()

          glow.strokeStyle = `rgba(${rgb},0.13)`
          glow.lineWidth = 0.6
          glow.beginPath()
          glow.moveTo(hub.x + cos * innerEnd, hub.y + sin * innerEnd)
          glow.lineTo(hub.x + cos * length, hub.y + sin * length)
          glow.stroke()
        }
      }
      glow.globalCompositeOperation = "source-over"

      // Core layer: hollow ring nodes and near-white hot centers.
      for (const node of visible) {
        const sizeNorm = node.size / maxSize
        if (isNeuralNightRingNode(node.id, sizeNorm)) {
          core.fillStyle = "rgba(8,17,34,0.92)"
          core.beginPath()
          core.arc(node.x, node.y, Math.max(node.size * 0.62, 1.4), 0, Math.PI * 2)
          core.fill()
          core.strokeStyle = `rgba(${hexToRgbTriplet(node.color)},0.9)`
          core.lineWidth = Math.max(node.size * 0.18, 1)
          core.beginPath()
          core.arc(node.x, node.y, Math.max(node.size * 0.78, 2), 0, Math.PI * 2)
          core.stroke()
        }
      }
      core.globalCompositeOperation = "lighter"
      for (const hub of rayHubs) {
        const radius = Math.max(hub.size * 0.75, 2)
        const gradient = core.createRadialGradient(hub.x, hub.y, 0, hub.x, hub.y, radius)
        gradient.addColorStop(0, `rgba(${HOT_CENTER},0.95)`)
        gradient.addColorStop(0.55, `rgba(${HOT_CENTER},0.4)`)
        gradient.addColorStop(1, `rgba(${HOT_CENTER},0)`)
        core.fillStyle = gradient
        core.beginPath()
        core.arc(hub.x, hub.y, radius, 0, Math.PI * 2)
        core.fill()
      }
      core.globalCompositeOperation = "source-over"
    }

    sigma.on("afterRender", paint)
    paint()

    return () => {
      sigma.off("afterRender", paint)
      glowCanvas.remove()
      coreCanvas.remove()
    }
  }, [sigma, nodeCount])

  return null
}
