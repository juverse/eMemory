const STORAGE_KEY_LLM_API = 'ememory_llm_api_key';
const STORAGE_KEY_LLM_PROVIDER = 'ememory_llm_provider';
const STORAGE_KEY_LLM_MODEL = 'ememory_llm_model';

const GOOGLE_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GOOGLE_GENERATE_URL = 'https://generativelanguage.googleapis.com/v1beta/{model}:generateContent';

const form = document.getElementById('settings-form');
const apiKeyInput = document.getElementById('llm-api-key');
const providerSelect = document.getElementById('llm-provider');
const modelSelect = document.getElementById('llm-model');
const fetchModelsBtn = document.getElementById('fetch-models-btn');
const fetchModelsMsg = document.getElementById('fetch-models-msg');
const savedMsg = document.getElementById('saved-msg');

// Load saved values on page open
apiKeyInput.value = localStorage.getItem(STORAGE_KEY_LLM_API) || '';
providerSelect.value = localStorage.getItem(STORAGE_KEY_LLM_PROVIDER) || 'google';
const storedModel = localStorage.getItem(STORAGE_KEY_LLM_MODEL) || '';

function setFetchMsg(text, isError) {
  fetchModelsMsg.textContent = text;
  fetchModelsMsg.style.color = isError ? '#c62828' : '#2e7d32';
}

function setSavedMsg(text, isError) {
  savedMsg.textContent = text;
  savedMsg.style.color = isError ? '#c62828' : '#2e7d32';
  savedMsg.style.display = 'block';
  if (!isError) {
    setTimeout(() => { savedMsg.style.display = 'none'; }, 4000);
  }
}

async function fetchGoogleModels(apiKey) {
  const res = await fetch(GOOGLE_MODELS_URL, {
    headers: { 'x-goog-api-key': apiKey }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return (data.models || [])
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => ({ id: m.name, label: m.displayName || m.name }));
}

function populateModelSelect(models, selectedId) {
  modelSelect.innerHTML = '';
  if (models.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— no compatible models found —';
    modelSelect.appendChild(opt);
    modelSelect.disabled = true;
    return;
  }
  models.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === selectedId) opt.selected = true;
    modelSelect.appendChild(opt);
  });
  modelSelect.disabled = false;
}

async function loadModels() {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setFetchMsg('Please enter an API key first.', true);
    return;
  }
  fetchModelsBtn.disabled = true;
  fetchModelsBtn.textContent = '⏳ Loading…';
  setFetchMsg('Fetching models…', false);
  try {
    const models = await fetchGoogleModels(apiKey);
    populateModelSelect(models, storedModel);
    setFetchMsg(`✓ ${models.length} model${models.length !== 1 ? 's' : ''} loaded.`, false);
  } catch (err) {
    setFetchMsg(`Error: ${err.message}`, true);
    modelSelect.disabled = true;
  } finally {
    fetchModelsBtn.disabled = false;
    fetchModelsBtn.textContent = 'Load Models';
  }
}

fetchModelsBtn.addEventListener('click', loadModels);

// Auto-load models if API key is already stored
if (apiKeyInput.value) {
  loadModels();
}

async function testGoogleModel(apiKey, modelId) {
  const url = GOOGLE_GENERATE_URL.replace('{model}', modelId);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const apiKey = apiKeyInput.value.trim();
  const provider = providerSelect.value;
  const modelId = modelSelect.value;

  if (!apiKey) {
    setSavedMsg('⚠ Please enter an API key.', true);
    return;
  }
  if (!modelId) {
    setSavedMsg('⚠ Please select a model.', true);
    return;
  }

  const saveBtn = form.querySelector('.settings-save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = '⏳ Testing…';
  savedMsg.style.display = 'none';

  try {
    await testGoogleModel(apiKey, modelId);
    localStorage.setItem(STORAGE_KEY_LLM_API, apiKey);
    localStorage.setItem(STORAGE_KEY_LLM_PROVIDER, provider);
    localStorage.setItem(STORAGE_KEY_LLM_MODEL, modelId);
    setSavedMsg('✓ Saved & connection verified!', false);
  } catch (err) {
    setSavedMsg(`✗ Test failed: ${err.message}`, true);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save & Test';
  }
});
