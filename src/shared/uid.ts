/**
 * Short unique id with a type prefix ("c_", "v_", "s_", "d_").
 *
 * One implementation for the whole app. Ids become JSON keys and parts of file
 * names inside a world directory, so they only need to be unique within a
 * project — but the renderer, the structured outline and the forge pipeline used
 * to invent three different shapes, which made ids impossible to reason about
 * across layers. The platform UUID is used when available and a random base36
 * fallback keeps it working in older browsers and plain Node.
 */
export function uid(prefix = ''): string {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.()
  if (uuid) return `${prefix}${uuid.replace(/-/g, '').slice(0, 16)}`
  return `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
}
