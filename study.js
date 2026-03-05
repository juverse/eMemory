// study.js – Anki SRS study session with LLM voice conversation

const DB_NAME = 'eMemory';
const DB_VERSION = 2;
const STORE_DECKS = 'decks';
const STORE_PROGRESS = 'progress';

const STORAGE_KEY_LLM_API = 'ememory_llm_api_key';
const STORAGE_KEY_LLM_MODEL = 'ememory_llm_model';
const GOOGLE_GENERATE_URL =
  'https://generativelanguage.googleapis.com/v1beta/{model}:generateContent';

// ── IndexedDB ─────────────────────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_DECKS)) {
        db.createObjectStore(STORE_DECKS, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
        db.createObjectStore(STORE_PROGRESS, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getDeck(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DECKS, 'readonly');
    const req = tx.objectStore(STORE_DECKS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function getCardProgress(deckId, cardIndex) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROGRESS, 'readonly');
    const req = tx.objectStore(STORE_PROGRESS).get(`${deckId}:${cardIndex}`);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function saveCardProgress(deckId, cardIndex, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROGRESS, 'readwrite');
    const req = tx.objectStore(STORE_PROGRESS).put({
      id: `${deckId}:${cardIndex}`,
      deckId,
      cardIndex,
      ...data
    });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── SM-2 Algorithm ────────────────────────────────────────────────────────────

function defaultCardProgress() {
  return {
    interval: 0,
    easeFactor: 2.5,
    repetitions: 0,
    dueDate: new Date().toISOString(),
    lastReview: null
  };
}

// quality: 1=Again, 2=Hard, 3=Good, 4=Easy → mapped to SM-2 q (0–5)
function applyReview(progress, quality) {
  const qualityMap = { 1: 1, 2: 3, 3: 4, 4: 5 };
  const q = qualityMap[quality] ?? 4;
  let { interval, easeFactor, repetitions } = progress;

  if (q < 3) {
    interval = 1;
    repetitions = 0;
  } else {
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = 6;
    else interval = Math.round(interval * easeFactor);

    easeFactor += 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
    easeFactor = Math.max(1.3, easeFactor);
    repetitions++;
  }

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + interval);

  return {
    interval,
    easeFactor,
    repetitions,
    dueDate: dueDate.toISOString(),
    lastReview: new Date().toISOString()
  };
}

function isCardDue(progress) {
  if (!progress || !progress.dueDate) return true;
  return new Date(progress.dueDate) <= new Date();
}

// ── LLM ──────────────────────────────────────────────────────────────────────

function buildSystemPrompt(card) {
  return `You are an interactive Anki flashcard tutor. You are teaching the user one specific flashcard.

Flashcard:
- Front (question / topic): ${card.front}
- Back (answer / information): ${card.back}

Your instructions:
1. Begin by asking the user a question that tests their recall of the card content. Do NOT give away the answer immediately.
2. Hold a short, encouraging conversation. Offer hints if the user struggles.
3. Keep each of your replies brief (1–3 sentences).
4. After 2–5 meaningful exchanges, once the user has demonstrated adequate understanding, end your message with the token [NEXT_CARD:N] (nothing after it), where N is your quality rating:
   - 1 = user could not recall at all (Again)
   - 2 = user needed significant help (Hard)
   - 3 = user understood with some guidance (Good)
   - 4 = user recalled quickly and correctly (Easy)
5. Emit [NEXT_CARD:N] only once and only when you are satisfied with the user's learning.
6. Respond in the same language the user writes in.`;
}

async function callLLM(apiKey, modelId, systemPrompt, history) {
  const url = GOOGLE_GENERATE_URL.replace('{model}', modelId);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: history
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Speech synthesis ──────────────────────────────────────────────────────────

const synth = window.speechSynthesis;

function speak(text) {
  if (!synth) return;
  const cleanText = text.replace(/\[NEXT_CARD:\d\]/g, '').trim();
  if (!cleanText) return;
  if (synth.speaking) synth.cancel();
  synth.speak(new SpeechSynthesisUtterance(cleanText));
}

// ── Speech recognition ────────────────────────────────────────────────────────

const SpeechRecognitionAPI =
  window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;

// ── UI helpers ────────────────────────────────────────────────────────────────

function showState(id) {
  document.querySelectorAll('.study-state').forEach((el) => {
    el.style.display = el.id === id ? '' : 'none';
  });
}

function addMessage(role, text) {
  const conv = document.getElementById('study-conversation');
  const msg = document.createElement('div');
  msg.className = `study-message study-message--${role}`;
  const displayText = text.replace(/\[NEXT_CARD:\d\]/g, '').trim();

  const icon = document.createElement('span');
  icon.className = 'study-message__icon';
  icon.textContent = role === 'model' ? '🤖' : '👤';

  const textSpan = document.createElement('span');
  textSpan.className = 'study-message__text';
  textSpan.textContent = displayText;

  msg.appendChild(icon);
  msg.appendChild(textSpan);
  conv.appendChild(msg);
  conv.scrollTop = conv.scrollHeight;
}

function setStatus(text) {
  document.getElementById('study-status').textContent = text;
}

function setInputDisabled(disabled) {
  document.getElementById('text-input').disabled = disabled;
  document.getElementById('send-btn').disabled = disabled;
  document.getElementById('voice-btn').disabled = disabled;
}

function updateProgressBar(current, total) {
  document.getElementById('study-progress-text').textContent =
    `Card ${current} / ${total}`;
  document.getElementById('study-progress-fill').style.width =
    `${Math.round((current / total) * 100)}%`;
}

// ── Session state ─────────────────────────────────────────────────────────────

let sessionDeckId = null;
let sessionDeck = null;
let sessionQueue = [];  // card indices due today
let sessionQueuePos = 0;
let conversationHistory = [];
let systemPrompt = '';
let apiKey = '';
let modelId = '';

// ── LLM flow ──────────────────────────────────────────────────────────────────

async function getLLMResponse() {
  setStatus('🤖 Thinking…');
  setInputDisabled(true);

  try {
    const response = await callLLM(apiKey, modelId, systemPrompt, conversationHistory);
    conversationHistory.push({ role: 'model', parts: [{ text: response }] });

    addMessage('model', response);
    speak(response);

    // Reveal the card back once the tutor has started the conversation
    document.getElementById('card-separator').style.display = '';
    document.getElementById('card-back-label').style.display = '';
    document.getElementById('card-back').style.display = '';

    const match = response.match(/\[NEXT_CARD:(\d)\]/);
    if (match) {
      await handleCardMastered(parseInt(match[1], 10));
    } else {
      setStatus('');
      setInputDisabled(false);
    }
  } catch (err) {
    setStatus(`⚠️ Error: ${err.message}`);
    setInputDisabled(false);
  }
}

async function handleCardMastered(quality) {
  const cardIndex = sessionQueue[sessionQueuePos];
  const existing = await getCardProgress(sessionDeckId, cardIndex);
  const updated = applyReview(existing || defaultCardProgress(), quality);
  await saveCardProgress(sessionDeckId, cardIndex, updated);

  const qualityLabel = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' }[quality] || 'Good';
  setStatus(
    `✓ ${qualityLabel} – next review in ${updated.interval} day${updated.interval !== 1 ? 's' : ''}.`
  );

  await new Promise((r) => setTimeout(r, 2500));

  sessionQueuePos++;
  if (sessionQueuePos >= sessionQueue.length) {
    showState('state-done');
  } else {
    await startCard(sessionQueue[sessionQueuePos]);
  }
}

async function handleUserInput(text) {
  if (!text.trim()) return;
  if (synth && synth.speaking) synth.cancel();

  conversationHistory.push({ role: 'user', parts: [{ text }] });
  addMessage('user', text);
  await getLLMResponse();
}

// ── Card management ───────────────────────────────────────────────────────────

async function startCard(cardIndex) {
  const card = sessionDeck.cards[cardIndex];

  // Seed history with a silent trigger so the LLM opens the conversation
  conversationHistory = [
    { role: 'user', parts: [{ text: 'Please start teaching me this flashcard.' }] }
  ];
  systemPrompt = buildSystemPrompt(card);

  updateProgressBar(sessionQueuePos + 1, sessionQueue.length);

  document.getElementById('card-front').textContent = card.front;
  document.getElementById('card-back').textContent = card.back;
  document.getElementById('card-separator').style.display = 'none';
  document.getElementById('card-back-label').style.display = 'none';
  document.getElementById('card-back').style.display = 'none';
  document.getElementById('study-conversation').innerHTML = '';
  setStatus('');

  await getLLMResponse();
}

async function startSession(deckId) {
  sessionDeckId = deckId;
  apiKey = localStorage.getItem(STORAGE_KEY_LLM_API) || '';
  modelId = localStorage.getItem(STORAGE_KEY_LLM_MODEL) || '';

  if (!apiKey || !modelId) {
    showState('state-no-api');
    return;
  }

  const deck = await getDeck(deckId);
  if (!deck) {
    showState('state-done');
    return;
  }
  sessionDeck = deck;

  // Build a queue of cards due today (new cards are always due)
  sessionQueue = [];
  for (let i = 0; i < deck.cards.length; i++) {
    const progress = await getCardProgress(deckId, i);
    if (isCardDue(progress)) {
      sessionQueue.push(i);
    }
  }

  if (sessionQueue.length === 0) {
    showState('state-done');
    return;
  }

  sessionQueuePos = 0;
  showState('state-study');
  await startCard(sessionQueue[0]);
}

// ── Voice ─────────────────────────────────────────────────────────────────────

function setupVoice() {
  const voiceBtn = document.getElementById('voice-btn');

  if (!SpeechRecognitionAPI) {
    voiceBtn.style.display = 'none';
    return;
  }

  voiceBtn.addEventListener('click', () => {
    if (isListening) {
      recognition.stop();
    } else {
      startListening();
    }
  });
}

function startListening() {
  if (isListening) return;
  if (synth && synth.speaking) synth.cancel();

  recognition = new SpeechRecognitionAPI();
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onresult = (e) => {
    document.getElementById('text-input').value =
      e.results[0][0].transcript;
  };

  recognition.onend = () => {
    isListening = false;
    document.getElementById('voice-btn').classList.remove('study-voice-btn--active');
    setStatus('');
    const val = document.getElementById('text-input').value.trim();
    if (val) {
      document.getElementById('text-input').value = '';
      handleUserInput(val);
    }
  };

  recognition.onerror = (e) => {
    console.warn('Speech recognition error:', e.error);
    isListening = false;
    document.getElementById('voice-btn').classList.remove('study-voice-btn--active');
    setStatus('');
  };

  try {
    recognition.start();
    isListening = true;
    document.getElementById('voice-btn').classList.add('study-voice-btn--active');
    setStatus('🎤 Listening…');
  } catch (e) {
    console.warn('Could not start speech recognition:', e);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const deckId = parseInt(params.get('deckId'), 10);

  if (!deckId) {
    showState('state-done');
    return;
  }

  document.getElementById('send-btn').addEventListener('click', () => {
    const val = document.getElementById('text-input').value.trim();
    if (!val) return;
    document.getElementById('text-input').value = '';
    handleUserInput(val);
  });

  document.getElementById('text-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const val = e.target.value.trim();
      if (!val) return;
      e.target.value = '';
      handleUserInput(val);
    }
  });

  setupVoice();
  startSession(deckId);
});
