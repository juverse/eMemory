// ── Constants ──────────────────────────────────────────────────────────────────

const DB_NAME = 'eMemory';
const DB_VERSION = 2;
const STORE_DECKS = 'decks';
const STORE_PROGRESS = 'progress';

const STORAGE_KEY_LLM_API = 'ememory_llm_api_key';
const STORAGE_KEY_LLM_MODEL = 'ememory_llm_model';
const GOOGLE_GENERATE_URL =
  'https://generativelanguage.googleapis.com/v1beta/{model}:generateContent';

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_DECKS)) {
        db.createObjectStore(STORE_DECKS, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
        db.createObjectStore(STORE_PROGRESS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadDeck(deckId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DECKS, 'readonly');
    const req = tx.objectStore(STORE_DECKS).get(deckId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function progressKey(deckId, cardIndex) {
  return `${deckId}:${cardIndex}`;
}

async function getProgress(deckId, cardIndex) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROGRESS, 'readonly');
    const req = tx.objectStore(STORE_PROGRESS).get(progressKey(deckId, cardIndex));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function saveProgress(deckId, cardIndex, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROGRESS, 'readwrite');
    const req = tx.objectStore(STORE_PROGRESS).put({
      id: progressKey(deckId, cardIndex),
      ...data
    });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getAllDeckProgress(deckId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROGRESS, 'readonly');
    const range = IDBKeyRange.bound(`${deckId}:`, `${deckId}:\uffff`);
    const req = tx.objectStore(STORE_PROGRESS).getAll(range);
    req.onsuccess = () => {
      const map = {};
      for (const item of req.result) {
        const idx = parseInt(item.id.split(':')[1], 10);
        map[idx] = item;
      }
      resolve(map);
    };
    req.onerror = () => reject(req.error);
  });
}

// ── SM-2 Spaced Repetition ────────────────────────────────────────────────────

/**
 * Apply the SM-2 algorithm.
 * quality: 1=Again, 2=Hard, 3=Good, 4=Easy
 */
function sm2Update(progress, quality) {
  // Map quality 1–4 to SM-2 score 0–5:
  // Again(1)→0, Hard(2)→3, Good(3)→4, Easy(4)→5
  const qMap = [0, 3, 4, 5];
  const q = qMap[Math.max(1, Math.min(4, quality)) - 1];

  let interval = progress ? (progress.interval || 0) : 0;
  let repetitions = progress ? (progress.repetitions || 0) : 0;
  let easeFactor = progress ? (progress.easeFactor || 2.5) : 2.5;

  if (q < 3) {
    repetitions = 0;
    interval = 1;
  } else {
    if (repetitions === 0) {
      interval = 1;
    } else if (repetitions === 1) {
      interval = 6;
    } else {
      interval = Math.round(interval * easeFactor);
    }
    repetitions += 1;
  }

  // Standard SM-2 ease factor formula: EF' = EF + (0.1 − (5−q)·(0.08 + (5−q)·0.02))
  // Minimum ease factor is 1.3 to prevent intervals from shrinking too aggressively.
  easeFactor = Math.max(1.3, easeFactor + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));

  const nextDue = new Date();
  nextDue.setDate(nextDue.getDate() + interval);

  return {
    interval,
    repetitions,
    easeFactor: parseFloat(easeFactor.toFixed(3)),
    nextDue: nextDue.toISOString().split('T')[0],
    lastStudied: new Date().toISOString()
  };
}

function isDue(progress) {
  if (!progress || !progress.nextDue) return true;
  const today = new Date().toISOString().split('T')[0];
  return progress.nextDue <= today;
}

// ── LLM integration ───────────────────────────────────────────────────────────

function buildSystemPrompt(card) {
  return `You are an interactive Anki flashcard tutor. Your goal is to help the user learn and retain the following card through a natural voice conversation.

CARD CONTENT:
Front: ${card.front}
Back: ${card.back}

YOUR ROLE:
1. Start with a short, engaging question to probe the user's existing knowledge about the topic.
2. Conduct a Socratic learning conversation – ask follow-up questions, give hints when needed, and gently correct mistakes.
3. Keep every response SHORT (2–3 sentences max) – this is a spoken voice conversation.
4. Ask only ONE question at a time.
5. Respond in the same language as the card content.
6. Be encouraging and patient.

ENDING THE SESSION:
Once you are confident the user has genuinely understood the card content, end your message with this exact token on its own line:
[NEXT_CARD:N]

where N is:
  1 = User could not answer (Again)
  2 = User answered with significant difficulty (Hard)
  3 = User answered correctly with some help (Good)
  4 = User answered quickly and correctly (Easy)

Important: Only output [NEXT_CARD:N] when the learning session for this card is truly complete.`;
}

