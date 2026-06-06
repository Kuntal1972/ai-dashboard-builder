// Live integration test — exact prompt the user is typing (LaTeX format)
const http = require('http');

// Exact string as sent by the browser (LaTeX math markers)
const PROMPT = 'Create a gauge chart showing the Average Annual Salary. Set the minimum value to \\(\\$50,000\\), the target value (benchmark) to \\(\\$85,000\\), and the maximum value to \\(\\$150,000\\). Use the Annual Salary column to calculate the average and display the callout value';

const columns = ['Sr. no','Employee ID','Full Name','Job Title','Department','Business Unit','Gender','Ethnicity','Age','Hire Date','Annual Salary','Bonus %','Country','City','Exit Date'];
const colTypes = {};
columns.forEach(c => { colTypes[c] = ['Annual Salary','Bonus %','Age','Sr. no'].includes(c) ? 'number' : 'string'; });

// Minimal CSV — just enough for the server to process
const csvData = [
  columns.join(','),
  '1,E001,John Smith,Manager,IT,Tech,Male,White,35,2020-01-01,75000,10,USA,NYC,',
  '2,E002,Jane Doe,Analyst,HR,Corp,Female,Asian,28,2021-06-01,60000,8,UK,London,',
].join('\n');

const body = JSON.stringify({ csvData, columns, colTypes, prompt: PROMPT, fileName: 'test.csv' });

console.log('Sending prompt:');
console.log('  ' + PROMPT.slice(0, 120) + '...');
console.log('Waiting for Ollama response...\n');

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
      if (!j.success) { console.log('Server error: ' + j.error); return; }
      const gauge = j.spec && j.spec.charts && j.spec.charts.find(c => c.type === 'gauge');
      if (!gauge) {
        console.log('NO GAUGE found! Charts returned: ' + JSON.stringify((j.spec && j.spec.charts || []).map(c => c.type)));
        return;
      }
      console.log('GAUGE FOUND:');
      console.log('  y_column:     ' + gauge.y_column);
      console.log('  aggregation:  ' + gauge.aggregation);
      console.log('  min_value:    ' + gauge.min_value);
      console.log('  max_value:    ' + gauge.max_value);
      console.log('  target_value: ' + gauge.target_value);
      console.log('  format:       ' + gauge.format);
      console.log('');
      const minOK = gauge.min_value === 50000;
      const maxOK = gauge.max_value === 150000;
      const tgtOK = gauge.target_value === 85000;
      console.log('  min=50000:   ' + (minOK ? 'OK' : 'FAIL (got ' + gauge.min_value + ')'));
      console.log('  max=150000:  ' + (maxOK ? 'OK' : 'FAIL (got ' + gauge.max_value + ')'));
      console.log('  tgt=85000:   ' + (tgtOK ? 'OK' : 'FAIL (got ' + gauge.target_value + ')'));
      console.log('');
      if (minOK && maxOK && tgtOK) console.log('ALL PASS - gauge range values correctly parsed and applied!');
      else console.log('SOME FAILURES - check values above');
    } catch(e) { console.log('Response parse error: ' + e.message); console.log(d.slice(0,300)); }
  });
});
req.on('error', e => console.log('Cannot reach server: ' + e.message));
req.write(body);
req.end();
