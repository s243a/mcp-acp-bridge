/**
 * Response-time shaping for the supervisor — make its verdicts land on a
 * human-like latency instead of a machine's instant reply.
 *
 * An automated supervisor (a Claude Code MCP client, say) decides in
 * milliseconds; a person takes seconds, variably. This paces a supervisor's
 * verdict so the *observed* response time — from a call being held to its verdict
 * being applied — follows a distribution clipped to [min, max]: a floor it never
 * beats, a ceiling on the sampled think-time, and a shape in between.
 *
 * It only ever *adds* latency to a verdict; it cannot change the verdict, and it
 * cannot make a decision arrive sooner than the underlying supervisor produced
 * one. A supervisor that abstains (times out to `pass`) is not "a response", so a
 * non-answer is not paced — it resolves on the seat's own timeout.
 *
 * @module supervisorTiming
 */

export const DISTRIBUTIONS = ["uniform", "exponential", "gamma", "normal", "lognormal", "poisson"];

const rand = () => Math.random();

/** Box–Muller standard normal, then shift/scale. */
function sampleNormal(mean, sd) {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Marsaglia–Tsang gamma (shape k > 0, scale θ), mean = k·θ. */
function sampleGamma(shape, scale) {
  if (shape < 1) return sampleGamma(shape + 1, scale) * Math.pow(rand(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      x = sampleNormal(0, 1);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

/** Knuth Poisson (count with mean λ). */
function samplePoisson(lambda) {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > limit);
  return k - 1;
}

/**
 * Draw one delay in milliseconds from the profile, clipped to [min, max]. The
 * clip is deliberate — "both clipped" — so a heavy-tailed draw cannot stall a
 * turn; it becomes a point mass at the ceiling instead.
 *
 * @param {ReturnType<typeof parseTimingProfile>} profile
 */
export function sampleDelay(profile) {
  const { min, max } = profile;
  const mid = (min + max) / 2 || 1;
  let value;
  switch (profile.dist) {
    case "exponential": {
      const mean = profile.meanMs ?? mid;
      value = -mean * Math.log(1 - rand());
      break;
    }
    case "gamma": {
      const shape = profile.shape ?? 2;
      const scale = profile.scaleMs ?? mid / shape;
      value = sampleGamma(shape, scale);
      break;
    }
    case "normal": {
      value = sampleNormal(profile.meanMs ?? mid, profile.sdMs ?? ((max - min) / 4 || 1));
      break;
    }
    case "lognormal": {
      value = Math.exp(sampleNormal(profile.mu ?? Math.log(mid), profile.sigma ?? 0.5));
      break;
    }
    case "poisson": {
      value = samplePoisson(profile.lambda ?? 3) * (profile.unitMs ?? 1000);
      break;
    }
    case "uniform":
    default:
      value = min + rand() * (max - min);
      break;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Wrap a supervisor decider so its verdict is held until a sampled delay has
 * elapsed since the call arrived. If the underlying supervisor was slower than
 * the sampled target, the verdict is not delayed further — the response is
 * whichever is later, but never sooner than `min`.
 *
 * @param {(call: any) => Promise<string>} supervise
 * @param {ReturnType<typeof parseTimingProfile>} profile
 * @param {{ log?: (m: string) => void, sleep?: (ms: number) => Promise<void> }} [options]
 */
export function withResponseTiming(supervise, profile, { log = () => {}, sleep = defaultSleep } = {}) {
  return async function pacedSupervise(call) {
    const target = sampleDelay(profile);
    const started = Date.now();
    const verdict = await supervise(call);
    const remaining = target - (Date.now() - started);
    if (remaining > 0) await sleep(remaining);
    log(`[supervisor] paced ${call?.tool ?? "decision"} to ~${target}ms`);
    return verdict;
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Validate and normalise a timing profile (from `--supervisor-timing <json>` or
 * an object). Throws on nonsense so an operator sees it, rather than shaping
 * silently wrong.
 *
 * @param {unknown} raw a JSON string or an object
 * @returns {{ min: number, max: number, dist: string, [k: string]: number|string }}
 */
export function parseTimingProfile(raw) {
  const profile = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!profile || typeof profile !== "object") throw new Error("supervisor timing must be an object");
  const min = Number(profile.min ?? 0);
  const max = Number(profile.max ?? min);
  const dist = profile.dist ?? "uniform";
  if (!Number.isFinite(min) || min < 0) throw new Error("supervisor timing: min must be a non-negative number of ms");
  if (!Number.isFinite(max) || max < min) throw new Error("supervisor timing: max must be >= min");
  if (!DISTRIBUTIONS.includes(dist)) throw new Error(`supervisor timing: dist must be one of ${DISTRIBUTIONS.join(", ")}`);
  return { ...profile, min, max, dist };
}
