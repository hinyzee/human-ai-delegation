/* =========================================================
   Utility functions
   ========================================================= */

export function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function generateBarcode(prefix, numDigits) {
  const digits = String(Math.floor(Math.random() * (10 ** numDigits))).padStart(numDigits, '0');
  return `${prefix}-${digits}`;
}

export function latinSquare(n) {
  const base = Array.from({ length: n }, (_, i) => i);
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(base.map((_, j) => (i + j) % n));
  }
  return rows;
}

export function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function uid() {
  return (performance.now().toString(36) + Math.random().toString(36)).replace(/\./g, '');
}

export function timestamp() {
  return Date.now();
}

export function formatTime(ms) {
  return (ms / 1000).toFixed(2) + 's';
}

export function generateBlockOrder(blockKeys, randomize) {
  if (!randomize) return [...blockKeys];

  const n = blockKeys.length;
  const squares = latinSquare(n);
  const row = squares[Math.floor(Math.random() * n)];
  return row.map(i => blockKeys[i]);
}

export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Compute the correct conveyor for a P-barcode.
 * Rule: sum of last 2 digits < threshold → 'conveyor1', else → 'conveyor2'
 * Example: P-48271 → 7+1=8 < 10 → conveyor1
 *          P-51684 → 8+4=12 >= 10 → conveyor2
 */
export function getCorrectConveyor(barcode, threshold) {
  const digits = barcode.replace(/[^0-9]/g, '');
  if (digits.length < 2) return 'conveyor1';
  const d1 = parseInt(digits[digits.length - 2], 10);
  const d2 = parseInt(digits[digits.length - 1], 10);
  const sum = d1 + d2;
  return sum < threshold ? 'conveyor1' : 'conveyor2';
}

/**
 * Get the digit sum used for routing (last 2 digits of barcode).
 */
export function getRoutingDigitSum(barcode) {
  const digits = barcode.replace(/[^0-9]/g, '');
  if (digits.length < 2) return 0;
  return parseInt(digits[digits.length - 2], 10) + parseInt(digits[digits.length - 1], 10);
}
