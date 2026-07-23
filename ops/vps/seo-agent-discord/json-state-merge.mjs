export function mergeJsonChanges(baseline, local, latest) {
  if (jsonEqual(local, baseline)) return structuredClone(latest)
  if (Array.isArray(local) || Array.isArray(baseline) || Array.isArray(latest)) return structuredClone(local)
  if (!isPlainObject(local) || !isPlainObject(baseline) || !isPlainObject(latest)) return structuredClone(local)
  const merged = structuredClone(latest)
  const keys = new Set([...Object.keys(baseline), ...Object.keys(local)])
  for (const key of keys) {
    if (!(key in local)) {
      if (key in baseline) delete merged[key]
      continue
    }
    if (!(key in baseline)) {
      merged[key] = structuredClone(local[key])
      continue
    }
    merged[key] = mergeJsonChanges(baseline[key], local[key], latest[key])
  }
  return merged
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}
