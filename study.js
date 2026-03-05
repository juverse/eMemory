// study.js – AI voice study session using Gemini + Web Speech API

const DB_NAME = 'eMemory';
const DB_VERSION = 1;
const STORE_DECKS = 'decks';
const STORAGE_KEY_LLM_API = 'ememory_llm_api_key';
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_API_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_TEMPERATURE = 0.7;
const GEMINI_MAX_TOKENS = 512;

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getDeck(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DECKS, 'readonly');
    const req = tx.objectStore(STORE_DECKS).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Session state ─────────────────────────────────────────────────────────────

let deck = null;
let cardIndex = 0;
let conversationHistory = []; // {role:'user'|'model', parts:[{text:string}]}[]
let isListening = false;
let isSpeaking = false;
let recognition = null;

// ── DOM references ────────────────────────────────────────────────────────────

const noApiKeyWarning = document.getElementById('no-api-key-warning');
const noDeckWarning = document.getElementById('no-deck-warning');
const deckNameDisplay = document.getElementById('deck-name-display');
const cardProgressEl = document.getElementById('card-progress');
const cardFrontEl = document.getElementById('card-front');
const cardBackEl = document.getElementById('card-back');
const chatContainer = document.getElementById('chat-container');
const statusText = document.getElementById('status-text');
const micBtn = document.getElementById('mic-btn');
const stopBtn = document.getElementById('stop-btn');
const nextCardBtn = document.getElementById('next-card-btn');

// ── Utilities ─────────────────────────────────────────────────────────────────

function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || '';
}

function setStatus(msg) {
  statusText.textContent = msg;
}

function addMessage(role, text) {
  const wrapper = document.createElement('div');
  wrapper.className = `chat-message chat-message--${role}`;
  const bubble = document.createElement('span');
  bubble.className = 'chat-message__bubble';
  bubble.textContent = text;
  wrapper.appendChild(bubble);
  chatContainer.appendChild(wrapper);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function currentCard() {
  return deck ? deck.cards[cardIndex] : null;
}

function buildSystemPrompt(card) {
  const front = stripHtml(card.front);
  const back = stripHtml(card.back);
  return [
    'You are a friendly AI tutor helping a student learn with Anki flashcards.',
    'Your goal: help the student deeply understand the card through questions, hints, and short explanations.',
    `Current flashcard:\nFront: ${front}\nBack: ${back}`,
    'Rules:',
    '- Keep every reply SHORT (2–4 sentences) because it will be read aloud.',
    '- Use plain spoken language. No markdown, no bullet points, no symbols.',
    '- Begin by asking the student a question about the card.',
    '- Give encouraging feedback on answers and follow up with related questions.',
    '- Match the language the student uses.',
  ].join('\n');
}

// ── Gemini API ────────────────────────────────────────────────────────────────

async function callGemini(userMessage) {
  const apiKey = localStorage.getItem(STORAGE_KEY_LLM_API) || '';
  if (!apiKey) {
    throw new Error('No API key – please add your Gemini API key in Settings.');
  }

  const card = currentCard();
  const systemPrompt = card ? buildSystemPrompt(card) : 'You are a helpful tutor.';

  conversationHistory.push({ role: 'user', parts: [{ text: userMessage }] });

  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: conversationHistory,
    generationConfig: { temperature: GEMINI_TEMPERATURE, maxOutputTokens: GEMINI_MAX_TOKENS },
  };

  const resp = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData?.error?.message || `Gemini API error ${resp.status}`);
  }

  const data = await resp.json();
  const aiText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  if (!aiText) throw new Error('Empty response from Gemini.');

  conversationHistory.push({ role: 'model', parts: [{ text: aiText }] });
  return aiText;
}

// ── Speech synthesis ──────────────────────────────────────────────────────────

function speak(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) {
      resolve();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    isSpeaking = true;
    utterance.onend = () => { isSpeaking = false; resolve(); };
    utterance.onerror = () => { isSpeaking = false; resolve(); };
    window.speechSynthesis.speak(utterance);
  });
}

function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  isSpeaking = false;
}

// ── Speech recognition ────────────────────────────────────────────────────────

const SpeechRecognitionAPI =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;

