require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize Groq client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Local JSON Database Fallback Config
const LOCAL_DB_PATH = path.join(__dirname, 'conversations.json');
let useLocalFallback = false;

// Helper to read local JSON data
function readLocalData() {
  if (!fs.existsSync(LOCAL_DB_PATH)) {
    return { sessions: [], messages: [] };
  }
  try {
    const raw = fs.readFileSync(LOCAL_DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading local JSON database, resetting:', err);
    return { sessions: [], messages: [] };
  }
}

// Helper to write local JSON data
function writeLocalData(data) {
  try {
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing to local JSON database:', err);
  }
}

// System prompt for Libre AI
const SYSTEM_PROMPT = `You are Libre Academy's expert Digital Marketer AI assistant. 
You help students understand digital marketing concepts, conduct client discovery calls, execute campaigns, and analyze results.
Be professional, structured, encouraging, and clear.

When you need to gather information from the student to guide them (e.g., when they want to build a customer persona, start a client discovery call, execute a campaign, or brainstorm ideas), DO NOT ask multiple questions in a single text paragraph or a list. Instead, present a friendly, brief introduction in text, followed by an interactive multi-step questionnaire using the following XML-like tag format:

<questionnaire>
{
  "title": "Short Title of the Questionnaire",
  "questions": [
    {
      "question": "The question to ask?",
      "options": [
        "Option 1",
        "Option 2",
        "Option 3"
      ],
      "allow_custom": true
    }
  ]
}
</questionnaire>

Guidelines for questionnaires:
1. Always output valid JSON inside the <questionnaire> and </questionnaire> tags. Never put markdown backticks, code blocks, or extra text inside the tags.
2. Keep the number of questions in a single questionnaire to between 1 and 4.
3. Use "allow_custom": true if the student should be allowed to enter a custom response (a "Something else" input).
4. If the student answers the questions or replies directly, acknowledge their answers in text and ask any follow-up questions, using a new questionnaire block if needed.
`;

/**
 * GET /api/sessions
 * Returns all chat sessions sorted by last updated
 */
app.get('/api/sessions', async (req, res) => {
  if (useLocalFallback) {
    const data = readLocalData();
    const sorted = [...data.sessions].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    return res.json(sorted);
  }

  try {
    const { data, error } = await supabase
      .from('chat_sessions')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.warn('Supabase query failed, falling back to local JSON database:', error.message);
    useLocalFallback = true;
    
    // Serve from local fallback
    const data = readLocalData();
    const sorted = [...data.sessions].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    res.json(sorted);
  }
});

/**
 * POST /api/sessions
 * Creates a new chat session
 */
app.post('/api/sessions', async (req, res) => {
  const { title } = req.body;

  if (useLocalFallback) {
    const data = readLocalData();
    const newSession = {
      id: crypto.randomUUID(),
      title: title || 'New Conversation',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    data.sessions.push(newSession);
    writeLocalData(data);
    return res.status(201).json(newSession);
  }

  try {
    const { data, error } = await supabase
      .from('chat_sessions')
      .insert([{ title: title || 'New Conversation' }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    console.warn('Supabase insert failed, falling back to local JSON database:', error.message);
    useLocalFallback = true;

    // Use local fallback
    const data = readLocalData();
    const newSession = {
      id: crypto.randomUUID(),
      title: title || 'New Conversation',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    data.sessions.push(newSession);
    writeLocalData(data);
    res.status(201).json(newSession);
  }
});

/**
 * GET /api/sessions/:sessionId/messages
 * Returns all messages in a specific session
 */
app.get('/api/sessions/:sessionId/messages', async (req, res) => {
  const { sessionId } = req.params;

  if (useLocalFallback) {
    const data = readLocalData();
    const messages = data.messages
      .filter(msg => msg.session_id === sessionId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return res.json(messages);
  }

  try {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.warn('Supabase fetch messages failed, falling back to local JSON database:', error.message);
    useLocalFallback = true;

    const data = readLocalData();
    const messages = data.messages
      .filter(msg => msg.session_id === sessionId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    res.json(messages);
  }
});

/**
 * DELETE /api/sessions/:sessionId
 * Deletes a session and its associated messages
 */
app.delete('/api/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  if (useLocalFallback) {
    try {
      const data = readLocalData();
      
      data.sessions = data.sessions.filter(s => s.id !== sessionId);
      data.messages = data.messages.filter(m => m.session_id !== sessionId);
      
      writeLocalData(data);
      return res.json({ success: true, message: 'Session deleted locally.' });
    } catch (err) {
      console.error('Error deleting local session:', err);
      return res.status(500).json({ error: 'Failed to delete session locally.' });
    }
  }

  try {
    // Delete messages first to satisfy foreign key constraints if CASCADE is not set
    await supabase
      .from('chat_messages')
      .delete()
      .eq('session_id', sessionId);

    const { error } = await supabase
      .from('chat_sessions')
      .delete()
      .eq('id', sessionId);

    if (error) throw error;
    res.json({ success: true, message: 'Session deleted from Supabase.' });
  } catch (error) {
    console.warn('Supabase delete failed, falling back to local JSON database:', error.message);
    useLocalFallback = true;

    // Delete locally
    const data = readLocalData();
    data.sessions = data.sessions.filter(s => s.id !== sessionId);
    data.messages = data.messages.filter(m => m.session_id !== sessionId);
    writeLocalData(data);

    res.json({ success: true, message: 'Session deleted locally after Supabase failure.' });
  }
});

/**
 * POST /api/chat
 * Main chat route. Receives a user message, stores it, pulls history, gets response from Groq, stores response, and returns it.
 */
app.post('/api/chat', async (req, res) => {
  const { sessionId, message, userName } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId and message are required.' });
  }

  if (useLocalFallback) {
    try {
      const data = readLocalData();

      // Save user message
      const userMsg = {
        id: crypto.randomUUID(),
        session_id: sessionId,
        role: 'user',
        content: message,
        created_at: new Date().toISOString()
      };
      data.messages.push(userMsg);

      // Get last 20 messages for context
      const history = data.messages
        .filter(msg => msg.session_id === sessionId)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .slice(-20);

      // Format for Groq
      const dynamicPrompt = `${SYSTEM_PROMPT}${userName ? `\nThe student's name is ${userName}. Address them by name and personalize your responses.` : ''}`;
      const apiMessages = [
        { role: 'system', content: dynamicPrompt },
        ...history.map(msg => ({
          role: msg.role === 'assistant' || msg.role === 'ai' ? 'assistant' : 'user',
          content: msg.content
        }))
      ];

      // Request Completion from Groq LLM
      const completion = await groq.chat.completions.create({
        messages: apiMessages,
        model: 'llama-3.3-70b-versatile',
        temperature: 0.7,
        max_tokens: 2048,
      });

      const aiText = completion.choices[0]?.message?.content || "I'm sorry, I couldn't formulate a response.";

      // Save AI message
      const aiMsg = {
        id: crypto.randomUUID(),
        session_id: sessionId,
        role: 'assistant',
        content: aiText,
        created_at: new Date().toISOString()
      };
      data.messages.push(aiMsg);

      // Update session timestamp
      const sessionIndex = data.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        data.sessions[sessionIndex].updated_at = new Date().toISOString();

        // Auto-rename if still 'New Conversation'
        if (data.sessions[sessionIndex].title === 'New Conversation') {
          try {
            const summaryCompletion = await groq.chat.completions.create({
              messages: [
                { role: 'system', content: 'Generate a short, concise 3-to-5 word title for a conversation starting with this user message. Return ONLY the title, no quotes, no extra text.' },
                { role: 'user', content: message }
              ],
              model: 'llama-3.3-70b-versatile',
              temperature: 0.3,
              max_tokens: 15
            });

            let newTitle = summaryCompletion.choices[0]?.message?.content?.trim();
            if (newTitle) {
              newTitle = newTitle.replace(/^["']|["']$/g, '');
              data.sessions[sessionIndex].title = newTitle;
            }
          } catch (err) {
            console.error('Failed to auto-rename session:', err);
          }
        }
      }

      writeLocalData(data);
      return res.json({ output: aiText });
    } catch (error) {
      console.error('Error in local /api/chat execution:', error);
      return res.status(500).json({ error: 'Failed to process chat locally.' });
    }
  }

  try {
    // 1. Insert User Message
    const { error: insertUserError } = await supabase
      .from('chat_messages')
      .insert({
        session_id: sessionId,
        role: 'user',
        content: message
      });

    if (insertUserError) throw insertUserError;

    // 2. Fetch past conversation messages (limit to last 20 messages for context)
    const { data: history, error: historyError } = await supabase
      .from('chat_messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (historyError) throw historyError;

    // Format context for Groq
    const dynamicPrompt = `${SYSTEM_PROMPT}${userName ? `\nThe student's name is ${userName}. Address them by name and personalize your responses.` : ''}`;
    const apiMessages = [
      { role: 'system', content: dynamicPrompt },
      ...history.map(msg => ({
        role: msg.role === 'assistant' || msg.role === 'ai' ? 'assistant' : 'user',
        content: msg.content
      }))
    ];

    // 3. Request Completion from Groq LLM
    const completion = await groq.chat.completions.create({
      messages: apiMessages,
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      max_tokens: 2048,
    });

    const aiText = completion.choices[0]?.message?.content || "I'm sorry, I couldn't formulate a response.";

    // 4. Insert Assistant Message
    const { error: insertAiError } = await supabase
      .from('chat_messages')
      .insert({
        session_id: sessionId,
        role: 'assistant',
        content: aiText
      });

    if (insertAiError) throw insertAiError;

    // 5. Update session's updated_at timestamp
    await supabase
      .from('chat_sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', sessionId);

    // 6. Auto-rename session if it's still named 'New Conversation'
    const { data: session } = await supabase
      .from('chat_sessions')
      .select('title')
      .eq('id', sessionId)
      .single();

    if (session && session.title === 'New Conversation') {
      try {
        const summaryCompletion = await groq.chat.completions.create({
          messages: [
            { role: 'system', content: 'Generate a short, concise 3-to-5 word title for a conversation starting with this user message. Return ONLY the title, no quotes, no extra text.' },
            { role: 'user', content: message }
          ],
          model: 'llama-3.3-70b-versatile',
          temperature: 0.3,
          max_tokens: 15
        });
        
        let newTitle = summaryCompletion.choices[0]?.message?.content?.trim();
        if (newTitle) {
          newTitle = newTitle.replace(/^["']|["']$/g, '');
          await supabase
            .from('chat_sessions')
            .update({ title: newTitle })
            .eq('id', sessionId);
        }
      } catch (err) {
        console.error('Failed to auto-rename session:', err);
      }
    }

    res.json({ output: aiText });

  } catch (error) {
    console.warn('Supabase transaction failed, falling back to local JSON database:', error.message);
    useLocalFallback = true;
    
    // Save to local JSON after fallback
    const data = readLocalData();
    
    // Save user message
    const userMsg = {
      id: crypto.randomUUID(),
      session_id: sessionId,
      role: 'user',
      content: message,
      created_at: new Date().toISOString()
    };
    data.messages.push(userMsg);
    
    // Generate context for Groq
    const history = data.messages
      .filter(msg => msg.session_id === sessionId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .slice(-20);

    const dynamicPrompt = `${SYSTEM_PROMPT}${userName ? `\nThe student's name is ${userName}. Address them by name and personalize your responses.` : ''}`;
    const apiMessages = [
      { role: 'system', content: dynamicPrompt },
      ...history.map(msg => ({
        role: msg.role === 'assistant' || msg.role === 'ai' ? 'assistant' : 'user',
        content: msg.content
      }))
    ];

    try {
      const completion = await groq.chat.completions.create({
        messages: apiMessages,
        model: 'llama-3.3-70b-versatile',
        temperature: 0.7,
        max_tokens: 2048,
      });

      const aiText = completion.choices[0]?.message?.content || "I'm sorry, I couldn't formulate a response.";

      // Save AI message
      const aiMsg = {
        id: crypto.randomUUID(),
        session_id: sessionId,
        role: 'assistant',
        content: aiText,
        created_at: new Date().toISOString()
      };
      data.messages.push(aiMsg);

      // Update session timestamp
      const sessionIndex = data.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        data.sessions[sessionIndex].updated_at = new Date().toISOString();
      }

      writeLocalData(data);
      res.json({ output: aiText });
    } catch (groqErr) {
      console.error('Groq call failed in fallback route:', groqErr);
      res.status(500).json({ error: 'Failed to contact Groq API.' });
    }
  }
});

// Start Server
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
