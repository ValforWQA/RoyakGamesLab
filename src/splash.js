const root = document.getElementById('splashRoot');
const status = document.getElementById('splashStatus');
const detail = document.getElementById('splashDetail');

window.setSplashStatus = (text, state = 'checking', extra = '') => {
  status.textContent = String(text || '');
  status.dataset.state = String(state || 'checking');
  detail.textContent = String(extra || '');
};

window.addEventListener('splash:fade', () => root.classList.add('fadeOut'));
