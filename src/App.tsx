/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Bot, MessageCircle, Settings, Activity, Send, User, Clock, ShieldCheck, UserPlus, Search, Check, CheckCheck, AlertCircle, CheckCircle, Download, ThumbsUp, ThumbsDown, Camera, Mic, Video, FileText } from 'lucide-react';
import firebaseConfig from '../firebase-applet-config.json';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';

// Handle Firebase Init (we wrap it to prevent crashes if config is missing)
let app: ReturnType<typeof initializeApp> | null = null;
let db: ReturnType<typeof getFirestore> | null = null;
try {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
} catch (error) {
  console.warn("Could not load Firebase config locally");
}

interface ToastMessage {
  id: number;
  text: string;
  type: 'error' | 'success';
}

interface HealthStatus {
  status: string;
  usingRealAPI: boolean;
  agentPresence?: string;
  geminiLatency?: number;
}

interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  agentHandled: boolean;
  status?: 'sent' | 'delivered' | 'read' | 'failed';
  failureReason?: string;
}

interface Conversation {
  id: string; // phone number
  messages: ChatMessage[];
  updatedAt: number;
  isTyping?: boolean;
  isAgentHandled?: boolean;
  customerName?: string;
  tags?: string[];
  notes?: string;
  crmFields?: {
    email?: string;
    orderId?: string;
    ltv?: number;
  };
}

