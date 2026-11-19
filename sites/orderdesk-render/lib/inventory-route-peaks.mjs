/** Inventory after adding one arrival at each possible day. A monotonic window
 * follows the extra unit until unmet demand consumes it. This computes every
 * route's ceiling pressure in linear time instead of replaying the whole future
 * separately for each candidate date. */
export function inventoryRoutePeaks(balance, missed, cap) {
  const n = balance.length, prefix = new Float64Array(n + 1), suffix = new Float64Array(n + 1), values = new Float64Array(n);
  const over = new Float64Array(n), ownOver = new Float64Array(n), queue = new Int32Array(n);
  for (let i = 0; i < n; i++) { prefix[i + 1] = prefix[i] + missed[i]; values[i] = balance[i] - prefix[i + 1]; }
  for (let i = n - 1; i >= 0; i--) suffix[i] = Math.max(suffix[i + 1], balance[i]);
  let head = 0, tail = 0, right = 0;
  for (let start = 0; start < n; start++) {
    while (head < tail && queue[head] < start) head++;
    right = Math.max(right, start);
    const threshold = prefix[start] + 1;
    while (right < n && prefix[right + 1] < threshold - 1e-8) {
      while (head < tail && values[queue[tail - 1]] <= values[right]) tail--;
      queue[tail++] = right++;
    }
    const marginalPeak = head < tail ? values[queue[head]] + threshold : -Infinity;
    ownOver[start] = Math.max(0, marginalPeak - cap);
    over[start] = Math.max(0, suffix[start] - cap, ownOver[start]);
  }
  return { over, ownOver };
}
