/** Money helpers. Money = integer paise, rates = basis points (LLD 1.1). */

/** Half-up rounded `bps` share of `amountPaise`, in pure integer arithmetic. */
export function bpsOf(amountPaise: number, bps: number): number {
  return Math.floor((amountPaise * bps + 5000) / 10000);
}

/** `123450` -> `₹1,234.50` (en-IN grouping: 12,34,567.00). Negative -> `-₹500.00`. */
export function formatINR(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new RangeError(`formatINR expects integer paise, got ${paise}`);
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toString();
  const frac = (abs % 100).toString().padStart(2, '0');
  let grouped: string;
  if (rupees.length <= 3) grouped = rupees;
  else {
    const head = rupees.slice(0, -3);
    const tail = rupees.slice(-3);
    grouped = `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
  }
  return `${paise < 0 ? '-' : ''}₹${grouped}.${frac}`;
}
