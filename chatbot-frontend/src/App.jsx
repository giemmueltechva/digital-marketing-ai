import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { Send, Bot, User, PlusCircle, MessageSquare } from 'lucide-react';

function App() {
  const [sessions, setSessions] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Fetch sessions on mount
  useEffect(() => {
    const fetchSessions = async () => {
      try {
        const response = await axios.get('/api/sessions');
        setSessions(response.data);
        if (response.data.length > 0) {
          setCurrentSessionId(response.data[0].id);
        } else {
          // If no sessions exist, create one
          handleNewChat();
        }
      } catch (error) {
        console.error('Error fetching sessions:', error);
      }
    };
    fetchSessions();
  }, []);

  // Fetch messages when active session changes
  useEffect(() => {
    if (!currentSessionId) return;

    const fetchMessages = async () => {
      setIsLoading(true);
      try {
        const response = await axios.get(`/api/sessions/${currentSessionId}/messages`);
        const mappedMessages = response.data.map(msg => ({
          id: msg.id,
          role: msg.role === 'assistant' ? 'ai' : msg.role,
          text: msg.content
        }));

        if (mappedMessages.length === 0) {
          setMessages([
            { id: 'welcome', role: 'ai', text: 'Hello! I am your Libre Academy AI assistant. How can I help you with the course material today?' }
          ]);
        } else {
          setMessages(mappedMessages);
        }
      } catch (error) {
        console.error('Error fetching messages:', error);
        setMessages([
          { id: 'error', role: 'ai', text: 'Sorry, we could not load this conversation. Please check if the server is running.' }
        ]);
      } finally {
        setIsLoading(false);
      }
    };
    fetchMessages();
  }, [currentSessionId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const handleNewChat = async () => {
    try {
      const response = await axios.post('/api/sessions', { title: 'New Conversation' });
      const newSession = response.data;
      setSessions(prev => [newSession, ...prev]);
      setCurrentSessionId(newSession.id);
      setMessages([
        { id: 'welcome', role: 'ai', text: 'Hello! I am your Libre Academy AI assistant. How can I help you today?' }
      ]);
    } catch (error) {
      console.error('Error creating new session:', error);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || !currentSessionId) return;

    const userMessage = { id: Date.now(), role: 'user', text: input };
    setMessages(prev => {
      // Remove welcome placeholder if sending first message
      const filtered = prev.filter(m => m.id !== 'welcome');
      return [...filtered, userMessage];
    });
    setInput('');
    setIsLoading(true);

    try {
      const response = await axios.post('/api/chat', {
        sessionId: currentSessionId,
        message: userMessage.text
      });

      const aiResponseText = response.data?.output || "Sorry, I received an empty response.";
      const aiMessage = { id: Date.now() + 1, role: 'ai', text: aiResponseText };
      setMessages(prev => [...prev, aiMessage]);

      // Reload sessions list to get any title updates (auto-rename)
      const sessionsResponse = await axios.get('/api/sessions');
      setSessions(sessionsResponse.data);
    } catch (error) {
      console.error('Error communicating with backend:', error);
      const errorMessage = { id: Date.now() + 1, role: 'ai', text: "Sorry, I couldn't connect to the server. Please make sure your backend server is running." };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="brand">
          <Bot className="brand-icon" size={28} />
          <span>Libre AI</span>
        </div>
        
        <button className="new-chat-btn" onClick={handleNewChat}>
          <PlusCircle size={18} />
          New Chat
        </button>

        <div className="chat-history">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`history-item ${session.id === currentSessionId ? 'active' : ''}`}
              onClick={() => setCurrentSessionId(session.id)}
            >
              <MessageSquare className="history-item-icon" size={16} />
              <span className="history-item-title">{session.title}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="main-chat">
        <div className="chat-messages">
          {messages.map((msg) => (
            <div key={msg.id} className={`message ${msg.role}`}>
              <div className={`avatar ${msg.role === 'ai' ? 'ai-avatar' : 'user-avatar'}`}>
                {msg.role === 'ai' ? <Bot size={20} /> : <User size={20} />}
              </div>
              <div className="message-content">
                {msg.text}
              </div>
            </div>
          ))}
          {isLoading && messages.length > 0 && messages[messages.length - 1].role === 'user' && (
            <div className="message ai">
              <div className="avatar ai-avatar">
                <Bot size={20} />
              </div>
              <div className="message-content">
                <span className="typing-indicator">Thinking...</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="input-area">
          <div className="input-container">
            <textarea 
              className="chat-input" 
              placeholder="Ask a question about the course..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows="1"
            />
            <button 
              className="send-btn" 
              onClick={handleSend}
              disabled={!input.trim() || isLoading}
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
