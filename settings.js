const STORAGE_KEY_LLM_API = 'ememory_llm_api_key';

const form = document.getElementById('settings-form');
const apiKeyInput = document.getElementById('llm-api-key');
const savedMsg = document.getElementById('saved-msg');

// Load saved value on page open
const storedKey = localStorage.getItem(STORAGE_KEY_LLM_API);
if (storedKey) {
  apiKeyInput.value = storedKey;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  localStorage.setItem(STORAGE_KEY_LLM_API, apiKeyInput.value.trim());
  savedMsg.style.display = 'block';
  setTimeout(() => {
    savedMsg.style.display = 'none';
  }, 3000);
});