export default function App() {
  useEffect(() => {
    if (db) {
      async function testConnection() {
        try {
          await getDocFromServer(doc(db!, 'test', 'connection'));
        } catch (error) {
          if(error instanceof Error && error.message.includes('the client is offline')) {
            console.error("Please check your Firebase configuration.");
          }
        }
      }
      testConnection();
    }
  }, []);

  const [activeTab, setActiveTab] = useState<'dashboard' | 'settings'>('dashboard');
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [botPrompt, setBotPrompt] = useState<string>('');
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [whatsappToken, setWhatsappToken] = useState('');
  const [whatsappPhoneNumberId, setWhatsappPhoneNumberId] = useState('');
  const [webhookVerifyToken, setWebhookVerifyToken] = useState('');
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConvo, setSelectedConvo] = useState<Conversation | null>(null);
  const [filterMode, setFilterMode] = useState<'all' | 'active' | 'agent' | 'failed' | 'unread'>('all');
  const [isHandingOver, setIsHandingOver] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [manualReplyText, setManualReplyText] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastHandledMessageTimestamp = useRef<number>(Date.now());
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);

  useEffect(() => {
    if ("Notification" in window) {
      if (Notification.permission === "granted") {
        setNotificationsEnabled(true);
      } else if (Notification.permission !== "denied") {
        Notification.requestPermission().then(permission => {
           if (permission === "granted") setNotificationsEnabled(true);
        });
      }
    }
  }, []);

  const playNotificationSound = () => {
    // A simple short pop/beep base64 data URI
    const audioContent = "data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YU"+Array(50).join("z"); 
    try {
      const audio = new Audio("data:audio/wav;base64,UklGRnoAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVEAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICA/v7+/j8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/PwA=");
      // It's a short pop. (In reality doing a silent/random base64 is tricky, using a simple beep sequence or relying on browser notification sound).
      // Let's use a very basic web-audio beep:
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.1);
    } catch(e) {}
  };

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + F to focus search
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  const showToast = (text: string, type: 'error' | 'success' = 'error') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, text, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => setHealth(data))
      .catch((err) => {
        console.error('Error fetching health status', err)
        showToast('System health check failed. Could not reach server.');
      });

    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => {
         setBotPrompt(data.botPrompt);
         if (data.quickReplies) setQuickReplies(data.quickReplies);
         if (data.whatsappToken) setWhatsappToken(data.whatsappToken);
         if (data.whatsappPhoneNumberId) setWhatsappPhoneNumberId(data.whatsappPhoneNumberId);
         if (data.webhookVerifyToken) setWebhookVerifyToken(data.webhookVerifyToken);
      })
      .catch((err) => showToast('Failed to connect to configurations backend.'));
  }, []);

  useEffect(() => {
    // Poll for conversations
    if (activeTab === 'dashboard') {
      const fetchConvos = () => {
        fetch('/api/conversations')
          .then(async res => {
            if(!res.ok) throw new Error("Failed network");
            return res.json();
          })
          .then(data => {
             setConversations(data);
             // Detect new messages
             let maxNewTimestamp = lastHandledMessageTimestamp.current;
             let newMessagesCount = 0;
             
             data.forEach((convo: Conversation) => {
                convo.messages.forEach(msg => {
                   if (msg.role === 'user' && msg.timestamp > lastHandledMessageTimestamp.current) {
                      newMessagesCount++;
                      if (msg.timestamp > maxNewTimestamp) maxNewTimestamp = msg.timestamp;
                      if (notificationsEnabled) {
                         new Notification("New WhatsApp Message", {
                            body: msg.text.substring(0, 50) + (msg.text.length > 50 ? '...' : ''),
                         });
                      }
                   }
                });
             });
             
             if (newMessagesCount > 0) {
                 playNotificationSound();
                 lastHandledMessageTimestamp.current = maxNewTimestamp;
             }

             // Update selected convo if it exists
             setSelectedConvo(prev => {
                if (prev) {
                  const updated = data.find((c: Conversation) => c.id === prev.id);
                  return updated || prev;
                }
                return prev;
             });
          })
          .catch(err => {
             console.error('Error fetching conversations', err);
             // Silently fail polling so we don't spam toasts
          });
      };
      fetchConvos();
      const interval = setInterval(fetchConvos, 3000);
      return () => clearInterval(interval);
    }
  }, [activeTab]);

  const handleSavePrompt = async () => {
    setSavingPrompt(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          prompt: botPrompt, 
          replies: quickReplies,
          token: whatsappToken,
          phoneId: whatsappPhoneNumberId,
          verifyToken: webhookVerifyToken
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.success) {
        setBotPrompt(data.botPrompt);
        if (data.quickReplies) setQuickReplies(data.quickReplies);
        if (data.whatsappToken) setWhatsappToken(data.whatsappToken);
        if (data.whatsappPhoneNumberId) setWhatsappPhoneNumberId(data.whatsappPhoneNumberId);
        if (data.webhookVerifyToken) setWebhookVerifyToken(data.webhookVerifyToken);
        showToast('Configuration saved successfully!', 'success');
      }
    } catch (e: any) {
      console.error(e);
      showToast(e.message || 'Failed to save configuration');
    } finally {
      setSavingPrompt(false);
    }
  };

  const handleHandover = async () => {
    if (!selectedConvo) return;
    setIsHandingOver(true);
    try {
      const res = await fetch(`/api/conversations/${selectedConvo.id}/handover`, {
        method: 'POST',
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.success) {
        setSelectedConvo(data.convo);
        showToast('Handed over to human agent', 'success');
      }
    } catch (e: any) {
      console.error("Error handing over conversation:", e);
      showToast(e.message || 'Failed to hand over conversation');
    } finally {
      setIsHandingOver(false);
    }
  };

  const handleExportChat = () => {
    if (!selectedConvo) return;
    let textContent = `Conversation Header\nPhone Number: +${selectedConvo.id}\nExported At: ${new Date().toLocaleString()}\n\n`;
    textContent += `--- Chat History ---\n\n`;

    selectedConvo.messages.forEach(msg => {
      const time = new Date(msg.timestamp).toLocaleString();
      const sender = msg.role === 'user' ? 'Customer' : 'Bot/Agent';
      textContent += `[${time}] ${sender}:\n${msg.text}\n\n`;
    });

    const blob = new Blob([textContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat_history_${selectedConvo.id}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Conversation exported successfully', 'success');
  };

  const [isSendingReply, setIsSendingReply] = useState(false);
  const handleQuickReply = async (text: string) => {
    if (!selectedConvo) return;
    setIsSendingReply(true);
    try {
      const res = await fetch(`/api/conversations/${selectedConvo.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if(data.success) {
        setSelectedConvo(data.convo);
      }
    }  catch (e: any) {
      console.error("Error sending quick reply:", e);
      showToast(e.message || 'Failed to send quick reply');
    } finally {
      setIsSendingReply(false);
    }
  };

  const handleManualSubmit = async () => {
    if (!selectedConvo || !manualReplyText.trim()) return;
    const textToSubmit = manualReplyText.trim();
    setManualReplyText(''); // optimistic clear
    await handleQuickReply(textToSubmit);
  };

  const handleManualKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleManualSubmit();
    }
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const filteredConversations = React.useMemo(() => {
    return conversations.filter(convo => {
      const q = searchQuery.toLowerCase();
      const searchMatch = convo.id.includes(q) || convo.messages.some(m => m.text.toLowerCase().includes(q));
      
      let filterMatch = true;
      switch(filterMode) {
        case 'active':
          filterMatch = !convo.isAgentHandled;
          break;
        case 'agent':
          filterMatch = !!convo.isAgentHandled;
          break;
        case 'failed':
          filterMatch = convo.messages.some(m => m.status === 'failed');
          break;
        case 'unread':
          filterMatch = convo.messages.some(m => m.role === 'user' && !m.status); // Basic approximation for unread
          break;
        case 'all':
        default:
          filterMatch = true;
      }
      return searchMatch && filterMatch;
    }).sort((a, b) => {
      const getPriorityWeight = (p?: string) => {
        if (p === 'high') return 3;
        if (p === 'medium') return 2;
        if (p === 'low') return 1;
        return 0;
      };
      const pDiff = getPriorityWeight(b.priority) - getPriorityWeight(a.priority);
      if (pDiff !== 0) return pDiff;
      return b.updatedAt - a.updatedAt;
    });
  }, [conversations, searchQuery, filterMode]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [selectedConvo?.messages, selectedConvo?.isTyping]);

  useEffect(() => {
    document.title = filteredConversations.some(c => c.unreadCount && c.unreadCount > 0) 
      ? `(${filteredConversations.filter(c => c.unreadCount && c.unreadCount > 0).length}) ConvoZen Inbox` 
      : 'ConvoZen Inbox';
  }, [filteredConversations]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + F to focus search
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      
      const isInputFocused = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';
      if (isInputFocused) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (filteredConversations.length === 0) return;
        if (!selectedConvo) {
           setSelectedConvo(filteredConversations[0]);
           if (filteredConversations[0].unreadCount) fetch(`/api/conversations/${filteredConversations[0].id}/read`, { method: 'POST' });
           return;
        }
        
        const currentIndex = filteredConversations.findIndex(c => c.id === selectedConvo.id);
        if (currentIndex === -1) return;
        
        if (e.key === 'ArrowDown' && currentIndex < filteredConversations.length - 1) {
          const next = filteredConversations[currentIndex + 1];
          setSelectedConvo(next);
          if (next.unreadCount) fetch(`/api/conversations/${next.id}/read`, { method: 'POST' });
        } else if (e.key === 'ArrowUp' && currentIndex > 0) {
          const prev = filteredConversations[currentIndex - 1];
          setSelectedConvo(prev);
          if (prev.unreadCount) fetch(`/api/conversations/${prev.id}/read`, { method: 'POST' });
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredConversations, selectedConvo]);

  const handleRateMessage = async (msgId: string, rating: 'up' | 'down') => {
    if (!selectedConvo) return;
    try {
      const res = await fetch(`/api/conversations/${selectedConvo.id}/messages/${msgId}/rate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating })
      });
      const data = await res.json();
      if(data.success) {
        setSelectedConvo(data.convo);
      }
    } catch (e) {
      console.error("Error rating message", e);
    }
  };

  const handleRetryMessage = async (msgId: string) => {
    if (!selectedConvo) return;
    try {
      const res = await fetch(`/api/conversations/${selectedConvo.id}/messages/${msgId}/retry`, {
        method: 'POST',
      });
      const data = await res.json();
      if(data.success) {
        setSelectedConvo(data.convo);
        showToast('Message retried', 'success');
      } else {
        showToast(data.error || 'Retry failed');
        if (data.convo) setSelectedConvo(data.convo);
      }
    } catch (e) {
      console.error("Error retrying message", e);
      showToast('Error retrying message');
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [selectedConvo?.messages.length, selectedConvo?.isTyping]);

  return (
    <div className="min-h-screen bg-zen-bg flex flex-col md:flex-row font-sans text-zen-text overflow-hidden relative selection:bg-zen-accent/20">
      {/* Toasts overlay */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map(t => (
          <div key={t.id} className={`px-4 py-3 rounded-lg shadow-lg border flex items-center gap-2 ${t.type === 'error' ? 'bg-red-50 border-red-100 text-red-800' : 'bg-emerald-50 border-emerald-100 text-emerald-800'} animate-in fade-in slide-in-from-top-2 duration-300`}>
             {t.type === 'error' ? <AlertCircle size={16} className="text-red-500" /> : <CheckCircle size={16} className="text-emerald-500" />}
             <span className="text-sm font-medium">{t.text}</span>
          </div>
        ))}
      </div>

      {/* Sidebar sidebar */}
      <aside className="w-full md:w-64 bg-zen-card border-r border-zen-border/50 flex flex-col p-6 gap-6 shrink-0 z-20 shadow-zen">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 bg-zen-accent rounded-full flex items-center justify-center">
            <Bot size={18} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-medium text-zen-text tracking-wide leading-tight lowercase">ConvoZen</h1>
            <p className="text-xs text-zen-text/50 font-light mt-0.5 lowercase">WhatsApp AI</p>
          </div>
        </div>

        <nav className="flex flex-col gap-1 mt-2">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`flex items-center gap-3 px-4 py-3 rounded-2xl transition-all duration-300 text-sm ${
              activeTab === 'dashboard'
                ? 'bg-zen-bg shadow-zen text-zen-text font-medium'
                : 'text-zen-text/60 hover:bg-zen-bg hover:text-zen-text font-light'
            }`}
          >
            <Activity size={18} strokeWidth={1.5} />
            dashboard
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`flex items-center gap-3 px-4 py-3 rounded-2xl transition-all duration-300 text-sm ${
              activeTab === 'settings'
                ? 'bg-zen-bg shadow-zen text-zen-text font-medium'
                : 'text-zen-text/60 hover:bg-zen-bg hover:text-zen-text font-light'
            }`}
          >
            <Settings size={18} strokeWidth={1.5} />
            setup & config
          </button>
        </nav>
        
        <div className="mt-auto pt-4 border-t border-zen-border/30">
          <div className="bg-zen-bg rounded-2xl p-4 shadow-sm">
            <div className="text-xs text-zen-text/50 lowercase tracking-widest mb-2 font-medium">status</div>
            <div className="flex items-center text-sm font-light">
              <div className={`w-2 h-2 rounded-full mr-2 ${health?.usingRealAPI ? 'bg-emerald-500 shadow-sm' : 'bg-amber-400 border border-amber-400'}`}></div>
              <span className={health?.usingRealAPI ? 'text-zen-text' : 'text-amber-600'}>
                {health?.usingRealAPI ? 'online & active' : 'setup required'}
              </span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col md:h-screen">
        {/* Top Header */}
        <header className="h-16 bg-zen-card px-6 md:px-8 flex items-center justify-between z-10 shrink-0">
          <h2 className="text-lg font-medium text-zen-text tracking-wide lowercase">
            {activeTab === 'dashboard' ? 'whatsapp overview' : 'configuration setup'}
          </h2>
          <div className="flex items-center space-x-4">
            <div className="hidden sm:flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
              <span className="text-xs font-light text-zen-text/60 lowercase tracking-widest">
                {health?.agentPresence || 'online'}
              </span>
            </div>
            <div className="w-8 h-8 rounded-full bg-zen-accent/10 text-zen-accent flex items-center justify-center font-medium text-xs">
              AU
            </div>
          </div>
        </header>

        <div className="p-6 md:p-8 flex-1 overflow-y-auto">

        {activeTab === 'dashboard' && (
          <div className="space-y-8 max-w-7xl mx-auto">
            {/* Quick Stats */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              <div className="bg-zen-card p-6 rounded-3xl shadow-sm flex flex-col items-start border border-zen-border/20 transition-all duration-300 hover:shadow-zen hover:scale-[1.02]">
                <span className="text-zen-text/50 text-[10px] lowercase tracking-[0.2em] mb-2 flex items-center gap-1 font-medium">
                  <Activity size={12} strokeWidth={2} /> backend
                </span>
                <span className="text-2xl font-light text-zen-text mt-1 lowercase">
                  online
                </span>
                <span className="text-[10px] text-zen-text/60 mt-3 flex items-center gap-1.5 font-light tracking-wide">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                  </span>
                  ready
                </span>
              </div>
              <div className="bg-zen-card p-6 rounded-3xl shadow-sm flex flex-col items-start border border-zen-border/20 transition-all duration-300 hover:shadow-zen hover:scale-[1.02]">
                <span className="text-zen-text/50 text-[10px] lowercase tracking-[0.2em] mb-2 flex items-center gap-1 font-medium">
                  <MessageCircle size={12} strokeWidth={2} /> api connection
                </span>
                <span className="text-2xl font-light text-zen-text mt-1 whitespace-nowrap lowercase">
                  {health?.usingRealAPI ? "connected" : "setup needed"}
                </span>
                <span className={`text-[10px] mt-3 font-light tracking-wide ${health?.usingRealAPI ? 'text-zen-text/60' : 'text-amber-500'}`}>
                  {health?.usingRealAPI ? 'webhook active' : 'missing tokens'}
                </span>
              </div>
              <div className="bg-zen-card p-6 rounded-3xl shadow-sm hidden md:flex flex-col items-start border border-zen-border/20 transition-all duration-300 hover:shadow-zen hover:scale-[1.02]">
                <span className="text-zen-text/50 text-[10px] lowercase tracking-[0.2em] mb-2 font-medium">volume</span>
                <span className="text-2xl font-light text-zen-text mt-1">{conversations.length || '--'}</span>
                <span className="text-[10px] text-zen-text/60 mt-3 font-light tracking-wide">{conversations.length ? 'total convos' : 'no stats yet'}</span>
              </div>
              <div className="bg-zen-card p-6 rounded-3xl shadow-sm hidden lg:flex flex-col items-start border border-zen-border/20 transition-all duration-300 hover:shadow-zen hover:scale-[1.02]">
                <span className="text-zen-text/50 text-[10px] lowercase tracking-[0.2em] mb-2 font-medium">speed</span>
                <span className="text-2xl font-light text-zen-text mt-1">~{health?.geminiLatency || 150}ms</span>
                <span className="text-[10px] text-zen-text/60 mt-3 font-light tracking-wide lowercase">gemini latency</span>
              </div>
            </div>

            {/* Instruction Card */}
            {!health?.usingRealAPI && (
              <div className="bg-amber-50 border border-amber-200 p-6 rounded-2xl flex flex-col gap-3">
                <h3 className="font-semibold text-amber-900 border-b border-amber-200 pb-2">Action Required</h3>
                <p className="text-sm text-amber-800">
                  Your WhatsApp bot needs configuration to connect to real users. Go to the "Setup & Config" tab for instructions on setting up environment variables.
                </p>
              </div>
            )}
            
            {/* Live Customer Flow / Conversations */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-[600px] 2xl:h-[700px]">
              {/* Conversation List */}
              <div className="lg:col-span-3 bg-zen-card rounded-3xl shadow-sm border border-zen-border/30 flex flex-col overflow-hidden h-full">
                <div className="p-4 border-b border-zen-border/30 flex flex-col gap-4 bg-zen-bg/50">
                  <div className="flex justify-between items-center px-1">
                    <h3 className="font-medium text-zen-text flex items-center gap-2 text-sm lowercase tracking-wider">
                      <User size={14} /> live customers
                    </h3>
                    <span className="text-[10px] font-medium bg-zen-accent/10 text-zen-accent px-2 py-0.5 rounded-full">{filteredConversations.length}</span>
                  </div>
                  
                  <div className="flex flex-col gap-3">
                    <div className="relative w-full">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zen-text/40 w-4 h-4" />
                      <input 
                        ref={searchInputRef}
                        type="text" 
                        placeholder="search..." 
                        className="w-full bg-zen-card border border-zen-border/40 rounded-2xl pl-9 pr-4 py-2 text-sm focus:outline-none focus:border-zen-border transition-colors font-light placeholder:text-zen-text/30 shadow-sm"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>
                    
                    <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide px-1">
                      <button 
                        onClick={() => setFilterMode('all')}
                        className={`whitespace-nowrap px-3 py-1.5 rounded-xl text-xs transition-colors font-medium lowercase ${filterMode === 'all' ? 'bg-zen-accent text-white shadow-sm' : 'bg-transparent text-zen-text/60 hover:text-zen-text'}`}
                      >
                        all
                      </button>
                      <button 
                        onClick={() => setFilterMode('active')}
                        className={`whitespace-nowrap px-3 py-1.5 rounded-xl text-xs transition-colors font-medium lowercase ${filterMode === 'active' ? 'bg-zen-accent text-white shadow-sm' : 'bg-transparent text-zen-text/60 hover:text-zen-text'}`}
                      >
                        bot active
                      </button>
                      <button 
                        onClick={() => setFilterMode('agent')}
                        className={`whitespace-nowrap px-3 py-1.5 rounded-xl text-xs transition-colors font-medium lowercase ${filterMode === 'agent' ? 'bg-zen-accent text-white shadow-sm' : 'bg-transparent text-zen-text/60 hover:text-zen-text'}`}
                      >
                        handed over
                      </button>
                    </div>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  {filteredConversations.length === 0 ? (
                    <div className="p-8 text-center flex flex-col items-center justify-center h-full text-zen-text/40">
                      <MessageCircle size={24} className="mb-4 opacity-20" strokeWidth={1.5} />
                      <p className="text-sm font-light lowercase">{conversations.length === 0 ? "waiting for messages..." : "no conversations found"}</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-zen-border/10">
                      {filteredConversations.map((convo) => {
                        const lastMsg = convo.messages[convo.messages.length - 1];
                        return (
                          <div 
                            key={convo.id} 
                            onClick={() => {
                              setSelectedConvo(convo);
                              if (convo.unreadCount) {
                                fetch(`/api/conversations/${convo.id}/read`, { method: 'POST' });
                                setConversations(prev => prev.map(c => c.id === convo.id ? { ...c, unreadCount: 0 } : c));
                              }
                            }}
                            className={`p-5 flex items-center transition-all duration-300 cursor-pointer ${selectedConvo?.id === convo.id ? 'bg-zen-bg/80 border-l-4 border-zen-accent' : 'border-l-4 border-transparent hover:bg-zen-bg/40'}`}
                          >
                            <div className="w-10 h-10 bg-zen-bg text-zen-text/60 rounded-full flex items-center justify-center relative mr-4 shrink-0 shadow-sm border border-zen-border/50">
                              <User size={16} strokeWidth={1.5} />
                              {convo.isAgentHandled ? (
                                <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-amber-500 border-2 border-zen-card rounded-full"></div>
                              ) : (
                                <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 border-2 border-zen-card rounded-full"></div>
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex justify-between items-baseline mb-1">
                                <span className="text-sm font-medium text-zen-text truncate block flex items-center gap-1">
                                  +{convo.id}
                                  {convo.isAgentHandled && <ShieldCheck size={12} className="text-amber-500 ml-1" />}
                                  {convo.priority === 'high' && <span className="w-2 h-2 rounded-full bg-red-400 ml-1 shadow-sm"></span>}
                                  {convo.priority === 'medium' && <span className="w-2 h-2 rounded-full bg-amber-400 ml-1 shadow-sm"></span>}
                                </span>
                                <div className="flex items-center gap-2">
                                  {convo.unreadCount ? <span className="flex items-center justify-center w-4 h-4 bg-zen-accent text-white rounded-full text-[9px] font-medium shadow-sm">{convo.unreadCount}</span> : null}
                                  <span className="text-[10px] text-zen-text/40 shrink-0 font-light">
                                    {new Date(convo.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                </div>
                              </div>
                              <p className={`text-xs truncate font-light ${convo.isTyping ? 'text-emerald-500' : (lastMsg.role === 'model' ? 'text-zen-text/50' : 'text-zen-text/70')}`}>
                                {convo.isTyping ? 'typing...' : (lastMsg.role === 'model' ? 'bot: ' + lastMsg.text : lastMsg.text)}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Conversation Detail */}
              <div className="lg:col-span-6 bg-zen-card rounded-3xl shadow-sm border border-zen-border/30 flex flex-col overflow-hidden h-full">
                {selectedConvo ? (
                  <>
                    <div className="p-5 border-b border-zen-border/30 flex justify-between items-center bg-zen-bg/50">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-zen-bg text-zen-text/60 rounded-full flex items-center justify-center relative shadow-sm border border-zen-border/50">
                          <User size={20} strokeWidth={1.5} />
                          {selectedConvo.isAgentHandled ? (
                            <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-amber-500 border-2 border-zen-card rounded-full"></div>
                          ) : (
                            <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-emerald-500 border-2 border-zen-card rounded-full"></div>
                          )}
                        </div>
                        <div>
                          <h3 className="font-medium text-zen-text text-base">+{selectedConvo.id}</h3>
                          {selectedConvo.isAgentHandled ? (
                            <span className="text-xs text-amber-600 font-light tracking-wide flex items-center gap-1.5 mt-0.5">
                              <ShieldCheck size={12} strokeWidth={1.5} /> handed over
                            </span>
                          ) : (
                            <span className="text-xs text-emerald-600 font-light tracking-wide flex items-center gap-1.5 mt-0.5">
                              <Activity size={12} strokeWidth={1.5} /> active
                            </span>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-3">
                        <button
                          onClick={handleExportChat}
                          className="flex items-center gap-2 px-4 py-2 bg-transparent text-zen-text/60 text-xs font-medium rounded-xl hover:bg-zen-bg hover:text-zen-text transition-all duration-300 lowercase"
                          title="Export Conversation History"
                        >
                          <Download size={14} strokeWidth={1.5} />
                          export
                        </button>
                        {!selectedConvo.isAgentHandled && (
                          <button
                            onClick={handleHandover}
                            disabled={isHandingOver}
                            className="flex items-center gap-2 px-4 py-2 bg-zen-accent/10 text-zen-accent text-xs font-medium rounded-xl hover:bg-zen-accent hover:text-white transition-all duration-300 disabled:opacity-50 lowercase"
                          >
                            <UserPlus size={14} strokeWidth={1.5} />
                            {isHandingOver ? 'handing over...' : 'handover'}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex-1 overflow-y-auto p-8 flex flex-col pb-8 scroll-smooth">
                      {selectedConvo.messages.map((msg, idx) => {
                         const prevMsg = idx > 0 ? selectedConvo.messages[idx - 1] : null;
                         const showDate = !prevMsg || new Date(msg.timestamp).toDateString() !== new Date(prevMsg.timestamp).toDateString();
                         const hideAvatar = prevMsg && prevMsg.role === msg.role && !showDate;
                         const marginTop = showDate ? 'mt-4' : (hideAvatar ? 'mt-1' : 'mt-6');

                         return (
                           <React.Fragment key={idx}>
                             {showDate && (
                               <div className="flex justify-center my-6">
                                 <span className="text-[10px] lowercase tracking-widest text-zen-text/40 font-medium px-4 py-1.5 bg-zen-bg rounded-full border border-zen-border/30">
                                   {new Date(msg.timestamp).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                                 </span>
                               </div>
                             )}
                             <div className={`flex max-w-[85%] ${msg.role === 'user' ? 'self-start' : 'self-end'} ${marginTop}`}>
                               {msg.role === 'user' && (
                                 <div className={`w-8 h-8 rounded-full bg-zen-bg text-zen-text/40 flex items-center justify-center shrink-0 mr-3 mt-1 shadow-sm border border-zen-border/30 transition-opacity ${hideAvatar ? 'opacity-0' : 'opacity-100'}`}>
                                   <User size={14} strokeWidth={1.5} />
                                 </div>
                               )}
                               <div className={`p-4 rounded-[20px] shadow-sm transform transition-all duration-300 hover:scale-[1.01] ${msg.role === 'user' ? 'bg-zen-bg text-zen-text border border-zen-border/20' : 'bg-zen-accent text-white'} ${hideAvatar ? (msg.role === 'user' ? 'rounded-tl-[20px] rounded-bl-[20px]' : 'rounded-tr-[20px] rounded-br-[20px]') : (msg.role === 'user' ? 'rounded-tl-[4px]' : 'rounded-tr-[4px]')}`}>
                             {msg.type && msg.type !== 'text' && (
                               <div className="flex items-center gap-2 mb-2 bg-black/5 rounded-lg p-2 italic text-xs w-full max-w-full">
                                  {msg.type === 'image' && <Camera size={14} className="shrink-0" />}
                                  {msg.type === 'audio' && <Mic size={14} className="shrink-0" />}
                                  {msg.type === 'video' && <Video size={14} className="shrink-0" />}
                                  {msg.type === 'document' && <FileText size={14} className="shrink-0" />}
                                  <span className="truncate">{msg.type} file attached</span>
                               </div>
                             )}
                             <p className="text-sm font-light break-words whitespace-pre-wrap leading-relaxed">{msg.text}</p>
                             <div className={`text-[10px] mt-2 flex justify-end gap-1.5 items-center font-light tracking-wider ${msg.role === 'user' ? 'text-zen-text/40' : 'text-white/70'}`}>
                               {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit'})}
                               {msg.role === 'model' && (
                                  <>
                                    {!msg.status && <Clock size={10} className="text-white/50" />}
                                    {msg.status === 'sent' && <Check size={12} className="text-white/80" />}
                                    {msg.status === 'delivered' && <CheckCheck size={12} className="text-white/80" />}
                                    {msg.status === 'read' && <CheckCheck size={12} className="text-emerald-300" />}
                                    {msg.status === 'failed' && (
                                      <div className="flex items-center gap-1.5">
                                        <div className="relative group cursor-help">
                                          <AlertCircle size={12} className="text-amber-300" />
                                          <div className="absolute bottom-full right-0 mb-2 w-48 p-3 bg-zen-text text-zen-bg text-xs rounded-xl shadow-zen opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none break-words whitespace-normal z-50 font-light">
                                            {msg.failureReason || "failed to send"}
                                            {/* CSS triangle for tooltip */}
                                            <div className="absolute top-full right-1.5 -mt-1 border-4 border-transparent border-t-zen-text line-height-0"></div>
                                          </div>
                                        </div>
                                        {msg.id && (
                                          <button 
                                            onClick={() => handleRetryMessage(msg.id!)}
                                            className="text-white/80 hover:text-white transition-colors lowercase text-[9px] font-medium tracking-widest ml-1 bg-white/20 px-2 py-0.5 rounded-full"
                                          >
                                            retry
                                          </button>
                                        )}
                                      </div>
                                    )}
                                  </>
                               )}
                             </div>
                           </div>
                           {msg.role === 'model' && (
                             <div className={`flex flex-col gap-1 items-center ml-3 mt-1 relative group transition-opacity ${hideAvatar ? 'opacity-0' : 'opacity-100'}`}>
                               <div className="w-8 h-8 rounded-full bg-zen-accent/10 border border-zen-accent/20 text-zen-accent flex items-center justify-center shrink-0 shadow-sm relative z-10 transition-transform duration-300 hover:scale-110">
                                 <Bot size={14} strokeWidth={1.5} />
                               </div>
                               {msg.id && (
                                  <div className={`flex bg-zen-card border border-zen-border/30 rounded-full shadow-zen overflow-hidden transition-all duration-300 mt-2 absolute top-full ${msg.feedback ? 'opacity-100 target' : 'opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 focus-within:opacity-100 focus-within:translate-y-0'}`}>
                                    <button 
                                      onClick={() => handleRateMessage(msg.id!, 'up')}
                                      className={`p-1.5 flex transition-colors ${msg.feedback === 'up' ? 'text-emerald-500 bg-emerald-50' : 'text-zen-text/40 hover:text-zen-text hover:bg-zen-bg'}`}
                                      title="good"
                                      aria-label="Rate response as good"
                                    >
                                       <ThumbsUp size={12} strokeWidth={1.5} className={msg.feedback === 'up' ? 'fill-emerald-500' : ''} />
                                    </button>
                                    <div className="w-px bg-zen-border/30"></div>
                                    <button 
                                      onClick={() => handleRateMessage(msg.id!, 'down')}
                                      className={`p-1.5 flex transition-colors ${msg.feedback === 'down' ? 'text-amber-500 bg-amber-50' : 'text-zen-text/40 hover:text-zen-text hover:bg-zen-bg'}`}
                                      title="poor"
                                      aria-label="Rate response as poor"
                                    >
                                       <ThumbsDown size={12} strokeWidth={1.5} className={msg.feedback === 'down' ? 'fill-amber-500' : ''} />
                                    </button>
                                  </div>
                               )}
                             </div>
                           )}
                         </div>
                           </React.Fragment>
                         );
                      })}
                      
                       {selectedConvo.isTyping && (
                         <div className="flex max-w-[85%] self-end mt-6">
                           <div className="py-3 px-5 rounded-[20px] bg-zen-accent/5 text-zen-text rounded-tr-sm flex items-center gap-2 h-[42px] border border-zen-accent/10 shadow-sm">
                             <span className="w-1.5 h-1.5 bg-zen-accent/60 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                             <span className="w-1.5 h-1.5 bg-zen-accent/60 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                             <span className="w-1.5 h-1.5 bg-zen-accent/60 rounded-full animate-bounce"></span>
                           </div>
                           <div className="w-8 h-8 rounded-full bg-zen-accent/10 text-zen-accent flex items-center justify-center shrink-0 ml-3 mt-1 shadow-sm border border-zen-accent/20">
                             <Bot size={14} className="animate-pulse" strokeWidth={1.5} />
                           </div>
                         </div>
                      )}
                      
                      {/* Suggest Quick Replies */}
                      {selectedConvo.messages.length > 0 && !selectedConvo.isTyping && quickReplies.length > 0 && (
                        <div className="pt-2 flex flex-wrap gap-2 justify-end self-end max-w-[85%]">
                           {quickReplies.map((qr, i) => (
                             <button key={i} onClick={() => handleQuickReply(qr)} disabled={isSendingReply} className="px-4 py-2 bg-transparent border border-zen-accent/20 text-zen-accent hover:bg-zen-accent/5 text-xs font-light rounded-2xl shadow-sm transition-all duration-300 disabled:opacity-50 text-left line-clamp-1 max-w-[200px]" title={qr}>
                               {qr}
                             </button>
                           ))}
                        </div>
                      )}

                      {/* Invisible anchor to scroll to */}
                      <div ref={messagesEndRef} />
                    </div>

                    {/* Agent Manual Reply Input */}
                      {selectedConvo.isAgentHandled && (
                      <div className="p-4 border-t border-zen-border/30 bg-zen-bg/30 flex items-end gap-3 shrink-0">
                         <textarea
                            value={manualReplyText}
                            onChange={(e) => setManualReplyText(e.target.value)}
                            onKeyDown={handleManualKeyDown}
                            disabled={isSendingReply}
                            placeholder="type reply... (cmd/ctrl + enter to send)"
                            className="flex-1 max-h-32 min-h-[44px] bg-zen-card border border-zen-border/50 rounded-2xl py-3 px-5 text-sm focus:outline-none focus:border-zen-border transition-colors resize-none text-zen-text block font-light placeholder:text-zen-text/30 shadow-sm"
                            rows={1}
                         />
                         <button 
                            onClick={handleManualSubmit}
                            disabled={isSendingReply || !manualReplyText.trim()}
                            className="w-11 h-11 bg-zen-accent text-white rounded-full flex items-center justify-center shrink-0 hover:bg-zen-accent-hover transition-all duration-300 shadow-zen disabled:opacity-50 disabled:hover:bg-zen-accent relative overflow-hidden group"
                         >
                            <Send size={18} strokeWidth={1.5} className={`relative z-10 ${isSendingReply ? 'animate-pulse translate-x-1 -translate-y-1' : 'group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform duration-300'}`} />
                            <div className="absolute inset-0 bg-white/20 scale-0 group-active:scale-100 rounded-full transition-transform duration-500 opacity-0 group-active:opacity-100"></div>
                         </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-zen-text/40">
                    <MessageCircle size={32} className="mb-4 opacity-20" strokeWidth={1.5} />
                    <h3 className="text-sm font-medium text-zen-text/60 mb-1 lowercase tracking-wide">select conversation</h3>
                    <p className="text-xs max-w-[200px] text-center font-light">view chat history and context</p>
                  </div>
                )}
              </div>

              {/* Customer Profile (Right Pane) */}
              <div className="lg:col-span-3 bg-zen-card rounded-3xl shadow-sm border border-zen-border/30 flex flex-col overflow-hidden h-full">
                {selectedConvo ? (
                  <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-8">
                    <div className="flex flex-col items-center gap-4 text-center pt-4">
                      <div className="w-24 h-24 bg-zen-bg text-zen-text/40 rounded-full flex items-center justify-center relative shadow-sm border border-zen-border/50">
                        <User size={36} strokeWidth={1} />
                      </div>
                      <div>
                        <h3 className="font-medium text-zen-text text-xl tracking-wide">
                          {selectedConvo.customerName || `+${selectedConvo.id}`}
                        </h3>
                        <p className="text-[10px] text-zen-text/50 mt-1 font-light lowercase tracking-widest">customer profile</p>
                      </div>
                    </div>
                    
                    <div className="h-px bg-zen-border/20 w-full" />

                    <div className="flex flex-col gap-6">
                      <div className="flex flex-col gap-3">
                        <span className="text-[10px] font-medium text-zen-text/40 lowercase tracking-[0.2em]">tags</span>
                        <div className="flex flex-wrap gap-2 items-center">
                          {selectedConvo.tags?.map(tag => (
                            <span key={tag} className="px-3 py-1 bg-zen-bg text-zen-text rounded-full text-xs font-light border border-zen-border/30 flex items-center gap-2 group transition-colors hover:border-zen-border">
                              {tag}
                              <button 
                                onClick={async () => {
                                  const newTags = selectedConvo.tags?.filter(t => t !== tag) || [];
                                  const res = await fetch(`/api/conversations/${selectedConvo.id}/crm`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ tags: newTags }) });
                                  const data = await res.json();
                                  if(data.success) setSelectedConvo(data.convo);
                                }}
                                className="text-zen-text/30 group-hover:text-amber-500 transition-colors"
                              >×</button>
                            </span>
                          ))}
                          <button 
                            onClick={async () => {
                              const tag = prompt("Enter new tag:");
                              if (!tag) return;
                              const newTags = [...(selectedConvo.tags || []), tag];
                              const res = await fetch(`/api/conversations/${selectedConvo.id}/crm`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ tags: newTags }) });
                              const data = await res.json();
                              if(data.success) setSelectedConvo(data.convo);
                            }}
                            className="px-3 py-1 flex items-center justify-center bg-transparent text-zen-text/40 hover:text-zen-text rounded-full text-xs font-light border border-dashed border-zen-border/50 transition-colors lowercase"
                          >
                            + add
                          </button>
                        </div>
                      </div>

                      <div className="flex flex-col gap-3">
                        <span className="text-[10px] font-medium text-zen-text/40 lowercase tracking-[0.2em]">crm fields</span>
                        <div className="bg-zen-bg border border-zen-border/30 rounded-[20px] p-4 flex flex-col gap-4 shadow-sm">
                          <div className="flex justify-between items-center group cursor-pointer" onClick={() => {
                            const val = prompt("Enter email:", selectedConvo.crmFields?.email || "");
                            if (val !== null) fetch(`/api/conversations/${selectedConvo.id}/crm`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ crmFields: { email: val } }) }).then(r => r.json()).then(d => d.success && setSelectedConvo(d.convo));
                          }}>
                            <span className="text-xs text-zen-text/50 font-light lowercase">email</span>
                            <span className={`text-xs font-light ${selectedConvo.crmFields?.email ? 'text-zen-text' : 'text-zen-text/30'}`}>{selectedConvo.crmFields?.email || '--'}</span>
                          </div>
                          <div className="flex justify-between items-center group cursor-pointer" onClick={() => {
                            const val = prompt("Enter order ID:", selectedConvo.crmFields?.orderId || "");
                            if (val !== null) fetch(`/api/conversations/${selectedConvo.id}/crm`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ crmFields: { orderId: val } }) }).then(r => r.json()).then(d => d.success && setSelectedConvo(d.convo));
                          }}>
                            <span className="text-xs text-zen-text/50 font-light lowercase">order no.</span>
                            <span className={`text-xs font-light tracking-widest ${selectedConvo.crmFields?.orderId ? 'text-zen-text' : 'text-zen-text/30'}`}>{selectedConvo.crmFields?.orderId || '--'}</span>
                          </div>
                          <div className="flex justify-between items-center group cursor-pointer" onClick={() => {
                            const val = prompt("Enter name:", selectedConvo.customerName || "");
                            if (val !== null) fetch(`/api/conversations/${selectedConvo.id}/crm`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ customerName: val }) }).then(r => r.json()).then(d => d.success && setSelectedConvo(d.convo));
                          }}>
                            <span className="text-xs text-zen-text/50 font-light lowercase">name</span>
                            <span className={`text-xs font-light ${selectedConvo.customerName ? 'text-zen-text' : 'text-zen-text/30'}`}>{selectedConvo.customerName || '--'}</span>
                          </div>
                          <div className="flex justify-between items-center group cursor-pointer" onClick={async () => {
                            const val = prompt("Enter priority (low, medium, high):", selectedConvo.priority || "");
                            if (val && ['low', 'medium', 'high'].includes(val.toLowerCase())) {
                               fetch(`/api/conversations/${selectedConvo.id}/crm`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ priority: val.toLowerCase() }) }).then(r => r.json()).then(d => d.success && setSelectedConvo(d.convo));
                            } else if (val) {
                               alert("Invalid priority. Please enter low, medium, or high.");
                            } else if (val === "") {
                               fetch(`/api/conversations/${selectedConvo.id}/crm`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ priority: null }) }).then(r => r.json()).then(d => d.success && setSelectedConvo(d.convo));
                            }
                          }}>
                            <span className="text-xs text-zen-text/50 font-light lowercase">priority</span>
                            <div className="flex items-center gap-1.5">
                              {selectedConvo.priority === 'high' && <span className="w-2 h-2 rounded-full bg-red-400 shadow-sm"></span>}
                              {selectedConvo.priority === 'medium' && <span className="w-2 h-2 rounded-full bg-amber-400 shadow-sm"></span>}
                              {selectedConvo.priority === 'low' && <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-sm"></span>}
                              <span className={`text-xs font-light ${selectedConvo.priority ? 'text-zen-text capitalize' : 'text-zen-text/30'}`}>{selectedConvo.priority || '--'}</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-col gap-3">
                        <span className="text-[10px] font-medium text-zen-text/40 lowercase tracking-[0.2em] flex justify-between">
                          notes
                        </span>
                        <textarea 
                          value={selectedConvo.notes || ''}
                          onChange={(e) => setSelectedConvo({ ...selectedConvo, notes: e.target.value })}
                          onBlur={async (e) => {
                            const res = await fetch(`/api/conversations/${selectedConvo.id}/crm`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ notes: e.target.value }) });
                            const data = await res.json();
                            if(data.success) setSelectedConvo(data.convo);
                          }}
                          className="w-full bg-zen-bg border border-zen-border/30 rounded-[20px] p-4 text-sm focus:outline-none focus:border-zen-border min-h-[120px] resize-y text-zen-text font-light shadow-sm transition-colors placeholder:text-zen-text/20" 
                          placeholder="add notes..."
                        ></textarea>
                      </div>

                      <div className="flex flex-col gap-3">
                        <span className="text-[10px] font-medium text-zen-text/40 lowercase tracking-[0.2em] flex justify-between">
                          activity log
                        </span>
                        <div className="border-l-2 border-zen-border/20 ml-2 pl-4 flex flex-col gap-5 mt-2">
                          <div className="relative">
                            <div className="absolute -left-[21px] top-1.5 w-2.5 h-2.5 rounded-full bg-zen-border/50"></div>
                            <span className="text-[10px] text-zen-text/40 block font-light tracking-wide uppercase">
                              {new Date(selectedConvo.messages[0]?.timestamp || selectedConvo.updatedAt).toLocaleDateString()}
                            </span>
                            <p className="text-xs text-zen-text font-light mt-0.5">Conversation started</p>
                          </div>
                          {selectedConvo.isAgentHandled ? (
                            <div className="relative">
                              <div className="absolute -left-[21px] top-1.5 w-2.5 h-2.5 rounded-full bg-amber-400 border-[3px] border-zen-card shadow-sm"></div>
                              <span className="text-[10px] text-zen-text/40 block font-light tracking-wide uppercase">Current</span>
                              <p className="text-xs text-zen-text font-light mt-0.5">Handed over to agent</p>
                            </div>
                          ) : (
                            <div className="relative">
                              <div className="absolute -left-[21px] top-1.5 w-2.5 h-2.5 rounded-full bg-emerald-500 border-[3px] border-zen-card shadow-sm"></div>
                              <span className="text-[10px] text-zen-text/40 block font-light tracking-wide uppercase">Current</span>
                              <p className="text-xs text-zen-text font-light mt-0.5">Automated AI response active</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-zen-text/40 p-6">
                    <User size={32} className="mb-4 opacity-20" strokeWidth={1} />
                    <h3 className="text-sm font-medium text-zen-text/60 mb-1 text-center lowercase tracking-wide">profile</h3>
                    <p className="text-xs text-center font-light">select conversation to view context.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="space-y-8 max-w-4xl mx-auto">
            {/* Bot Behavior Settings */}
            <div className="bg-zen-card rounded-3xl p-8 border border-zen-border/20 shadow-sm">
              <h3 className="text-xl font-medium mb-3 flex items-center text-zen-text tracking-wide lowercase">
                <Settings className="w-5 h-5 mr-3 text-zen-accent" strokeWidth={1.5} />
                system prompt
              </h3>
              <p className="text-sm text-zen-text/60 mb-6 font-light">
                define persona, knowledge, and bounds for the ai agent.
              </p>
              <textarea 
                value={botPrompt}
                onChange={(e) => setBotPrompt(e.target.value)}
                rows={8}
                className="w-full bg-zen-bg text-zen-text rounded-[20px] p-5 text-sm focus:outline-none focus:border-zen-border font-light shadow-sm border border-zen-border/30 placeholder:text-zen-text/30 resize-y transition-colors"
                placeholder="you are a helpful agent..."
              />
              <div className="mt-8 border-t border-zen-border/20 pt-8">
                <h3 className="text-xl font-medium mb-3 flex items-center text-zen-text tracking-wide lowercase">
                   <MessageCircle className="w-5 h-5 mr-3 text-zen-accent" strokeWidth={1.5} />
                   agent quick replies
                </h3>
                <p className="text-sm text-zen-text/60 mb-6 font-light">
                   manage canned responses available when you take over a conversation.
                </p>
                <div className="space-y-3">
                  {quickReplies.map((qr, i) => (
                    <div key={i} className="flex gap-3">
                      <input 
                        type="text" 
                        value={qr} 
                        onChange={(e) => {
                          const newReplies = [...quickReplies];
                          newReplies[i] = e.target.value;
                          setQuickReplies(newReplies);
                        }} 
                        className="flex-1 bg-zen-bg border border-zen-border/30 rounded-2xl py-2.5 px-4 text-sm focus:outline-none focus:border-zen-border font-light"
                      />
                      <button 
                        onClick={() => setQuickReplies(quickReplies.filter((_, idx) => idx !== i))}
                        className="w-10 h-10 bg-red-50 text-red-500 rounded-full flex items-center justify-center shrink-0 hover:bg-red-100 transition-colors"
                      >
                         ×
                      </button>
                    </div>
                  ))}
                  <button 
                    onClick={() => setQuickReplies([...quickReplies, ""])}
                    className="flex justify-center items-center w-full bg-zen-bg border border-dashed border-zen-border/50 text-zen-text/40 hover:text-zen-text py-3 rounded-2xl transition-colors font-light text-sm mt-4 lowercase"
                  >
                    + add quick reply
                  </button>
                </div>
              </div>

              <div className="mt-6 flex justify-end">
                <button 
                  onClick={handleSavePrompt}
                  disabled={savingPrompt}
                  className="bg-zen-accent text-white hover:bg-zen-accent-hover font-medium py-3 px-8 rounded-full text-sm transition-all duration-300 hover:scale-[1.02] disabled:opacity-50 shadow-sm lowercase tracking-wider"
                >
                  {savingPrompt ? 'saving...' : 'update config'}
                </button>
              </div>
            </div>

            {/* Env Vars / Setup Config */}
            <div className="bg-zen-card border border-zen-border/30 shadow-sm rounded-3xl p-8">
              <h3 className="text-xl font-medium border-b border-zen-border/20 pb-4 text-zen-text tracking-wide lowercase">required secrets</h3>
              <p className="text-sm text-zen-text/60 mt-4 font-light">
                configure these to connect your real whatsapp business api.
              </p>
            
            <div className="space-y-6 mt-6">
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-medium text-zen-text/40 tracking-[0.2em] uppercase">GEMINI_API_KEY</label>
                <div className="font-mono text-xs bg-zen-bg border border-zen-border/30 p-4 rounded-[20px] text-zen-text/70 shadow-sm">Configured in backend environment variables (.env file)</div>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-medium text-zen-text/40 tracking-[0.2em] uppercase">WHATSAPP_TOKEN</label>
                <input 
                  type="text" 
                  value={whatsappToken} 
                  onChange={(e) => setWhatsappToken(e.target.value)}
                  placeholder="Your permanent WhatsApp Cloud API system user token"
                  className="font-mono text-xs bg-zen-bg border border-zen-border/30 p-4 rounded-[20px] text-zen-text shadow-sm focus:outline-none focus:border-zen-border transition-colors" 
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-medium text-zen-text/40 tracking-[0.2em] uppercase">WHATSAPP_PHONE_NUMBER_ID</label>
                <input 
                  type="text" 
                  value={whatsappPhoneNumberId} 
                  onChange={(e) => setWhatsappPhoneNumberId(e.target.value)}
                  placeholder="The specific ID of the registered WhatsApp number"
                  className="font-mono text-xs bg-zen-bg border border-zen-border/30 p-4 rounded-[20px] text-zen-text shadow-sm focus:outline-none focus:border-zen-border transition-colors" 
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-medium text-zen-text/40 tracking-[0.2em] uppercase">WEBHOOK_VERIFY_TOKEN</label>
                <input 
                  type="text" 
                  value={webhookVerifyToken} 
                  onChange={(e) => setWebhookVerifyToken(e.target.value)}
                  placeholder='A custom secret string (e.g. "my_secret_bot_123")'
                  className="font-mono text-xs bg-zen-bg border border-zen-border/30 p-4 rounded-[20px] text-zen-text shadow-sm focus:outline-none focus:border-zen-border transition-colors" 
                />
              </div>
              <div className="mt-6 flex justify-end">
                <button 
                  onClick={handleSavePrompt}
                  disabled={savingPrompt}
                  className="bg-zen-accent text-white hover:bg-zen-accent-hover font-medium py-3 px-8 rounded-full text-sm transition-all duration-300 hover:scale-[1.02] disabled:opacity-50 shadow-sm lowercase tracking-wider"
                >
                  {savingPrompt ? 'saving...' : 'save secrets'}
                </button>
              </div>
            </div>

            <h3 className="text-xl font-medium border-b border-zen-border/20 pb-4 text-zen-text tracking-wide lowercase mt-10">webhook configuration</h3>
            <p className="text-sm text-zen-text/60 mt-4 font-light">
              use the following details in your meta developer portal:
            </p>

            <div className="bg-zen-bg p-6 rounded-[20px] border border-zen-border/30 mt-6 flex flex-col gap-6 shadow-sm">
              <div>
                <span className="text-[10px] font-medium text-zen-text/40 uppercase tracking-[0.2em]">Callback URL</span>
                <p className="font-mono text-sm font-light text-zen-text break-all mt-1">{window.location.origin}/api/webhook</p>
              </div>
              <div>
                <span className="text-[10px] font-medium text-zen-text/40 uppercase tracking-[0.2em]">Verify Token</span>
                <p className="font-mono text-sm text-zen-text/60 font-light mt-1">{webhookVerifyToken || '(Not configured yet)'}</p>
              </div>
              <div>
                <span className="text-[10px] font-medium text-zen-text/40 uppercase tracking-[0.2em]">Subscriptions</span>
                <p className="text-sm text-zen-text/60 font-light mt-1">Subscribe to the <strong className="font-medium">messages</strong> webhook field.</p>
              </div>
            </div>
          </div>
        </div>
        )}
        </div>
      </main>
    </div>
  );
}
