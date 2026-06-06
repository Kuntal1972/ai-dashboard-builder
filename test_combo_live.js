// Live integration test — stacked column combo and plain combo charts
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
    label: 'Stacked column combo chart',
    prompt: 'Create a stacked column combo chart showing Annual Salary by Department, stacked by Gender, with a line showing Bonus %',
    expectType: 'combo', expectStackMode: 'stack'
  },
  {
    label: 'Plain combo chart (line + bar)',
    prompt: 'Create a combo chart showing Annual Salary and Bonus % by Department',
    expectType: 'combo', expectStackMode: null
  },
  {
    label: '100% stacked column combo',
    prompt: 'Show a 100% stacked column combo chart of Annual Salary by Department stacked by Gender',
    expectType: 'combo', expectStackMode: 'percent'
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
          if (!j.success) { console.log(`  FAIL [${t.label}] ERROR: ${j.error}`); resolve(); return; }
          const charts = (j.spec && j.spec.charts) || [];
          const c = charts.find(ch => ch.type === t.expectType);
          const typeOk = !!c;
          const stackOk = t.expectStackMode === null
            ? (!c || !c.stack_mode)
            : (c && c.stack_mode === t.expectStackMode);
          const onlyOne = charts.filter(ch => ch.type === 'bar' || ch.type === 'combo').length === 1;
          const status = (typeOk && stackOk && onlyOne) ? 'PASS' : 'FAIL';
          console.log(`${status}: ${t.label}`);
          console.log(`       type=${c ? c.type : 'MISSING'} stack_mode=${c ? c.stack_mode : 'n/a'} color_column=${c ? c.color_column : 'n/a'}`);
          console.log(`       all_chart_types: [${charts.map(ch=>ch.type).join(', ')}]  onlyOneBarOrCombo=${onlyOne}`);
          if (!typeOk)  console.log(`       ✗ expected type=${t.expectType}`);
          if (!stackOk) console.log(`       ✗ expected stack_mode=${t.expectStackMode}`);
          if (!onlyOne) console.log(`       ✗ expected exactly 1 bar/combo chart`);
        } catch(e) { console.log(`  FAIL [${t.label}] Parse error: ${e.message}`); }
        resolve();
      });
    });
    req.on('error', e => { console.log(`  FAIL [${t.label}] Server error: ${e.message}`); resolve(); });
    req.write(body);
    req.end();
  });
}

(async () => {
  for (const t of TESTS) await test(t);
  console.log('\nDone.');
})();
