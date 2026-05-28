import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { Send, Bot, User, PlusCircle, MessageSquare, Trash2, X, ChevronLeft, ChevronRight, Pencil, Paperclip, Check } from 'lucide-react';

const parseQuestionnaire = (text) => {
  if (!text) return { questionnaire: null, cleanText: '' };
  const match = text.match(/<questionnaire>([\s\S]*?)<\/questionnaire>/);
  if (match) {
    try {
      const jsonStr = match[1].trim();
      const questionnaire = JSON.parse(jsonStr);
      const cleanText = text.replace(/<questionnaire>[\s\S]*?<\/questionnaire>/, '').trim();
      return { questionnaire, cleanText };
    } catch (e) {
      console.error('Failed to parse questionnaire JSON:', e);
    }
  }
  return { questionnaire: null, cleanText: text };
};

const parseMessageAttachments = (text) => {
  if (!text) return { cleanText: '', attachments: [] };

  const match = text.match(/<attachments-data>([\s\S]*?)<\/attachments-data>/);
  const cleanText = text.replace(/<attachments-data>[\s\S]*?<\/attachments-data>/, '').trim();
  
  const attachments = [];
  if (match) {
    const rawData = match[1];
    const matches = rawData.matchAll(/\[Attached (?:File|PDF|Screenshot\/Image): (.*?)\]/g);
    for (const m of matches) {
      attachments.push(m[1]);
    }
  }
  
  return { cleanText, attachments };
};

const escapeHtml = (text) => {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const parseInlineMarkdown = (text) => {
  let escaped = escapeHtml(text);
  
  // Bold: **text** or __text__
  let html = escaped
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.*?)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_
  html = html
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/_(.*?)_/g, '<em>$1</em>');

  // Code: `code`
  html = html.replace(/`(.*?)`/g, '<code class="markdown-code">$1</code>');

  // Line breaks inside paragraph
  html = html.replace(/\n/g, '<br />');

  return html;
};

const renderMessageContent = (text) => {
  if (!text) return null;

  // Split by double newlines to find paragraphs/blocks
  const blocks = text.split(/\n\n+/);

  return blocks.map((block, blockIdx) => {
    block = block.trim();
    if (!block) return null;

    // Check if it's a header
    if (block.startsWith('### ')) {
      const headerText = block.substring(4);
      return (
        <h3 key={blockIdx} className="markdown-h3" dangerouslySetInnerHTML={{ __html: parseInlineMarkdown(headerText) }} />
      );
    }
    if (block.startsWith('## ')) {
      const headerText = block.substring(3);
      return (
        <h2 key={blockIdx} className="markdown-h2" dangerouslySetInnerHTML={{ __html: parseInlineMarkdown(headerText) }} />
      );
    }
    if (block.startsWith('# ')) {
      const headerText = block.substring(2);
      return (
        <h1 key={blockIdx} className="markdown-h1" dangerouslySetInnerHTML={{ __html: parseInlineMarkdown(headerText) }} />
      );
    }

    // Check if it's a bulleted list (lines starting with * or -)
    const lines = block.split('\n');
    const isBulletList = lines.every(line => {
      const trimmed = line.trim();
      return trimmed.startsWith('* ') || trimmed.startsWith('- ') || trimmed === '';
    });

    if (isBulletList) {
      const items = lines.filter(line => line.trim() !== '');
      return (
        <ul key={blockIdx} className="markdown-list">
          {items.map((item, itemIdx) => {
            const cleanItem = item.replace(/^[\*\-]\s+/, '');
            return (
              <li key={itemIdx} dangerouslySetInnerHTML={{ __html: parseInlineMarkdown(cleanItem) }} />
            );
          })}
        </ul>
      );
    }

    // Default paragraph
    return (
      <p 
        key={blockIdx} 
        className="markdown-paragraph"
        dangerouslySetInnerHTML={{ __html: parseInlineMarkdown(block) }}
      />
    );
  });
};

