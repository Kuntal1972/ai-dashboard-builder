// Live test — pie, filled map, and other chart types
const http = require('http');

const columns = ['Sr. no','Employee ID','Full Name','Job Title','Department','Business Unit','Gender','Ethnicity','Age','Hire Date','Annual Salary','Bonus %','Country','City','Exit Date'];
const colTypes = {};
columns.forEach(c => { colTypes[c] = ['Annual Salary','Bonus %','Age','Sr. no'].includes(c) ? 'number' : 'string'; });
const csvData = [
  columns.join(','),
  '1,E001,John Smith,Manager,IT,Tech,Male,White,35,2020-01-01,75000,10,USA,NYC,',
  '2,E002,Jane Doe,Analyst,HR,Corp,Female,Asian,28,2021-06-01,60000,8,UK,London,',
  '3,E003,Bob Lee,Engineer,IT,Tech,Male,Black,40,2019-03-15,90000,12,Canada,Toronto,',
  '4,E004,Sara Kim,Director,Finance,Corp,Female,Asian,45,2018-01-01,120000,15,USA,LA,',
].join('\n');

const TESTS = [
  { label: 'Pie chart by Department',         prompt: 'Create a pie chart showing employee distribution by Department' },
  { label: 'Pie chart by Gender',             prompt: 'Pie chart of headcount by Gender' },
  { label: 'Donut chart by Country',          prompt: 'Donut chart showing count of employees by Country' },
  { label: 'Filled map by Country',           prompt: 'Create a filled map showing employee count by country' },
  { label: 'Filled map salary by Country',    prompt: 'Filled map of total annual salary by country' },
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
          const types = charts.map(c => `${c.type}(x=${c.x_column},y=${c.y_column},agg=${c.aggregation})`).join(', ');
          console.log(`[${t.label}]\n  Charts: ${types || 'NONE'}`);
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