function startListening() {
  if (!SpeechRecognitionAPI) {
    setStatus('⚠️ Speech recognition is not supported in this browser. Try Chrome.');
    return;
  }

  stopSpeaking();

  recognition = new SpeechRecognitionAPI();
  recognition.lang = navigator.language || 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  isListening = true;
  micBtn.classList.add('study-mic-btn--active');
  micBtn.setAttribute('aria-label', 'Stop listening');
  setStatus('🎙️ Listening… (tap again to stop)');

  recognition.onresult = async (e) => {
    const transcript = e.results[0][0].transcript.trim();
    endListening();
    if (!transcript) return;
    addMessage('user', transcript);
    await processUserInput(transcript);
  };

  recognition.onerror = (e) => {
    endListening();
    setStatus(
      e.error === 'no-speech'
        ? 'No speech detected. Tap to try again.'
        : `⚠️ Recognition error: ${e.error}`
    );
  };

  recognition.onend = () => {
    if (isListening) endListening();
  };

  recognition.start();
}

function endListening() {
  isListening = false;
  micBtn.classList.remove('study-mic-btn--active');
  micBtn.setAttribute('aria-label', 'Start voice input');
  if (recognition) {
    try { recognition.stop(); } catch (_) { /* already stopped */ }
    recognition = null;
  }
}

async function processUserInput(text) {
  setStatus('🤔 Thinking…');
  micBtn.disabled = true;
  stopBtn.style.display = '';

  try {
    const aiText = await callGemini(text);
    addMessage('model', aiText);
    setStatus('🔊 Speaking…');
    await speak(aiText);
    setStatus('Tap the microphone to respond.');
  } catch (err) {
    addMessage('model', `⚠️ ${err.message}`);
    setStatus('Error. Tap the microphone to try again.');
  } finally {
    micBtn.disabled = false;
    stopBtn.style.display = 'none';
  }
}

// ── Card & session management ─────────────────────────────────────────────────

function showCard(index) {
  const card = deck.cards[index];
  cardFrontEl.textContent = stripHtml(card.front);
  cardBackEl.textContent = stripHtml(card.back);
  cardProgressEl.textContent = `${index + 1} / ${deck.cards.length}`;
}

async function startSession() {
  conversationHistory = [];
  chatContainer.innerHTML = '';
  micBtn.disabled = true;
  stopBtn.style.display = '';
  setStatus('🤔 Starting session…');

  try {
    const opening = await callGemini(
      'Please start the study session and ask me a question about the card.'
    );
    addMessage('model', opening);
    setStatus('🔊 Speaking…');
    await speak(opening);
    setStatus('Tap the microphone to respond.');
  } catch (err) {
    addMessage('model', `⚠️ ${err.message}`);
    setStatus('Error starting session. Tap the microphone to try again.');
  } finally {
    micBtn.disabled = false;
    stopBtn.style.display = 'none';
  }
}

async function goNextCard() {
  stopSpeaking();
  endListening();
  cardIndex = (cardIndex + 1) % deck.cards.length;
  showCard(cardIndex);
  if (localStorage.getItem(STORAGE_KEY_LLM_API)) {
    await startSession();
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const deckId = Number(params.get('deckId'));
  const apiKey = localStorage.getItem(STORAGE_KEY_LLM_API) || '';

  if (!apiKey) {
    noApiKeyWarning.style.display = '';
  }

  if (!deckId) {
    noDeckWarning.style.display = '';
    micBtn.disabled = true;
    nextCardBtn.disabled = true;
    return;
  }

  deck = await getDeck(deckId).catch(() => null);

  if (!deck || !deck.cards.length) {
    noDeckWarning.style.display = '';
    micBtn.disabled = true;
    nextCardBtn.disabled = true;
    return;
  }

  deckNameDisplay.textContent = deck.name;
  cardIndex = 0;
  showCard(0);

  micBtn.addEventListener('click', () => {
    if (isListening) {
      endListening();
      setStatus('Tap the microphone to start.');
    } else if (isSpeaking) {
      stopSpeaking();
      startListening();
    } else {
      startListening();
    }
  });

  stopBtn.addEventListener('click', () => {
    stopSpeaking();
    setStatus('Tap the microphone to respond.');
    stopBtn.style.display = 'none';
    micBtn.disabled = false;
  });

  nextCardBtn.addEventListener('click', goNextCard);

  if (apiKey) {
    await startSession();
  } else {
    setStatus('Please save your Gemini API key in Settings to start.');
    micBtn.disabled = true;
  }
});