async function sendToLLM(systemPrompt, history) {
  const apiKey = localStorage.getItem(STORAGE_KEY_LLM_API);
  const modelId = localStorage.getItem(STORAGE_KEY_LLM_MODEL);
  if (!apiKey || !modelId) {
    throw new Error('No API key or model configured. Please go to Settings.');
  }

  const url = GOOGLE_GENERATE_URL.replace('{model}', modelId);
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: history
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Speech helpers ────────────────────────────────────────────────────────────

const synth = window.speechSynthesis;
const HUMAN_LIKE_VOICE_HINTS = ['neural', 'natural', 'google', 'siri', 'alexa', 'premium', 'enhanced'];
const SPEECH_RATE_HUMANIZED = 0.94;
const SPEECH_PITCH_HUMANIZED = 1.04;
let preferredVoice = null;
let preferredVoiceInitialized = false;

function getPreferredVoice() {
  if (!synth || typeof synth.getVoices !== 'function') return null;
  const voices = synth.getVoices();
  if (!voices || voices.length === 0) return null;

  const userLang = (navigator.language || 'en-US').toLowerCase();
  const userLangBase = userLang.split('-')[0];

  preferredVoice = voices
    .map((voice) => {
      const name = (voice.name || '').toLowerCase();
      const lang = (voice.lang || '').toLowerCase();
      let score = 0;
      if (lang === userLang) score += 5;
      else if (lang.startsWith(userLangBase)) score += 3;
      if (voice.localService) score += 1;
      if (HUMAN_LIKE_VOICE_HINTS.some((hint) => name.includes(hint))) score += 2;
      return { voice, score };
    })
    .sort((a, b) => b.score - a.score)[0]?.voice || voices[0];

  return preferredVoice;
}

if (synth && typeof synth.addEventListener === 'function') {
  synth.addEventListener('voiceschanged', () => {
    preferredVoiceInitialized = true;
    getPreferredVoice();
    updateSpeechControls();
  });
}

function ensurePreferredVoice() {
  if (!preferredVoiceInitialized) {
    preferredVoiceInitialized = true;
    getPreferredVoice();
  }
  return preferredVoice;
}

function speak(text, onEnd) {
  const cleanText = String(text || '').trim();
  if (!cleanText) {
    if (onEnd) onEnd();
    return;
  }

  appState.lastSpokenText = cleanText;

  if (!synth) {
    if (onEnd) onEnd();
    return;
  }

  synth.cancel();
  appState.isSpeechPaused = false;

  const utterance = new SpeechSynthesisUtterance(cleanText);
  utterance.rate = SPEECH_RATE_HUMANIZED;
  utterance.pitch = SPEECH_PITCH_HUMANIZED;
  utterance.volume = 1.0;
  utterance.lang = navigator.language || 'en-US';
  utterance.voice = preferredVoice || ensurePreferredVoice();

  const finishSpeech = () => {
    appState.isSpeechPaused = false;
    updateSpeechControls();
    if (onEnd) onEnd();
  };
  utterance.onend = finishSpeech;
  utterance.onerror = finishSpeech;

  synth.speak(utterance);

  updateSpeechControls();

  // Enable the voice button during TTS so the user can tap to interrupt
  if (SpeechRecognitionAPI) {
    const voiceBtn = document.getElementById('voice-btn');
    if (voiceBtn) {
      voiceBtn.disabled = false;
      voiceBtn.classList.remove('study-voice-btn--disabled');
    }
  }
}

function stopSpeaking() {
  if (synth) synth.cancel();
  appState.isSpeechPaused = false;
  updateSpeechControls();
}

function togglePauseContinueSpeaking() {
  if (!synth) return;
  if (appState.isSpeechPaused && synth.paused && synth.speaking) {
    synth.resume();
    appState.isSpeechPaused = false;
  } else if (synth.speaking) {
    synth.pause();
    appState.isSpeechPaused = true;
  }
  updateSpeechControls();
}

function repeatLastSpeech() {
  if (!appState.lastSpokenText) return;
  speak(appState.lastSpokenText);
}

const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

function createRecognition(onResult, onEnd, onInterim) {
  if (!SpeechRecognitionAPI) return null;
  const rec = new SpeechRecognitionAPI();
  rec.continuous = false;
  rec.interimResults = true;

  let resultHandled = false;
  let lastError = null;

  rec.onresult = (e) => {
    let finalText = '';
    let interimText = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalText += e.results[i][0].transcript;
      } else {
        interimText += e.results[i][0].transcript;
      }
    }
    if (finalText) {
      resultHandled = true;
      if (onResult) onResult(finalText);
    } else if (interimText && onInterim) {
      onInterim(interimText);
    }
  };

  rec.onerror = (e) => {
    lastError = e.error;
  };

  rec.onend = () => {
    if (!resultHandled) {
      if (onEnd) onEnd(lastError);
    }
  };

  return rec;
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str || '');
  return div.innerHTML;
}

