require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function testConnection() {
  console.log('Connecting to Supabase...');
  console.log('URL:', process.env.SUPABASE_URL);
  
  // Try querying chat_sessions
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('id, title')
    .limit(1);

  if (error) {
    console.error('Error querying chat_sessions:', error.message);
    if (error.message.includes('relation "public.chat_sessions" does not exist')) {
      console.log('\n>>> ACTION REQUIRED: You must run the SQL schema in Supabase SQL editor! <<<');
    }
  } else {
    console.log('Successfully connected! chat_sessions table exists.');
    console.log('Current rows:', data);
  }
}

testConnection();
