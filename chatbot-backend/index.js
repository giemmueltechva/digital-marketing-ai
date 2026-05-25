require('dotenv').config();
const express = require('express');

// Polyfill DOMMatrix for modern pdfjs-dist used in Node.js
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      if (!init) return;
      if (Array.isArray(init)) {
        this.a = init[0]; this.b = init[1]; this.c = init[2];
        this.d = init[3]; this.e = init[4]; this.f = init[5];
      } else if (typeof init === 'string') {
        const match = init.match(/matrix\(([^)]+)\)/);
        if (match) {
          const parts = match[1].split(',').map(parseFloat);
          this.a = parts[0]; this.b = parts[1]; this.c = parts[2];
          this.d = parts[3]; this.e = parts[4]; this.f = parts[5];
        }
      }
    }
    toString() {
      return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`;
    }
  };
}

const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and JSON parsing with custom payload limit for attachments
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

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

// Parse PDF text from Base64
async function parsePdf(base64Data) {
  try {
    // Force Vercel's bundler to package the PDF worker file
    if (false) {
      const fs = require('fs');
      const path = require('path');
      fs.readFileSync(path.join(__dirname, 'node_modules/pdf-parse/dist/pdf-parse/cjs/pdf.worker.mjs'));
    }

    require('pdf-parse/worker');
    const { PDFParse } = require('pdf-parse');
    const rawBase64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
    const buffer = Buffer.from(rawBase64, 'base64');
    const parser = new PDFParse({ data: buffer });
    const data = await parser.getText();
    return data.text || '';
  } catch (err) {
    console.error('Error parsing PDF:', err);
    return `[Error extracting text from PDF: ${err.message}]`;
  }
}

// Run OCR on Image from Base64
async function parseImageOCR(base64Data) {
  try {
    // Force Vercel's bundler to package the eng.traineddata file
    if (false) {
      const fs = require('fs');
      const path = require('path');
      fs.readFileSync(path.join(__dirname, 'eng.traineddata'));
    }

    const Tesseract = require('tesseract.js');
    const rawBase64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
    const buffer = Buffer.from(rawBase64, 'base64');

    const result = await Tesseract.recognize(buffer, 'eng', {
      langPath: __dirname,
      gzip: false
    });
    return result.data.text || '';
  } catch (err) {
    console.error('Error performing OCR on image:', err);
    return `[Error performing OCR on image: ${err.message}]`;
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

Handling Attachments:
1. The student can upload files (PDFs, text files, CSVs, markdown) or screenshots/images.
2. The system automatically extracts text/data from these attachments and appends them to the end of the student's message inside <attachments-data> tags, formatted as:
   [Attached File/PDF/Screenshot: <filename>]
   ---
   <extracted contents>
   ---
3. You have full access to these extracted contents. Do NOT tell the student you cannot read or access attachments. Simply use the provided text/data to answer their questions or help them.

Formatting and Meta-Commentary Rules:
1. Always format your responses using clean, readable markdown structure. Use double line breaks between paragraphs.
2. Use bold headers (e.g., ### Key Points) and bullet points (e.g., * Item) to structure lists and summaries. Make sure lists are clean and easy to read.
3. NEVER write notes, warnings, or planning thoughts to yourself (such as "(Note: This is the final question...)" or "I will summarize after this"). Everything you write must be 100% user-facing response content.
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
  const { sessionId, message, userName, attachments } = req.body;

  if (!sessionId || (!message && (!attachments || attachments.length === 0))) {
    return res.status(400).json({ error: 'sessionId and either message or attachments are required.' });
  }

  let compiledMessage = message || '';

  if (attachments && attachments.length > 0) {
    try {
      let attachmentTexts = [];
      for (const attach of attachments) {
        console.log(`Processing attachment: ${attach.name} (type: ${attach.type})`);
        
        // 1. Text Documents
        if (
          attach.type.startsWith('text/') || 
          attach.name.endsWith('.txt') || 
          attach.name.endsWith('.csv') || 
          attach.name.endsWith('.json') || 
          attach.name.endsWith('.md')
        ) {
          const rawBase64 = attach.data.includes(',') ? attach.data.split(',')[1] : attach.data;
          const fileContent = Buffer.from(rawBase64, 'base64').toString('utf8');
          attachmentTexts.push(`[Attached File: ${attach.name}]\n---\n${fileContent}\n---`);
        }
        // 2. PDF Documents
        else if (attach.type === 'application/pdf' || attach.name.endsWith('.pdf')) {
          const pdfText = await parsePdf(attach.data);
          attachmentTexts.push(`[Attached PDF: ${attach.name}]\n---\n${pdfText}\n---`);
        }
        // 3. Image Screenshots (OCR)
        else if (attach.type.startsWith('image/')) {
          const ocrText = await parseImageOCR(attach.data);
          attachmentTexts.push(`[Attached Screenshot/Image: ${attach.name}]\n---\n[OCR Text Extracted]:\n${ocrText}\n---`);
        }
        // 4. Fallback for other files
        else {
          attachmentTexts.push(`[Attached File: ${attach.name} (Unsupported format, contents not read)]`);
        }
      }
      
      if (attachmentTexts.length > 0) {
        compiledMessage = `${message || '[Uploaded attachment(s)]'}\n\n<attachments-data>\n${attachmentTexts.join('\n\n')}\n</attachments-data>`;
      }
    } catch (attachErr) {
      console.error('Error processing attachments:', attachErr);
    }
  }

  if (useLocalFallback) {
    try {
      const data = readLocalData();

      // Save user message
      const userMsg = {
        id: crypto.randomUUID(),
        session_id: sessionId,
        role: 'user',
        content: compiledMessage,
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
                { role: 'user', content: message || 'Attachment uploaded' } // Use original clean message or fallback
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
        content: compiledMessage
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
            { role: 'user', content: message || 'Attachment uploaded' } // Use original clean message or fallback
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
      content: compiledMessage,
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
