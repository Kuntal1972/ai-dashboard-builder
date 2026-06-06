// Live integration test for filled map / choropleth
const http = require('http');

const PROMPTS = [
  'Create a filled map showing employee count by country',
  'Show a filled map of total annual salary by country',
  'Filled map visual showing number of employees per country',
];

const columns = ['Sr. no','Employee ID','Full Name','Job Title','Department','Business Unit','Gender','Ethnicity','Age','Hire Date','Annual Salary','Bonus %','Country','City','Exit Date'];
const colTypes = {};
columns.forEach(c => { colTypes[c] = ['Annual Salary','Bonus %','Age','Sr. no'].includes(c) ? 'number' : 'string'; });

const csvData = [
  columns.join(','),
  '1,E001,John Smith,Manager,IT,Tech,Male,White,35,2020-01-01,75000,10,USA,NYC,',
  '2,E002,Jane Doe,Analyst,HR,Corp,Female,Asian,28,2021-06-01,60000,8,UK,London,',
  '3,E003,Bob Lee,Engineer,IT,Tech,Male,Black,40,2019-03-15,90000,12,Canada,Toronto,',
].join('\n');

function testPrompt(prompt) {
  return new Promise(resolve => {
    const body = JSON.stringify({ csvData, columns, colTypes, prompt, fileName: 'test.csv' });
    console.log('\nPrompt: "' + prompt + '"');
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
          if (!j.success) { console.log('  ERROR: ' + j.error); resolve(); return; }
          const charts = (j.spec && j.spec.charts) || [];
          charts.forEach(c => {
            const isMap = c.type === 'choropleth' || c.type === 'scattergeo';
            console.log(`  Chart: type=${c.type} x=${c.x_column} y=${c.y_column} agg=${c.aggregation} ${isMap ? '✓ MAP' : '✗ NOT MAP'}`);
          });
          if (!charts.length) console.log('  No charts returned');
          const hasMap = charts.some(c => c.type === 'choropleth' || c.type === 'scattergeo');
          console.log('  Result: ' + (hasMap ? 'PASS - map found' : 'FAIL - no map chart'));
        } catch(e) { console.log('  Parse error: ' + e.message); }
        resolve();
      });
    });
    req.on('error', e => { console.log('  Server error: ' + e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

(async () => {
  for (const p of PROMPTS) await testPrompt(p);
  console.log('\nDone.');
})();
