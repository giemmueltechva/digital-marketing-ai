const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
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
      console.log('\n>>> ACTION REQUIRED: The table public.chat_sessions does not exist. Please create it in your Supabase SQL editor! <<<');
    } else if (error.message.includes('permission denied')) {
      console.log('\n>>> ACTION REQUIRED: Permission Denied. You must grant privileges in Supabase SQL editor:');
      console.log('GRANT ALL PRIVILEGES ON TABLE public.chat_sessions TO service_role, authenticated, anon;');
      console.log('GRANT ALL PRIVILEGES ON TABLE public.chat_messages TO service_role, authenticated, anon;\n');
    }
  } else {
    console.log('Successfully connected! chat_sessions table exists and is accessible.');
    console.log('Current rows:', data);
  }
}

testConnection();