function App() {
  const [sessions, setSessions] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  const [userName, setUserName] = useState(() => {
    return localStorage.getItem('libre_ai_username') || '';
  });
  
  // Questionnaire states
  const [activeQuestionnaire, setActiveQuestionnaire] = useState(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [customInput, setCustomInput] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);

  // Editing state for session renaming
  const [editingSessionId, setEditingSessionId] = useState(null);
  const [editingTitle, setEditingTitle] = useState('');

  // File attachments state
  const [attachments, setAttachments] = useState([]);
  const fileInputRef = useRef(null);

  const messagesEndRef = useRef(null);

  useEffect(() => {
    localStorage.setItem('libre_ai_username', userName);
  }, [userName]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const fetchSessions = async () => {
    try {
      setConnectionError(false);
      const response = await axios.get('/api/sessions');
      setSessions(response.data);
      if (response.data.length > 0) {
        setCurrentSessionId(response.data[0].id);
      } else {
        // If no sessions exist, create one
        await handleNewChat();
      }
    } catch (error) {
      console.error('Error fetching sessions:', error);
      setConnectionError(true);
      setMessages([
        { id: 'error', role: 'ai', text: 'Sorry, we could not connect to the backend server. Please make sure your backend server is running on http://localhost:5000.' }
      ]);
    }
  };

  // Fetch sessions on mount
  useEffect(() => {
    fetchSessions();
  }, []);

  // Global paste handler to capture images from clipboard
  useEffect(() => {
    const handleGlobalPaste = async (e) => {
      // If the user is currently typing in an input element (like the username field), ignore
      const activeEl = document.activeElement;
      if (activeEl && activeEl.tagName === 'INPUT') {
        return;
      }
      
      const items = (e.clipboardData || window.clipboardData)?.items;
      if (!items) return;
      
      let hasImage = false;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          hasImage = true;
          const file = item.getAsFile();
          if (file) {
            try {
              const compressedDataUrl = await compressImage(file);
              const filename = `pasted-image-${Date.now()}.jpg`;
              setAttachments(prev => [
                ...prev,
                {
                  name: filename,
                  type: 'image/jpeg',
                  size: Math.round((compressedDataUrl.length * 3) / 4),
                  data: compressedDataUrl
                }
              ]);
            } catch (err) {
              console.error('Error compressing pasted image:', err);
              const reader = new FileReader();
              reader.onload = (event) => {
                const filename = `pasted-image-${Date.now()}`;
                setAttachments(prev => [
                  ...prev,
                  {
                    name: filename,
                    type: file.type,
                    size: file.size,
                    data: event.target.result
                  }
                ]);
              };
              reader.readAsDataURL(file);
            }
          }
        }
      }
      if (hasImage) {
        e.preventDefault();
      }
    };
    
    window.addEventListener('paste', handleGlobalPaste);
    return () => {
      window.removeEventListener('paste', handleGlobalPaste);
    };
  }, []);

  // Fetch messages when active session changes
  useEffect(() => {
    if (!currentSessionId) return;

    const fetchMessages = async () => {
      setIsLoading(true);
      try {
        const response = await axios.get(`/api/sessions/${currentSessionId}/messages`);
        let parsedActiveQuestionnaire = null;
        const mappedMessages = response.data.map((msg, index, arr) => {
          const isLast = index === arr.length - 1;
          const { questionnaire, cleanText: textAfterQuestionnaire } = parseQuestionnaire(msg.content);
          if (isLast && msg.role === 'assistant' && questionnaire) {
            parsedActiveQuestionnaire = questionnaire;
          }
          const { cleanText: finalCleanText, attachments: msgAttachments } = parseMessageAttachments(textAfterQuestionnaire);
          return {
            id: msg.id,
            role: msg.role === 'assistant' ? 'ai' : msg.role,
            text: finalCleanText,
            attachments: msgAttachments || []
          };
        });

        if (mappedMessages.length === 0) {
          setMessages([
            { id: 'welcome', role: 'ai', text: 'Hello! I am your Libre Academy AI assistant. How can I help you with the course material today?' }
          ]);
        } else {
          setMessages(mappedMessages);
        }

        setActiveQuestionnaire(parsedActiveQuestionnaire);
        setCurrentStep(0);
        setAnswers({});
        setCustomInput('');
        setShowCustomInput(false);
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

  const handleDeleteSession = async (sessionId) => {
    if (!window.confirm("Are you sure you want to delete this conversation?")) return;

    try {
      await axios.delete(`/api/sessions/${sessionId}`);
      
      setSessions(prev => {
        const filtered = prev.filter(s => s.id !== sessionId);
        
        // If we deleted the current session, select another one
        if (currentSessionId === sessionId) {
          if (filtered.length > 0) {
            setCurrentSessionId(filtered[0].id);
          } else {
            setCurrentSessionId(null);
            setMessages([
              { id: 'welcome', role: 'ai', text: 'Hello! I am your Libre Academy AI assistant. How can I help you today?' }
            ]);
            // Create a new session automatically if none remain
            handleNewChat();
          }
        }
        return filtered;
      });
    } catch (error) {
      console.error('Error deleting session:', error);
      alert("Failed to delete the conversation. Please check your connection.");
    }
  };

  const handleRenameSession = async (sessionId, newTitle) => {
    if (!newTitle.trim()) {
      alert("Title cannot be empty.");
      return;
    }

    try {
      const response = await axios.put(`/api/sessions/${sessionId}`, { title: newTitle.trim() });
      const updatedSession = response.data;
      
      setSessions(prev => 
        prev.map(s => s.id === sessionId ? { ...s, title: updatedSession.title } : s)
      );
      setEditingSessionId(null);
    } catch (error) {
      console.error('Error renaming session:', error);
      alert("Failed to rename the conversation. Please check your connection.");
    }
  };

  const sendMessageText = async (textToSend, attachmentsToSend = []) => {
    if (!textToSend.trim() && attachmentsToSend.length === 0) return;

    if (!currentSessionId) {
      alert("Connection Error: No active chat session could be established. Please verify that your backend server is running on http://localhost:5000 and try again.");
      return;
    }

    const userMessage = { 
      id: Date.now(), 
      role: 'user', 
      text: textToSend,
      attachments: attachmentsToSend ? attachmentsToSend.map(a => a.name) : []
    };
    setMessages(prev => {
      // Remove welcome placeholder if sending first message
      const filtered = prev.filter(m => m.id !== 'welcome');
      return [...filtered, userMessage];
    });
    setIsLoading(true);

    try {
      // Close active questionnaire as we are replying
      setActiveQuestionnaire(null);

      const response = await axios.post('/api/chat', {
        sessionId: currentSessionId,
        message: textToSend,
        userName: userName,
        attachments: attachmentsToSend
      });

      const aiResponseText = response.data?.output || "Sorry, I received an empty response.";
      const { questionnaire, cleanText: textAfterQuestionnaire } = parseQuestionnaire(aiResponseText);
      const { cleanText: finalCleanText, attachments: msgAttachments } = parseMessageAttachments(textAfterQuestionnaire);
      const aiMessage = { 
        id: Date.now() + 1, 
        role: 'ai', 
        text: finalCleanText,
        attachments: msgAttachments || []
      };
      setMessages(prev => [...prev, aiMessage]);

      if (questionnaire) {
        setActiveQuestionnaire(questionnaire);
        setCurrentStep(0);
        setAnswers({});
        setCustomInput('');
        setShowCustomInput(false);
      }

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

  const handleSend = async () => {
    if (!input.trim() && attachments.length === 0) return;
    const text = input;
    const currentAttachments = [...attachments];
    setInput('');
    setAttachments([]);
    await sendMessageText(text, currentAttachments);
  };

  const compressImage = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const MAX_WIDTH = 1200;
          const MAX_HEIGHT = 1200;
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > MAX_WIDTH) {
              height *= MAX_WIDTH / width;
              width = MAX_WIDTH;
            }
          } else {
            if (height > MAX_HEIGHT) {
              width *= MAX_HEIGHT / height;
              height = MAX_HEIGHT;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          // Export as compressed JPEG (0.7 quality) to reduce file size to ~100-300KB
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          resolve(dataUrl);
        };
        img.onerror = (err) => reject(err);
        img.src = event.target.result;
      };
      reader.onerror = (err) => reject(err);
      reader.readAsDataURL(file);
    });
  };

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    files.forEach(async (file) => {
      if (file.type.startsWith('image/')) {
        try {
          const compressedDataUrl = await compressImage(file);
          setAttachments(prev => [
            ...prev,
            {
              name: file.name.replace(/\.[^/.]+$/, "") + ".jpg",
              type: 'image/jpeg',
              size: Math.round((compressedDataUrl.length * 3) / 4),
              data: compressedDataUrl
            }
          ]);
        } catch (err) {
          console.error('Error compressing image:', err);
          // Fallback to reading raw image if compression fails
          const reader = new FileReader();
          reader.onload = (event) => {
            setAttachments(prev => [
              ...prev,
              {
                name: file.name,
                type: file.type,
                size: file.size,
                data: event.target.result
              }
            ]);
          };
          reader.readAsDataURL(file);
        }
      } else {
        const reader = new FileReader();
        reader.onload = (event) => {
          setAttachments(prev => [
            ...prev,
            {
              name: file.name,
              type: file.type,
              size: file.size,
              data: event.target.result // Base64 data URL
            }
          ]);
        };
        reader.readAsDataURL(file);
      }
    });

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeAttachment = (indexToRemove) => {
    setAttachments(prev => prev.filter((_, idx) => idx !== indexToRemove));
  };

  const currentQuestion = activeQuestionnaire?.questions?.[currentStep];

  const handleSelectOption = (optionText) => {
    if (!currentQuestion) return;
    const updatedAnswers = { ...answers, [currentQuestion.question]: optionText };
    setAnswers(updatedAnswers);
    
    setShowCustomInput(false);
    setCustomInput('');

    if (currentStep < activeQuestionnaire.questions.length - 1) {
      setCurrentStep(prev => prev + 1);
    } else {
      submitQuestionnaire(updatedAnswers);
    }
  };

  const handleCustomSubmit = () => {
    if (!customInput.trim()) return;
    handleSelectOption(customInput.trim());
  };

  const handleSkipQuestion = () => {
    if (!currentQuestion) return;
    const updatedAnswers = { ...answers, [currentQuestion.question]: "[Skipped]" };
    setAnswers(updatedAnswers);
    
    setShowCustomInput(false);
    setCustomInput('');

    if (currentStep < activeQuestionnaire.questions.length - 1) {
      setCurrentStep(prev => prev + 1);
    } else {
      submitQuestionnaire(updatedAnswers);
    }
  };

  const submitQuestionnaire = async (finalAnswers) => {
    setActiveQuestionnaire(null);
    const formattedAnswers = Object.entries(finalAnswers)
      .map(([q, a]) => `- **${q}**: ${a}`)
      .join('\n');
    
    const messageText = `[Form Answers]:\n${formattedAnswers}`;
    await sendMessageText(messageText);
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

        <div className="user-profile">
          <label className="profile-label">Your Name</label>
          <input
            type="text"
            className="username-input"
            placeholder="Enter your name..."
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
          />
        </div>
        
        <button className="new-chat-btn" onClick={handleNewChat}>
          <PlusCircle size={18} />
          New Chat
        </button>

        {connectionError && (
          <div className="connection-warning">
            <p>Unable to connect to backend server.</p>
            <button onClick={fetchSessions} className="retry-btn">
              Retry Connection
            </button>
          </div>
        )}

        <div className="chat-history">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`history-item-container ${session.id === currentSessionId ? 'active' : ''} ${editingSessionId === session.id ? 'editing' : ''}`}
            >
              {editingSessionId === session.id ? (
                <div className="rename-input-container" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="text"
                    className="rename-input"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleRenameSession(session.id, editingTitle);
                      } else if (e.key === 'Escape') {
                        setEditingSessionId(null);
                      }
                    }}
                    autoFocus
                  />
                  <button
                    className="rename-action-btn save-btn"
                    onClick={() => handleRenameSession(session.id, editingTitle)}
                    title="Save"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    className="rename-action-btn cancel-btn"
                    onClick={() => setEditingSessionId(null)}
                    title="Cancel"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <>
                  <button
                    className="history-item"
                    onClick={() => setCurrentSessionId(session.id)}
                  >
                    <MessageSquare className="history-item-icon" size={16} />
                    <span className="history-item-title">{session.title}</span>
                  </button>
                  <div className="history-item-actions">
                    <button
                      className="edit-session-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingSessionId(session.id);
                        setEditingTitle(session.title);
                      }}
                      title="Rename Conversation"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="delete-session-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteSession(session.id);
                      }}
                      title="Delete Conversation"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </>
              )}
            </div>
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
              <div className="message-body-container">
                <div className="message-content">
                  {renderMessageContent(msg.text)}
                </div>
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="message-attachments-list">
                    {msg.attachments.map((name, idx) => (
                      <div key={idx} className="message-attachment-chip" title={name}>
                        <Paperclip size={12} />
                        <span>{name}</span>
                      </div>
                    ))}
                  </div>
                )}
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

        {activeQuestionnaire && currentQuestion && (
          <div className="questionnaire-card">
            <div className="questionnaire-header">
              <span className="questionnaire-title">{activeQuestionnaire.title}</span>
              <div className="questionnaire-nav">
                <button 
                  className="nav-arrow-btn" 
                  onClick={() => {
                    setCurrentStep(prev => Math.max(0, prev - 1));
                    setShowCustomInput(false);
                    setCustomInput('');
                  }}
                  disabled={currentStep === 0}
                >
                  <ChevronLeft size={16} />
                </button>
                <span className="step-indicator">{currentStep + 1} of {activeQuestionnaire.questions.length}</span>
                <button 
                  className="nav-arrow-btn" 
                  onClick={() => {
                    setCurrentStep(prev => Math.min(activeQuestionnaire.questions.length - 1, prev + 1));
                    setShowCustomInput(false);
                    setCustomInput('');
                  }}
                  disabled={currentStep === activeQuestionnaire.questions.length - 1}
                >
                  <ChevronRight size={16} />
                </button>
                <button className="close-card-btn" onClick={() => setActiveQuestionnaire(null)}>
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="questionnaire-body">
              <h3 className="question-text">{currentQuestion.question}</h3>
              
              <div className="options-container">
                {!showCustomInput ? (
                  <>
                    {currentQuestion.options?.map((opt, idx) => (
                      <button 
                        key={idx} 
                        className="option-row"
                        onClick={() => handleSelectOption(opt)}
                      >
                        <span className="option-number">{idx + 1}</span>
                        <span className="option-text">{opt}</span>
                        <ChevronRight className="option-arrow" size={16} />
                      </button>
                    ))}
                    
                    {currentQuestion.allow_custom && (
                      <button 
                        className="option-row custom-option-row"
                        onClick={() => setShowCustomInput(true)}
                      >
                        <span className="option-number"><Pencil size={12} /></span>
                        <span className="option-text">Something else</span>
                        <ChevronRight className="option-arrow" size={16} />
                      </button>
                    )}
                  </>
                ) : (
                  <div className="custom-input-container">
                    <input
                      type="text"
                      className="custom-input-field"
                      placeholder="Type your custom answer..."
                      value={customInput}
                      onChange={(e) => setCustomInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleCustomSubmit();
                        }
                      }}
                      autoFocus
                    />
                    <div className="custom-input-actions">
                      <button 
                        className="cancel-custom-btn"
                        onClick={() => setShowCustomInput(false)}
                      >
                        Cancel
                      </button>
                      <button 
                        className="submit-custom-btn"
                        onClick={handleCustomSubmit}
                        disabled={!customInput.trim()}
                      >
                        Confirm
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="questionnaire-footer">
              <button className="skip-card-btn" onClick={handleSkipQuestion}>
                Skip
              </button>
            </div>
          </div>
        )}

        {/* Input Area */}
        <div className="input-area">
          <div className="input-container">
            {attachments.length > 0 && (
              <div className="attachment-previews">
                {attachments.map((file, idx) => (
                  <div key={idx} className="attachment-preview-chip">
                    <span className="file-name" title={file.name}>{file.name}</span>
                    <button className="remove-file-btn" onClick={() => removeAttachment(idx)}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="input-row">
              <button 
                className="attach-btn" 
                onClick={() => fileInputRef.current?.click()}
                type="button"
                title="Attach screenshots or documents"
              >
                <Paperclip size={18} />
              </button>
              <textarea 
                className="chat-input" 
                placeholder="Ask a question or describe attachments..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows="1"
              />
              <button 
                className="send-btn" 
                onClick={handleSend}
                disabled={(!input.trim() && attachments.length === 0) || isLoading}
              >
                <Send size={18} />
              </button>
            </div>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              style={{ display: 'none' }}
              multiple
            />
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
