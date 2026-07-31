import type { SlopCalibrationSample, SlopDimId, SlopWeights } from '../types'
import { DEFAULT_SLOP_WEIGHTS } from './analyze'

/**
 * Human-in-the-loop weight calibration for the local slop detector.
 *
 * Zhuque (zhuque.tencent.com) has no public API, so the user manually runs a
 * chapter through it and backfills its three percentages (AI-feature %,
 * suspected-AI %, human-feature %). We fit weights toward the suspected-AI %
 * (the closest analogue to the local 0-100 machine-smell score); the other
 * two are kept for display. We then fit the
 * detector's dimension weights toward those real measurements using ridge
 * regression, regularized toward the default weights so a handful of samples
 * can't wildly distort scoring. This makes the *local* score trend with
 * Zhuque; it does not (and cannot) "beat" the detector.
 */

const DIM_ORDER: SlopDimId[] = [
  'burstiness',
  'connectives',
  'parallelism',
  'abstractNouns',
  'sentenceHeadRepetition',
  'punctuationMonotony',
  'idiomDensity',
  'paragraphUniformity',
]

/** Ridge strength: higher = stick closer to defaults. With few samples this
 *  keeps the fit stable; it shrinks as more evidence accumulates naturally. */
const RIDGE_LAMBDA = 0.05
/** Floor so no dimension can be zeroed out by the fit. */
const WEIGHT_FLOOR = 0.02

/**
 * Fit detector weights to backfilled Zhuque scores via ridge regression toward
 * the default weights. Returns null if there are too few backfilled samples.
 *
 * Model: predicted_i = 100 * sum_j(w_j * x_ij), with sum(w_j) = 1 (the analyzer
 * normalizes by the weight sum, and defaults already sum to 1). The fit
 * minimizes sum_i(predicted_i/100 - zhuque_i/100)^2 + lambda*||w - w_default||^2
 * via coordinate descent, then clips negatives and renormalizes.
 */
export function calibrateWeights(
  samples: SlopCalibrationSample[],
  baseWeights: SlopWeights = DEFAULT_SLOP_WEIGHTS,
): SlopWeights | null {
  const scored = samples.filter((s) => s.suspectedAi != null)
  // Need at least 2 points for the fit to mean anything.
  if (scored.length < 2) return null

  const w0 = DIM_ORDER.map((d) => baseWeights[d])
  const w = [...w0]
  // Targets in 0-1 (zhuque % / 100).
  const z = scored.map((s) => (s.suspectedAi as number) / 100)
  // Feature matrix rows in DIM_ORDER order.
  const X = scored.map((s) => DIM_ORDER.map((d) => s.features[d]))

  // Coordinate descent for ridge regression. Closed-form per coordinate:
  //   w_j = (sum_i x_ij * r_i + lambda * w0_j) / (sum_i x_ij^2 + lambda)
  // where r_i = z_i - sum_{k!=j} x_ik * w_k.
  for (let iter = 0; iter < 500; iter++) {
    let moved = 0
    for (let j = 0; j < DIM_ORDER.length; j++) {
      let num = 0
      let den = 0
      for (let i = 0; i < scored.length; i++) {
        const xij = X[i][j]
        // residual excluding dimension j
        let pred = 0
        for (let k = 0; k < DIM_ORDER.length; k++) {
          if (k !== j) pred += X[i][k] * w[k]
        }
        const r = z[i] - pred
        num += xij * r
        den += xij * xij
      }
      den += RIDGE_LAMBDA
      num += RIDGE_LAMBDA * w0[j]
      const next = num / den
      moved += Math.abs(next - w[j])
      w[j] = next
    }
    if (moved < 1e-6) break
  }

  // Clip negatives, floor small values, renormalize to sum to the base total.
  const baseTotal = w0.reduce((a, b) => a + b, 0) || 1
  const clipped = w.map((v) => Math.max(v, WEIGHT_FLOOR))
  const sum = clipped.reduce((a, b) => a + b, 0) || 1
  const scaled = clipped.map((v) => (v / sum) * baseTotal)

  const out = { ...baseWeights }
  for (let j = 0; j < DIM_ORDER.length; j++) out[DIM_ORDER[j]] = scaled[j]
  return out
}

/** Predict a Zhuque-style score (0-100) for a sample under given weights. */
export function predictScore(features: Record<SlopDimId, number>, weights: SlopWeights): number {
  let num = 0
  let den = 0
  for (const d of DIM_ORDER) {
    num += features[d] * weights[d]
    den += weights[d]
  }
  return Math.round(Math.min(1, Math.max(0, den ? num / den : 0)) * 100)
}

/** Mean absolute error between predicted and backfilled Zhuque scores. */
export function calibrationError(
  samples: SlopCalibrationSample[],
  weights: SlopWeights,
): number | null {
  const scored = samples.filter((s) => s.suspectedAi != null)
  if (scored.length === 0) return null
  const sum = scored.reduce(
    (a, s) => a + Math.abs(predictScore(s.features, weights) - (s.suspectedAi as number)),
    0,
  )
  return Math.round(sum / scored.length)
}
