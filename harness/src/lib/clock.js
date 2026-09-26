// Injectable clock. Real time by default; tests use a fixed/stepping clock.
export function realClock() {
  return { now: () => Date.now(), iso: () => new Date().toISOString() };
}

export function fixedClock(startMs = Date.UTC(2000, 0, 1), stepMs = 1000) {
  let t = startMs;
  return {
    now: () => t,
    iso: () => new Date(t).toISOString(),
    tick: (ms = stepMs) => { t += ms; return t; },
  };
}
