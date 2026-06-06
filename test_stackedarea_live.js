// Live test — stacked area chart column resolution
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
  { label: 'User exact prompt', prompt: 'Stacked Area chart for count of Employee by country' },
  { label: '"by Country" variant', prompt: 'Create a stacked area chart showing count of employees by Country' },
  { label: '"across countries" variant', prompt: 'Show a stacked area chart of employee count across countries' },
  { label: '"Country on X-axis" explicit', prompt: 'Stacked area chart with Country on the x-axis showing count of employees' },
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
          if (!j.success) { console.log(`  FAIL [${t.label}]: ${j.error}`); resolve(); return; }
          const charts = (j.spec && j.spec.charts) || [];
          const area = charts.find(c => c.type === 'area');
          if (!area) {
            console.log(`FAIL: ${t.label} — no area chart. types=[${charts.map(c=>c.type).join(',')}]`);
            resolve(); return;
          }
          const xOk    = area.x_column === 'Country';
          const aggOk  = area.aggregation === 'count';
          const stackOk = area.stack_mode === 'stack';
          const ok = xOk && aggOk && stackOk;
          console.log(`${ok?'PASS':'FAIL'}: ${t.label}`);
          console.log(`       x_column=${area.x_column}   ${xOk?'✓':'✗ expected Country'}`);
          console.log(`       aggregation=${area.aggregation}   ${aggOk?'✓':'✗ expected count'}`);
          console.log(`       stack_mode=${area.stack_mode}   ${stackOk?'✓':'✗ expected stack'}`);
          console.log(`       color_column=${area.color_column||'none'}`);
          console.log(`       all charts: [${charts.map(c=>c.type).join(', ')}]`);
        } catch(e) { console.log(`  FAIL [${t.label}]: parse error ${e.message}`); }
        resolve();
      });
    });
    req.on('error', e => { console.log(`  FAIL [${t.label}]: ${e.message}`); resolve(); });
    req.write(body);
    req.end();
  });
}

(async () => {
  for (const t of TESTS) await test(t);
  console.log('\nDone.');
})();
