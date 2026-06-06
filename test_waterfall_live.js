// Live integration test — waterfall chart category column
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
  {
    label: 'Exact user prompt — ethnicities waterfall',
    prompt: 'Create a waterfall chart showing the change in Annual Salary across different ethnicities. Use the first bar as the starting overall average salary, the middle bars as the positive and negative variances from each ethnicity relative to the baseline, and the final bar as the overall average, color-coding increases in green and decreases in red',
    expectX: 'Ethnicity', expectY: 'Annual Salary'
  },
  {
    label: 'Simple: waterfall by Department',
    prompt: 'Waterfall chart showing Annual Salary by Department',
    expectX: 'Department', expectY: 'Annual Salary'
  },
  {
    label: 'Waterfall across genders',
    prompt: 'Show a waterfall chart of salary changes across Gender',
    expectX: 'Gender', expectY: 'Annual Salary'
  },
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
          if (!j.success) { console.log(`  [${t.label}] ERROR: ${j.error}`); resolve(); return; }
          const charts = (j.spec && j.spec.charts) || [];
          const wf = charts.find(c => c.type === 'waterfall');
          if (!wf) { console.log(`  [${t.label}] FAIL: no waterfall chart returned (types: ${charts.map(c=>c.type).join(',')})`); resolve(); return; }
          const xOk = wf.x_column === t.expectX;
          const yOk = !t.expectY || wf.y_column === t.expectY;
          const status = (xOk && yOk) ? 'PASS' : 'FAIL';
          console.log(`${status}: ${t.label}`);
          console.log(`       x=${wf.x_column} (expected ${t.expectX}) ${xOk?'✓':'✗'}`);
          console.log(`       y=${wf.y_column} (expected ${t.expectY||'any'}) ${yOk?'✓':'✗'}`);
          console.log(`       agg=${wf.aggregation}`);
        } catch(e) { console.log(`  [${t.label}] Parse error: ${e.message}`); }
        resolve();
      });
    });
    req.on('error', e => { console.log(`  [${t.label}] Server error: ${e.message}`); resolve(); });
    req.write(body);
    req.end();
  });
}

(async () => {
  for (const t of TESTS) await test(t);
  console.log('\nDone.');
})();
