// Unit test: waterfall category-column extraction
// Verifies that "across different ethnicities." maps to the Ethnicity column

const columns = ['Sr. no','Employee ID','Full Name','Job Title','Department','Business Unit','Gender','Ethnicity','Age','Hire Date','Annual Salary','Bonus %','Country','City','Exit Date'];
const colTypes = {};
columns.forEach(c => { colTypes[c] = ['Annual Salary','Bonus %','Age','Sr. no'].includes(c) ? 'number' : 'string'; });

// ── Inline the relevant logic from _injectWaterfallIfRequested ──

const _isIdLikeCol = c => /\b(id|no|num|number|serial|rank|index|row|sr)\b/i.test(
  c.toLowerCase().replace(/[\s_\-]+/g, ' ')
);

const findCol = raw => {
  if (!raw) return null;
  const t = raw.trim()
    .replace(/[.,;!?]+$/, '')
    .toLowerCase()
    .replace(/^(?:employee\s+count|headcount|total|sum\s+of|average|count\s+of|number\s+of)\s*/i, '')
    .trim();
  if (!t) return null;
  const deplural = s => s.replace(/ies$/, 'y').replace(/ches$|shes$|xes$|zes$/, c => c.slice(0,-2))
                         .replace(/ves$/, 'f').replace(/s$/, '');
  const variants = [...new Set([t, deplural(t)])];
  for (const v of variants) {
    const hit = columns.find(c => c.toLowerCase() === v)
             || columns.find(c => c.toLowerCase().includes(v) || v.includes(c.toLowerCase()))
             || (() => { const tw = v.split(/\s+/).filter(w => w.length > 2);
                  return columns.find(c => tw.some(w => c.toLowerCase().includes(w))) || null; })();
    if (hit) return hit;
  }
  return null;
};

const _extractCatFromPrompt = prompt => {
  const patterns = [
    /\bshowing\s+[\w][\w\s]{1,30}?\s+by\s+([\w][\w\s]{1,30}?)(?=\s|[,;.]|$)/i,
    /\bby\s+([\w][\w\s]{1,30}?)(?=\s|[,;.]|$)/i,
    /\bacross\s+(?:different\s+)?([\w][\w\s]{1,30}?)(?=\s|[,;.]|$)/i,
    /\bper\s+([\w][\w\s]{1,25}?)(?=\s|[,;.]|$)/i,
    /\bfor\s+each\s+([\w][\w\s]{1,25}?)(?=\s|[,;.]|$)/i,
    /\bfrom\s+each\s+([\w][\w\s]{1,25}?)(?=\s|[,;.]|$)/i,
    /\beach\s+([\w][\w\s]{1,25}?)(?=\s|[,;.]|$)/i,
    /\bgroup(?:ed)?\s+by\s+([\w][\w\s]{1,30}?)(?=\s|[,;.]|$)/i,
    /\busing\s+([\w][\w\s]{1,25}?)\s+as\s+(?:the\s+)?(?:group|category|dimension|x)/i,
    /\b([\w][\w\s]{1,25}?)\s+as\s+the\s+(?:group|category|dimension|x[- ]axis)/i,
    /\bbreakdown\s+(?:of\s+[\w\s]{1,25}?\s+)?by\s+([\w][\w\s]{1,30}?)(?=\s|[,;.]|$)/i,
  ];
  for (const pat of patterns) {
    const m = pat.exec(prompt);
    if (m) {
      const c = findCol(m[1].trim());
      if (c && colTypes[c] !== 'number') return c;
    }
  }
  return null;
};

const resolve = prompt => {
  const showByM = /\bshowing\s+([\w][\w\s]{1,30}?)\s+(?:by|across\s+(?:different\s+)?)\s*([\w][\w\s]{1,30}?)(?:\s*[,;.]|\s*$)/i.exec(prompt);
  let catCol = null;
  if (showByM) {
    const col1 = findCol(showByM[1].trim());
    if (!col1 || colTypes[col1] === 'number') { catCol = findCol(showByM[2].trim()); }
    else { catCol = col1; }
  }
  if (!catCol) catCol = _extractCatFromPrompt(prompt);
  return catCol || '(fallback)';
};

const tests = [
  {
    label: 'User exact prompt — "across different ethnicities."',
    p: 'Create a waterfall chart showing the change in Annual Salary across different ethnicities. Use the first bar as the starting overall average salary, the middle bars as the positive and negative variances from each ethnicity relative to the baseline, and the final bar as the overall average, color-coding increases in green and decreases in red',
    expected: 'Ethnicity'
  },
  { label: '"by Ethnicity"',         p: 'Waterfall chart by Ethnicity', expected: 'Ethnicity' },
  { label: '"from each ethnicity"',  p: 'variance from each ethnicity', expected: 'Ethnicity' },
  { label: '"per Department"',       p: 'waterfall per Department',     expected: 'Department' },
  { label: '"across departments"',   p: 'change across departments',    expected: 'Department' },
  { label: '"by Gender"',            p: 'waterfall chart by Gender',    expected: 'Gender' },
  { label: '"for each Country"',     p: 'for each Country show salary waterfall', expected: 'Country' },
];

let pass = 0, fail = 0;
for (const t of tests) {
  const got = resolve(t.p);
  const ok = got === t.expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${t.label} → got="${got}" expected="${t.expected}"`);
  ok ? pass++ : fail++;
}
console.log(`\nResult: ${pass} passed, ${fail} failed`);
