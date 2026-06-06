// Full combo chart test suite — all variants
const http = require('http');

const columns = ['Sr. no','Employee ID','Full Name','Job Title','Department','Business Unit','Gender','Ethnicity','Age','Hire Date','Annual Salary','Bonus %','Country','City','Exit Date'];
const colTypes = {};
columns.forEach(c => { colTypes[c] = ['Annual Salary','Bonus %','Age','Sr. no'].includes(c) ? 'number' : 'string'; });
const csvData = [
  columns.join(','),
  '1,E001,John Smith,Manager,IT,Tech,Male,White,35,2020-01-01,75000,10,USA,NYC,',
  '2,E002,Jane Doe,Analyst,HR,Corp,Female,Asian,28,2021-06-01,60000,8,UK,London,',
  '3,E003,Bob Lee,Engineer,IT,Tech,Male,Black,40,2019-03-15,90000,12,Canada,Toronto,',
  '4,E004,Sara Kim,Director,Finance,Corp,Female,Hispanic,45,2018-01-01,120000,15,USA,LA,',
].join('\n');

const TESTS = [
  // Plain combo
  { label: 'Plain combo chart',
    prompt: 'Create a combo chart showing Annual Salary and Bonus % by Department',
    expectType: 'combo', expectStackMode: null },
  // Stacked column combo (explicit "combo")
  { label: 'Stacked column combo (explicit combo)',
    prompt: 'Create a stacked column combo chart showing Annual Salary by Department stacked by Gender with a line for Bonus %',
    expectType: 'combo', expectStackMode: 'stack' },
  // 100% stacked column combo
  { label: '100% stacked column combo',
    prompt: 'Show a 100% stacked column combo chart of Annual Salary by Department stacked by Gender',
    expectType: 'combo', expectStackMode: 'percent' },
  // ── THE FAILING CASE: "line and stacked column" (no "combo" keyword) ──
  { label: 'Line and stacked column chart (no "combo" keyword)',
    prompt: 'Create a line and stacked column chart showing Annual Salary and Bonus % by Department',
    expectType: 'combo', expectStackMode: 'stack' },
  // Reverse wording
  { label: 'Stacked column and line chart',
    prompt: 'Show a stacked column and line chart of Annual Salary by Department',
    expectType: 'combo', expectStackMode: 'stack' },
  // "stacked column with line overlay"
  { label: 'Stacked column with line overlay',
    prompt: 'Stacked column with line overlay showing Annual Salary by Department',
    expectType: 'combo', expectStackMode: 'stack' },
];

function test(t) {
  return new Promise(resolve => {
    const body = JSON.stringify({ csvData, columns, colTypes, prompt: t.prompt, fileName: 'test.csv' });
    const req = http.request({
      hostname: 'localhost', port: 3001,
      path: '/api/build-powerbi', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (!j.success) { console.log(`  FAIL [${t.label}]: ERROR ${j.error}`); resolve(); return; }
          const charts = (j.spec && j.spec.charts) || [];
          const c = charts.find(ch => ch.type === t.expectType);
          const typeOk  = !!c;
          const stackOk = t.expectStackMode === null
            ? (!c || !c.stack_mode)
            : (c && c.stack_mode === t.expectStackMode);
          const noStrayLine = !charts.some(ch => ch.type === 'line');
          const noStrayBar  = !charts.some(ch => ch.type === 'bar');
          const ok = typeOk && stackOk && noStrayLine && noStrayBar;
          console.log(`${ok ? 'PASS' : 'FAIL'}: ${t.label}`);
          if (!typeOk)      console.log(`       ✗ no ${t.expectType} chart found — types: [${charts.map(c=>c.type).join(', ')}]`);
          if (!stackOk)     console.log(`       ✗ stack_mode=${c?c.stack_mode:'n/a'} expected ${t.expectStackMode}`);
          if (!noStrayLine) console.log(`       ✗ stray standalone line chart remains`);
          if (!noStrayBar)  console.log(`       ✗ stray standalone bar chart remains`);
          if (ok) console.log(`       type=combo stack_mode=${c.stack_mode||'none'} color_column=${c.color_column||'none'}`);
        } catch(e) { console.log(`  FAIL [${t.label}]: parse error ${e.message}`); }
        resolve();
      });
    });
    req.on('error', e => { console.log(`  FAIL [${t.label}]: server error ${e.message}`); resolve(); });
    req.write(body);
    req.end();
  });
}

(async () => {
  for (const t of TESTS) await test(t);
  console.log('\nDone.');
})();