function addMessage(role, text) {
  const chat = document.getElementById('study-chat');
  const displayText = text.replace(/\[NEXT_CARD:[1-4]\]/g, '').trim();
  if (!displayText) return;
  const msg = document.createElement('div');
  msg.className = `chat-msg chat-msg--${role}`;
  msg.innerHTML = `<span class="chat-bubble">${escapeHtml(displayText)}</span>`;
  chat.appendChild(msg);
  chat.scrollTop = chat.scrollHeight;
}

function setStatus(text) {
  document.getElementById('study-status').textContent = text;
}

function updateProgressDisplay(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('progress-text').textContent = `${done} / ${total}`;
  document.getElementById('progress-fill').style.width = `${pct}%`;
}

function renderCard(card) {
  document.getElementById('card-front').textContent = card.front || '';
  document.getElementById('card-back').textContent = card.back || '';
}

function setInputEnabled(enabled) {
  appState.inputEnabled = enabled;
  const voiceBtn = document.getElementById('voice-btn');
  const textInput = document.getElementById('text-input');
  const sendBtn = document.getElementById('send-btn');

  voiceBtn.disabled = !enabled;
  textInput.disabled = !enabled;
  sendBtn.disabled = !enabled;

  if (enabled) {
    voiceBtn.classList.remove('study-voice-btn--disabled');
    textInput.placeholder = 'Type your response or press the mic…';
  } else {
    voiceBtn.classList.add('study-voice-btn--disabled');
    textInput.placeholder = 'Waiting…';
  }

  updateSpeechControls();
}

function updateSpeechControls() {
  const stopBtn = appState.speechControls.stopBtn;
  const continueBtn = appState.speechControls.continueBtn;
  const repeatBtn = appState.speechControls.repeatBtn;
  if (!stopBtn || !continueBtn || !repeatBtn) return;

  const speaking = Boolean(synth && synth.speaking);
  const paused = Boolean(synth && speaking && appState.isSpeechPaused && synth.paused);

  stopBtn.disabled = !speaking;
  continueBtn.disabled = !speaking;
  repeatBtn.disabled = !appState.lastSpokenText;

  if (paused) {
    continueBtn.textContent = '▶';
    continueBtn.setAttribute('aria-label', 'Continue voice output');
    continueBtn.title = 'Continue voice output';
  } else {
    continueBtn.textContent = '⏸';
    continueBtn.setAttribute('aria-label', 'Pause voice output');
    continueBtn.title = 'Pause voice output';
  }
}

// ── Application state ─────────────────────────────────────────────────────────

const appState = {
  deck: null,
  dueCards: [],
  currentIndex: 0,
  cardsDone: 0,
  conversationHistory: [],
  systemPrompt: '',
  inputEnabled: false,
  lastSpokenText: '',
  isListening: false,
  isSpeechPaused: false,
  speechControls: {
    stopBtn: null,
    continueBtn: null,
    repeatBtn: null
  },
  recognition: null
};

// ── Card session ──────────────────────────────────────────────────────────────

function parseNextCard(text) {
  const match = text.match(/\[NEXT_CARD:([1-4])\]/);
  return match ? parseInt(match[1], 10) : null;
}

function cleanForSpeech(text) {
  return text.replace(/\[NEXT_CARD:[1-4]\]/g, '').trim();
}

