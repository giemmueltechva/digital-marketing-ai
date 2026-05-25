const http = require('http');

const data = JSON.stringify({
  sessionId: 'dc21a6de-caee-42b0-a64b-312cfc920b40',
  message: 'I want to build a customer persona for my freelance digital marketing business.'
});

const options = {
  hostname: 'localhost',
  port: 5000,
  path: '/api/chat',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

console.log('Sending message to chatbot backend...');

const req = http.request(options, (res) => {
  console.log(`Status Code: ${res.statusCode}`);
  let responseData = '';

  res.on('data', (chunk) => {
    responseData += chunk;
  });

  res.on('end', () => {
    try {
      const parsed = JSON.parse(responseData);
      console.log('\n--- RAW CHATBOT RESPONSE ---');
      console.log(parsed.output);

      console.log('\n--- PARSING QUESTIONNAIRE ---');
      const match = parsed.output.match(/<questionnaire>([\s\S]*?)<\/questionnaire>/);
      if (match) {
        console.log('Success! Found <questionnaire> tags.');
        const jsonStr = match[1].trim();
        const questionnaire = JSON.parse(jsonStr);
        console.log('Successfully parsed questionnaire JSON:\n', JSON.stringify(questionnaire, null, 2));
        
        const cleanText = parsed.output.replace(/<questionnaire>[\s\S]*?<\/questionnaire>/, '').trim();
        console.log('\nClean display text:\n', cleanText);
      } else {
        console.warn('Warning: No <questionnaire> tags found in the response. The LLM might have decided not to ask questions or missed the instruction.');
      }
    } catch (e) {
      console.error('Error handling response:', e);
      console.log('Raw output:', responseData);
    }
  });
});

req.on('error', (error) => {
  console.error('Request Error:', error);
});

req.write(data);
req.end();
