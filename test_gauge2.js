// Test updated _parseGaugeRange with LaTeX stripping + "to" separator + parenthetical
const _pN = s => Number(String(s || '').replace(/[$,\\]/g, ''));

const _parseGaugeRange = p => {
  // Strip LaTeX math markers: \(\$50,000\) → 50,000
  const c = p.replace(/\\\(\\?\$?([\d,]+(?:\.\d+)?)\\\)/g, '$1');
  // Flexible separator after keyword: optional parenthetical + optional "to" + optional "=:" + optional "$"
  const minRe    = /\b(?:min(?:imum)?(?:\s+(?:value|of|is|at))?|starts?\s+(?:at|from))(?:\s*\([^)]*\))?\s*(?:to\s+)?[=:]?\s*\$?([\d,]+(?:\.\d+)?)/i;
  const maxRe    = /\b(?:max(?:imum)?(?:\s+(?:value|of|is|at))?|up\s+to|capped?\s+at)(?:\s*\([^)]*\))?\s*(?:to\s+)?[=:]?\s*\$?([\d,]+(?:\.\d+)?)/i;
  const tgtRe    = /\b(?:target(?:\s+(?:value|of|is|at))?|benchmark|goal|threshold)(?:\s*\([^)]*\))?\s*(?:to\s+)?[=:]?\s*\$?([\d,]+(?:\.\d+)?)/i;
  const fromToRe = /\b(?:from|range\s*[=:]?)\s+\$?([\d,]+(?:\.\d+)?)\s+to\s+\$?([\d,]+(?:\.\d+)?)/i;
  const minM = minRe.exec(c), maxM = maxRe.exec(c), tgtM = tgtRe.exec(c), ftM = fromToRe.exec(c);
  return {
    minV: minM ? _pN(minM[1]) : (ftM ? _pN(ftM[1]) : null),
    maxV: maxM ? _pN(maxM[1]) : (ftM ? _pN(ftM[2]) : null),
    tgtV: tgtM ? _pN(tgtM[1]) : null
  };
};

const tests = [
  // THE EXACT FAILING PROMPT — LaTeX math format \(\$50,000\)
  {
    label: 'LaTeX \\(\\$50,000\\) format (exact user prompt)',
    p: 'Create a gauge chart showing the Average Annual Salary. Set the minimum value to \\(\\$50,000\\), the target value (benchmark) to \\(\\$85,000\\), and the maximum value to \\(\\$150,000\\). Use the Annual Salary column to calculate the average and display the callout value',
    e: { minV: 50000, tgtV: 85000, maxV: 150000 }
  },
  // PLAIN DOLLAR + "to" separator (second attempt by user)
  {
    label: 'Plain $50,000 + "to" separator',
    p: 'Create a gauge chart showing the Average Annual Salary. Set the minimum value to $50,000, the target value (benchmark) to $85,000, and the maximum value to $150,000.',
    e: { minV: 50000, tgtV: 85000, maxV: 150000 }
  },
  // Parenthetical qualifier only (no dollar)
  {
    label: 'Parenthetical (benchmark), plain numbers',
    p: 'minimum value to 50000, target value (benchmark) to 85000, maximum value to 150000',
    e: { minV: 50000, tgtV: 85000, maxV: 150000 }
  },
  // Old formats must still work
  {
    label: 'Old format: min=40000 target=80000 max=150000',
    p: 'Gauge for Total Annual Salary, min=40000, target=80000, max=150000',
    e: { minV: 40000, tgtV: 80000, maxV: 150000 }
  },
  {
    label: 'Natural value: minimum value 30000 maximum value 130000 target value 75000',
    p: 'minimum value 30000, maximum value 130000, target value 75000',
    e: { minV: 30000, tgtV: 75000, maxV: 130000 }
  },
  {
    label: "Colon: Min: 40000, Max: 150000, Target: 85000",
    p: 'Min: 40000, Max: 150000, Target: 85000',
    e: { minV: 40000, tgtV: 85000, maxV: 150000 }
  },
  {
    label: 'from...to range: from 30000 to 130000, target 75000',
    p: 'gauge chart from 30000 to 130000, with target 75000',
    e: { minV: 30000, tgtV: 75000, maxV: 130000 }
  },
  {
    label: 'Currency dollar: from $30,000 to $150,000 target $80,000',
    p: 'KPI visual showing total salary from $30,000 to $150,000, target $80,000',
    e: { minV: 30000, tgtV: 80000, maxV: 150000 }
  },
];

let pass = 0, fail = 0;
for (const t of tests) {
  const r = _parseGaugeRange(t.p);
  const ok = r.minV === t.e.minV && r.maxV === t.e.maxV && r.tgtV === t.e.tgtV;
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`${status}: ${t.label}`);
  if (!ok) console.log(`       got: min=${r.minV} tgt=${r.tgtV} max=${r.maxV}  expected: min=${t.e.minV} tgt=${t.e.tgtV} max=${t.e.maxV}`);
  ok ? pass++ : fail++;
}
console.log(`\nResult: ${pass} passed, ${fail} failed`);