async function startCardSession(cardIdx) {
  const card = appState.deck.cards[cardIdx];
  renderCard(card);

  document.getElementById('study-chat').innerHTML = '';
  appState.conversationHistory = [];
  appState.systemPrompt = buildSystemPrompt(card);

  setStatus('🤔 Thinking…');
  setInputEnabled(false);

  const triggerMsg = { role: 'user', parts: [{ text: 'Please start the learning session for this card.' }] };
  appState.conversationHistory.push(triggerMsg);

  try {
    const response = await sendToLLM(appState.systemPrompt, appState.conversationHistory);
    appState.conversationHistory.push({ role: 'model', parts: [{ text: response }] });
    addMessage('assistant', response);

    const quality = parseNextCard(response);
    if (quality !== null) {
      await finishCard(cardIdx, quality);
      return;
    }

    setStatus('');
    speak(cleanForSpeech(response), () => setInputEnabled(true));
  } catch (err) {
    setStatus(`❌ ${err.message}`);
    setInputEnabled(true);
  }
}

async function handleUserMessage(text) {
  if (!text.trim() || !appState.inputEnabled) return;

  setInputEnabled(false);
  addMessage('user', text);
  stopSpeaking();

  appState.conversationHistory.push({ role: 'user', parts: [{ text }] });
  setStatus('🤔 Thinking…');

  try {
    const response = await sendToLLM(appState.systemPrompt, appState.conversationHistory);
    appState.conversationHistory.push({ role: 'model', parts: [{ text: response }] });
    addMessage('assistant', response);

    const quality = parseNextCard(response);
    if (quality !== null) {
      await finishCard(appState.dueCards[appState.currentIndex], quality);
      return;
    }

    setStatus('');
    speak(cleanForSpeech(response), () => setInputEnabled(true));
  } catch (err) {
    setStatus(`❌ ${err.message}`);
    setInputEnabled(true);
  }
}

async function finishCard(cardIdx, quality) {
  const oldProgress = await getProgress(appState.deck.id, cardIdx);
  const newProgress = sm2Update(oldProgress, quality);
  await saveProgress(appState.deck.id, cardIdx, newProgress);

  appState.cardsDone++;
  appState.currentIndex++;
  updateProgressDisplay(appState.cardsDone, appState.dueCards.length);
  setStatus('');

  if (appState.currentIndex >= appState.dueCards.length) {
    showDone();
  } else {
    setTimeout(() => startCardSession(appState.dueCards[appState.currentIndex]), 1200);
  }
}

// ── Voice button ──────────────────────────────────────────────────────────────

function setupVoiceButton() {
  const voiceBtn = document.getElementById('voice-btn');

  if (!SpeechRecognitionAPI) {
    voiceBtn.style.display = 'none';
    return;
  }

  const textInput = document.getElementById('text-input');

  voiceBtn.addEventListener('click', () => {
    // Allow clicking to stop an active recording session
    if (appState.isListening) {
      appState.isListening = false;
      voiceBtn.classList.remove('study-voice-btn--listening');
      voiceBtn.textContent = '🎤';
      voiceBtn.setAttribute('aria-label', 'Press to speak');
      setStatus('');
      if (appState.recognition) appState.recognition.abort();
      return;
    }

    // Allow clicking when input is enabled OR when TTS is playing (to interrupt it)
    const ttsPlaying = synth && synth.speaking;
    if (!appState.inputEnabled && !ttsPlaying) return;

    stopSpeaking();
    // synth.cancel() does not reliably fire utterance.onend in all browsers,
    // so ensure input is fully enabled before starting recognition so that
    // interim/final text is visible and handleUserMessage() accepts results.
    setInputEnabled(true);

    appState.isListening = true;
    voiceBtn.classList.add('study-voice-btn--listening');
    voiceBtn.textContent = '⏹';
    voiceBtn.setAttribute('aria-label', 'Stop listening');
    setStatus('🎤 Listening…');

    appState.recognition = createRecognition(
      (transcript) => {
        appState.isListening = false;
        voiceBtn.classList.remove('study-voice-btn--listening');
        voiceBtn.textContent = '🎤';
        voiceBtn.setAttribute('aria-label', 'Press to speak');
        textInput.value = transcript;
        setStatus('');
        handleUserMessage(transcript);
      },
      (error) => {
        appState.isListening = false;
        voiceBtn.classList.remove('study-voice-btn--listening');
        voiceBtn.textContent = '🎤';
        voiceBtn.setAttribute('aria-label', 'Press to speak');
        textInput.value = '';
        if (error === 'not-allowed' || error === 'service-not-allowed') {
          setStatus('⚠️ Microphone access denied. Please allow microphone access.');
        } else if (error === 'audio-capture') {
          setStatus('⚠️ No microphone found.');
        } else if (error === 'network') {
          setStatus('⚠️ Network error during speech recognition.');
        } else if (error && error !== 'no-speech' && error !== 'aborted') {
          setStatus(`⚠️ Speech error: ${error}`);
        } else {
          setStatus('');
        }
        if (!appState.inputEnabled) setInputEnabled(true);
      },
      (interimText) => {
        textInput.value = interimText;
      }
    );

    try {
      appState.recognition.start();
    } catch (err) {
      appState.isListening = false;
      voiceBtn.classList.remove('study-voice-btn--listening');
      voiceBtn.textContent = '🎤';
      voiceBtn.setAttribute('aria-label', 'Press to speak');
      setStatus(`⚠️ Could not start recording: ${err.message}`);
    }
  });
}

