import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import admin from 'firebase-admin';
import fs from 'fs';

// Initialize Firebase Admin
let db: admin.firestore.Firestore | null = null;
try {
  let appletConfigText = fs.readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf-8');
  let appletConfig = JSON.parse(appletConfigText);
  
  let adminConfig: admin.AppOptions = {
    projectId: appletConfig.projectId
  };
  
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    adminConfig.credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY));
  }

  if (!admin.apps.length) {
    admin.initializeApp(adminConfig);
  }
  db = admin.firestore();
  if (appletConfig.firestoreDatabaseId && appletConfig.firestoreDatabaseId !== '(default)') {
     db = admin.firestore(admin.app());
     db.settings({ databaseId: appletConfig.firestoreDatabaseId });
  }
} catch (e) {
  console.log('Firebase Applet Config not found, running locally without persistence if needed.');
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware to parse JSON bodies
  app.use(express.json());

  let whatsappToken = process.env.WHATSAPP_TOKEN || '';
  let whatsappPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  let webhookVerifyToken = process.env.WEBHOOK_VERIFY_TOKEN || '';
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  let ai: GoogleGenAI | null = null;
  if (GEMINI_API_KEY) {
    ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  }

  // Load config from Firestore if available
  let botPrompt = `You are a helpful customer service and sales representative for our business on WhatsApp.\nKeep your answers concise, professional, friendly, and helpful.`;
  let quickReplies = [
    "I'm transferring you to a human agent now.",
    "Here is the pricing link: https://example.com/pricing",
    "Can I help you with anything else?",
    "Thank you for reaching out!"
  ];

  if (db) {
    try {
      const configDoc = await db.collection('config').doc('bot').get();
      if (configDoc.exists) {
        const data = configDoc.data()!;
        botPrompt = data.botPrompt || botPrompt;
        quickReplies = data.quickReplies || quickReplies;
        whatsappToken = data.whatsappToken || whatsappToken;
        whatsappPhoneNumberId = data.whatsappPhoneNumberId || whatsappPhoneNumberId;
        webhookVerifyToken = data.webhookVerifyToken || webhookVerifyToken;
      } else {
        await db.collection('config').doc('bot').set({
          botPrompt, quickReplies, whatsappToken, whatsappPhoneNumberId, webhookVerifyToken, ownerId: 'admin@nusalexia.co.id'
        });
      }
    } catch (error) {
      console.warn("Failed to read/write from Firestore during startup. Make sure you have set the FIREBASE_SERVICE_ACCOUNT environment variable if needed.", error);
    }
  }

  // In-memory conversation storage
  interface ChatMessage {
    id?: string;
    role: 'user' | 'model';
    text: string;
    timestamp: number;
    agentHandled: boolean;
    status?: 'sent' | 'delivered' | 'read' | 'failed';
    failureReason?: string;
    feedback?: 'up' | 'down';
    type?: 'text' | 'image' | 'audio' | 'document' | 'video' | 'other';
  }

  interface Conversation {
    id: string; // Phone number
    messages: ChatMessage[];
    updatedAt: number;
    isTyping?: boolean;
    isAgentHandled?: boolean;
    customerName?: string;
    tags?: string[];
    notes?: string;
    priority?: 'low' | 'medium' | 'high';
    unreadCount?: number;
    crmFields?: {
      email?: string;
      orderId?: string;
      ltv?: number;
    };
  }

  const conversations = new Map<string, Conversation>();

  // --- API Routes ---

  // Health check endpoint
  let lastGeminiLatency = Math.floor(Math.random() * 50) + 80;
  app.get('/api/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      usingRealAPI: !!whatsappToken,
      agentPresence: 'online',
      geminiLatency: lastGeminiLatency
    });
  });

  // Get active conversations
  app.get('/api/conversations', (req, res) => {
    const list = Array.from(conversations.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    res.json(list);
  });

  // Handover conversation to human agent
  app.post('/api/conversations/:id/handover', async (req, res) => {
    const { id } = req.params;
    const convo = conversations.get(id);
    if (!convo) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    convo.isAgentHandled = true;
    convo.updatedAt = Date.now();
    
    // Optionally alert the user that they are being handed over
    if (whatsappToken && whatsappPhoneNumberId) {
      try {
        const replyText = "You are being transferred to a human agent. Please hold on, someone will be with you shortly.";
        const fetchRes = await fetch(
          `https://graph.facebook.com/v17.0/${whatsappPhoneNumberId}/messages`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${whatsappToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: id,
              text: { body: replyText },
            }),
          }
        );
        const fetchData = await fetchRes.json();
        const msgId = fetchData.messages?.[0]?.id;
        convo.messages.push({ id: msgId, role: 'model', text: replyText, timestamp: Date.now(), agentHandled: true, status: 'sent' });
      } catch (error) {
         console.error("Error sending handover message:", error);
      }
    }

    res.json({ success: true, convo });
  });

  // Send a manual message from dashboard
  app.post('/api/conversations/:id/send', async (req, res) => {
    const { id } = req.params;
    const { text } = req.body;
    const convo = conversations.get(id);
    
    if (!convo) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    if (whatsappToken && whatsappPhoneNumberId) {
      try {
        const fetchRes = await fetch(
          `https://graph.facebook.com/v17.0/${whatsappPhoneNumberId}/messages`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${whatsappToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: id,
              text: { body: text },
            }),
          }
        );
        const fetchData = await fetchRes.json();
        const msgId = fetchData.messages?.[0]?.id;
        convo.messages.push({ id: msgId, role: 'model', text: text, timestamp: Date.now(), agentHandled: !!convo.isAgentHandled, status: 'sent' });
        convo.updatedAt = Date.now();
      } catch (error) {
         console.error("Error sending manual message:", error);
         return res.status(500).json({ error: 'Failed to send message' });
      }
    } else {
        // Fallback for dev mode without real API
        convo.messages.push({ id: Date.now().toString() + Math.random().toString(36).substr(2, 9), role: 'model', text: text, timestamp: Date.now(), agentHandled: !!convo.isAgentHandled, status: 'sent' });
        convo.updatedAt = Date.now();
    }

    res.json({ success: true, convo });
  });

  // Put CRM data for a specific conversation
  app.put('/api/conversations/:id/crm', (req, res) => {
    const id = req.params.id;
    const convo = conversations.get(id);
    if (!convo) return res.status(404).json({ error: 'Not found' });
    
    if (req.body.customerName !== undefined) convo.customerName = req.body.customerName;
    if (req.body.notes !== undefined) convo.notes = req.body.notes;
    if (req.body.tags !== undefined) convo.tags = req.body.tags;
    if (req.body.priority !== undefined) convo.priority = req.body.priority;
    if (req.body.crmFields !== undefined) convo.crmFields = { ...convo.crmFields, ...req.body.crmFields };
    
    res.json({ success: true, convo });
  });

  // Get current bot prompt
  app.get('/api/config', (req, res) => {
    res.json({ botPrompt, quickReplies, whatsappToken, whatsappPhoneNumberId, webhookVerifyToken });
  });

  // Update config
  app.post('/api/config', (req, res) => {
    const { prompt, replies, token, phoneId, verifyToken } = req.body;
    if (typeof prompt === 'string') botPrompt = prompt;
    if (Array.isArray(replies)) quickReplies = replies.map(String);
    if (typeof token === 'string') whatsappToken = token;
    if (typeof phoneId === 'string') whatsappPhoneNumberId = phoneId;
    if (typeof verifyToken === 'string') webhookVerifyToken = verifyToken;
    res.json({ success: true, botPrompt, quickReplies, whatsappToken, whatsappPhoneNumberId, webhookVerifyToken });
  });
  app.post('/api/conversations/:convoId/messages/:msgId/rate', (req, res) => {
    const { convoId, msgId } = req.params;
    const { rating } = req.body;
    
    const convo = conversations.get(convoId);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
    
    const msg = convo.messages.find(m => m.id === msgId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    
    msg.feedback = rating;
    res.json({ success: true, convo });
  });

  // Retry a failed message
  app.post('/api/conversations/:convoId/messages/:msgId/retry', async (req, res) => {
    const { convoId, msgId } = req.params;
    const convo = conversations.get(convoId);
    
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
    
    const msgIndex = convo.messages.findIndex(m => m.id === msgId);
    if (msgIndex === -1) return res.status(404).json({ error: 'Message not found' });
    
    const msg = convo.messages[msgIndex];
    if (msg.status !== 'failed') return res.status(400).json({ error: 'Message is not in failed state' });
    
    if (whatsappToken && whatsappPhoneNumberId) {
      try {
        const fetchRes = await fetch(
          `https://graph.facebook.com/v17.0/${whatsappPhoneNumberId}/messages`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${whatsappToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: convoId,
              text: { body: msg.text },
            }),
          }
        );
        const fetchData = await fetchRes.json();
        
        if (fetchData.error) {
           msg.failureReason = fetchData.error.message;
           return res.status(500).json({ error: 'Retry failed', convo, failureReason: fetchData.error.message });
        }
        
        const newMsgId = fetchData.messages?.[0]?.id;
        msg.id = newMsgId; 
        msg.status = 'sent';
        msg.failureReason = undefined;
        convo.updatedAt = Date.now();
      } catch (error: any) {
         msg.failureReason = error.message || 'Unknown network error during retry';
         console.error("Error retrying message:", error);
         return res.status(500).json({ error: 'Failed to resend message', convo });
      }
    } else {
        msg.status = 'sent';
        msg.failureReason = undefined;
        msg.id = Date.now().toString(); 
        convo.updatedAt = Date.now();
    }

    res.json({ success: true, convo });
  });

  // WhatsApp Webhook Verification
  app.get('/api/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
      if (mode === 'subscribe' && token === webhookVerifyToken) {
        console.log('WEBHOOK_VERIFIED');
        res.status(200).send(challenge);
      } else {
        res.sendStatus(403);
      }
    } else {
      res.sendStatus(400);
    }
  });

  // Mark conversation as read
  app.post('/api/conversations/:id/read', (req, res) => {
    const convo = conversations.get(req.params.id);
    if (convo) convo.unreadCount = 0;
    res.json({ success: true });
  });

  // Receive WhatsApp Messages
  app.post('/api/webhook', async (req, res) => {
    const body = req.body;

    if (body.object) {
      if (body.entry && body.entry[0].changes && body.entry[0].changes[0]) {
        const val = body.entry[0].changes[0].value;
        
        // Handle message status updates
        if (val.statuses && val.statuses.length > 0) {
            const statusObj = val.statuses[0];
            const recipient_id = statusObj.recipient_id;
            const status = statusObj.status; // sent, delivered, read, failed
            const msg_id = statusObj.id;
            let failureReason = undefined;
            if (status === 'failed' && statusObj.errors && statusObj.errors.length > 0) {
                const errResult = statusObj.errors[0];
                failureReason = (errResult.error_data && errResult.error_data.details) || errResult.message || errResult.title || 'Unknown failure reason';
            }
            
            let convo = conversations.get(recipient_id);
            if (convo) {
                // Find message by ID or fallback to last model message
                const msg = convo.messages.find(m => m.id === msg_id) || [...convo.messages].reverse().find(m => m.role === 'model');
                if (msg) {
                    msg.status = status;
                    if (failureReason) msg.failureReason = failureReason;
                }
                convo.updatedAt = Date.now();
            }
            return res.sendStatus(200);
        }
        
        if (val.messages && val.messages[0]) {
          const phone_number_id = val.metadata.phone_number_id;
          const from = val.messages[0].from; 
          const msgType = val.messages[0].type || 'text';
          let msg_body = '';
          
          if (msgType === 'text') {
             msg_body = val.messages[0].text?.body || '';
          } else if (msgType === 'image') {
             msg_body = '📷 Image received';
          } else if (msgType === 'audio') {
             msg_body = '🎵 Voice message received';
          } else if (msgType === 'document') {
             msg_body = '📄 Document received';
          } else if (msgType === 'video') {
             msg_body = '🎥 Video received';
          } else {
             msg_body = `[${msgType} message]`;
          }

          console.log(`Received message from ${from}: ${msg_body}`);

          let convo = conversations.get(from);
          if (!convo) {
            convo = { id: from, messages: [], updatedAt: Date.now(), isTyping: false };
            conversations.set(from, convo);
          }

          if (msg_body) {
            convo.messages.push({ 
              id: val.messages[0].id || Date.now().toString() + Math.random().toString(36).substring(2, 9), 
              role: 'user', 
              text: msg_body, 
              timestamp: Date.now(), 
              agentHandled: false,
              type: msgType as any
            });
            convo.updatedAt = Date.now();
            convo.unreadCount = (convo.unreadCount || 0) + 1;
            
            if (!convo.isAgentHandled) {
              convo.isTyping = true;
            }
          }

          if (msg_body && ai && whatsappToken && !convo.isAgentHandled) {
            try {
              const fetchStart = Date.now();
              // Ask Gemini to generate a response, maintaining context
              const contents = convo.messages.map(m => ({
                role: m.role,
                parts: [{ text: m.text }]
              }));

              const response = await ai.models.generateContent({
                model: "gemini-3-flash-preview",
                contents: contents,
                config: {
                  systemInstruction: botPrompt
                }
              });

              const replyText = response.text || "Sorry, I am unable to process your request at the moment.";
              
              // Send reply via WhatsApp API
              const fetchRes = await fetch(
                `https://graph.facebook.com/v17.0/${whatsappPhoneNumberId}/messages`,
                {
                  method: "POST",
                  headers: {
                    "Authorization": `Bearer ${whatsappToken}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    messaging_product: "whatsapp",
                    to: from,
                    text: { body: replyText },
                  }),
                }
              );
              const fetchData = await fetchRes.json();
              const msgId = fetchData.messages?.[0]?.id;

              console.log(`Sent reply to ${from}: ${replyText}`);
              
              convo.messages[convo.messages.length - 1].agentHandled = true; // Mark user message handled
              convo.messages.push({ id: msgId, role: 'model', text: replyText, timestamp: Date.now(), agentHandled: true, status: 'sent' });
              convo.updatedAt = Date.now();
              convo.isTyping = false;
              lastGeminiLatency = Date.now() - fetchStart;

            } catch (error) {
              console.error("Error processing message:", error);
              convo.isTyping = false;
            }
          } else if (msg_body && (!ai || !whatsappToken)) {
             convo.isTyping = false;
          }
        }
      }
      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  });

  // --- Vite Middleware ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);
