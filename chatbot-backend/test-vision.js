const http = require('http');
const fs = require('fs');
const path = require('path');

// Read the hero.png image from the frontend assets as a real test image
const imagePath = path.join(__dirname, '..', 'chatbot-frontend', 'src', 'assets', 'hero.png');
const imageBuffer = fs.readFileSync(imagePath);
const base64Data = `data:image/png;base64,${imageBuffer.toString('base64')}`;

const payload = JSON.stringify({
  sessionId: 'dc21a6de-caee-42b0-a64b-312cfc920b40',
  message: 'What do you see in this image?',
  userName: 'Test User',
  attachments: [
    {
      name: 'hero-screenshot.png',
      type: 'image/png',
      size: imageBuffer.length,
      data: base64Data
    }
  ]
});

const options = {
  hostname: 'localhost',
  port: 5000,
  path: '/api/chat',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

console.log('Sending chat request with real image to vision-enabled backend...');
console.log(`Image size: ${imageBuffer.length} bytes`);

const req = http.request(options, (res) => {
  console.log(`Response Status Code: ${res.statusCode}`);
  let responseData = '';

  res.on('data', (chunk) => {
    responseData += chunk;
  });

  res.on('end', () => {
    try {
      const parsed = JSON.parse(responseData);
      console.log('\n--- AI RESPONSE ---');
      console.log(parsed.output || parsed.error);
      console.log('-------------------');
      if (res.statusCode === 200) {
        console.log('\nSUCCESS! The vision model analyzed the image.');
      } else {
        console.log('\nFAILED with status:', res.statusCode);
      }
    } catch (e) {
      console.error('Error parsing response:', e);
      console.log('Raw:', responseData);
    }
  });
});

req.on('error', (error) => {
  console.error('Request Error:', error);
});

req.write(payload);
req.end();