function setupSpeechControls() {
  const stopBtn = document.getElementById('speech-stop-btn');
  const continueBtn = document.getElementById('speech-continue-btn');
  const repeatBtn = document.getElementById('speech-repeat-btn');
  if (!stopBtn || !continueBtn || !repeatBtn) return;
  appState.speechControls.stopBtn = stopBtn;
  appState.speechControls.continueBtn = continueBtn;
  appState.speechControls.repeatBtn = repeatBtn;

  if (!synth) {
    stopBtn.style.display = 'none';
    continueBtn.style.display = 'none';
    repeatBtn.style.display = 'none';
    return;
  }

  stopBtn.addEventListener('click', () => {
    stopSpeaking();
  });

  continueBtn.addEventListener('click', () => {
    togglePauseContinueSpeaking();
  });

  repeatBtn.addEventListener('click', () => {
    repeatLastSpeech();
  });

  updateSpeechControls();
}

// ── Done screen ───────────────────────────────────────────────────────────────

function showDone() {
  document.getElementById('study-session').style.display = 'none';
  document.getElementById('study-done').style.display = 'flex';
  const n = appState.cardsDone;
  const msg = `Gut gemacht! Du hast ${n} Karte${n !== 1 ? 'n' : ''} gelernt.`;
  document.getElementById('study-done-msg').textContent = msg;
  speak(msg);
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const params = new URLSearchParams(window.location.search);
  const deckId = Number(params.get('deck'));

  if (!deckId) {
    window.location.href = 'index.html';
    return;
  }

  if (!localStorage.getItem(STORAGE_KEY_LLM_API) || !localStorage.getItem(STORAGE_KEY_LLM_MODEL)) {
    document.getElementById('study-loading').innerHTML =
      '<p>⚠️ No LLM configured.</p>' +
      '<p style="margin-top:.5rem">Please <a href="settings.html">configure your API key in Settings</a> first.</p>';
    return;
  }

  try {
    const deck = await loadDeck(deckId);
    if (!deck) throw new Error('Deck not found.');

    appState.deck = deck;
    document.getElementById('deck-title').textContent = deck.name;
    document.title = `eMemory – ${deck.name}`;

    const progressMap = await getAllDeckProgress(deckId);
    const dueCards = deck.cards
      .map((_, i) => i)
      .filter((i) => isDue(progressMap[i]));

    document.getElementById('study-loading').style.display = 'none';

    if (dueCards.length === 0) {
      document.getElementById('study-done').style.display = 'flex';
      document.getElementById('study-done-msg').textContent =
        'Keine Karten fällig. Komm später wieder! 🎉';
      return;
    }

    appState.dueCards = dueCards;
    appState.currentIndex = 0;
    appState.cardsDone = 0;

    document.getElementById('study-session').style.display = 'flex';
    updateProgressDisplay(0, dueCards.length);

    setupVoiceButton();
    setupSpeechControls();

    const textInput = document.getElementById('text-input');
    const sendBtn = document.getElementById('send-btn');

    sendBtn.addEventListener('click', () => {
      const text = textInput.value.trim();
      textInput.value = '';
      if (text) handleUserMessage(text);
    });

    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = textInput.value.trim();
        textInput.value = '';
        if (text) handleUserMessage(text);
      }
    });

    startCardSession(dueCards[0]);
  } catch (err) {
    document.getElementById('study-loading').innerHTML =
      `<p>❌ ${escapeHtml(err.message)}</p>` +
      '<p style="margin-top:.5rem"><a href="index.html">← Back to decks</a></p>';
  }
}

document.addEventListener('DOMContentLoaded', init);
