const API = 'https://planitvibe.com';
const TOKEN_KEY = 'planitvibeAdminToken';
const USER_KEY = 'planitvibeAdminUser';
const ZONE_KEY = 'planitvibe.admin.timeZone';
const DELAY_KEY = 'planitvibe.admin.searchDelaySec';
const STYLES_KEY = 'planitvibe.admin.styles';
const STYLE_TYPES = ['banner', 'heading', 'label', 'input', 'button', 'table', 'error'];
const STYLE_FONTS = ['system-ui', 'Georgia', 'Times New Roman', 'Arial', 'Verdana', 'Consolas'];
const STYLE_LABELS = {
  banner: 'Banner',
  heading: 'Heading',
  label: 'Label',
  input: 'Input',
  button: 'Button',
  table: 'Table',
  error: 'Error',
};
const FONT_STACKS = {
  'system-ui': 'system-ui, sans-serif',
  Georgia: 'Georgia, serif',
  'Times New Roman': '"Times New Roman", Times, serif',
  Arial: 'Arial, sans-serif',
  Verdana: 'Verdana, sans-serif',
  Consolas: 'Consolas, monospace',
};
const STYLE_DEFAULTS = {
  banner: { font: 'Georgia', color: '#1c1915', size: 16 },
  heading: { font: 'Georgia', color: '#1c1915', size: 24 },
  label: { font: 'Georgia', color: '#1c1915', size: 14 },
  input: { font: 'Georgia', color: '#1c1915', size: 16 },
  button: { font: 'Georgia', color: '#f7f4ee', size: 16 },
  table: { font: 'Consolas', color: '#1c1915', size: 13 },
  error: { font: 'Georgia', color: '#8a2a1a', size: 16 },
};
const ZONE_CHOICES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'Europe/London',
];

// SupportLog event strings the mounted API already writes. Activity routes use
// /api/activities. PlanCreated and UserDeleted stay. A loaded row can still add
// an older name such as POST /api/events. Stored rows are not rewritten.
const KNOWN_EVENTS = [
  'DELETE /api/activities/:id',
  'DELETE /api/admin/activities/:activityId',
  'DELETE /api/admin/plans/:planId',
  'DELETE /api/admin/users/:userId',
  'GET /api/activities/:id/history',
  'GET /api/activities/plan/:planId',
  'GET /api/admin/activities/:activityId',
  'GET /api/admin/plans/:planId',
  'GET /api/admin/users',
  'GET /api/admin/users/:userId',
  'GET /api/invites',
  'GET /api/plans',
  'GET /api/plans/:planId/itinerary',
  'GET /api/plans/:planId/users',
  'PATCH /api/auth/users/:userId',
  'POST /api/activities',
  'POST /api/activities/:id/restore',
  'POST /api/auth/forgot-password',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/register',
  'POST /api/auth/reset-password',
  'POST /api/auth/verify-token',
  'POST /api/invites/invitations/:invitationId/respond',
  'POST /api/plans',
  'POST /api/plans/:planId/invite',
  'POST /api/plans/:planId/reassign-coordinator',
  'POST /api/plans/:planId/remove-user',
  'PUT /api/activities/:id',
  'PlanCreated',
  'UserDeleted',
];

const loginPanel = document.getElementById('login-panel');
const appPanel = document.getElementById('app-panel');
const logoutButton = document.getElementById('logout');
const loginError = document.getElementById('login-error');
const logsStatus = document.getElementById('logs-status');
const logsBody = document.getElementById('logs-body');
const appNav = document.getElementById('app-nav');
const logsPage = document.getElementById('logs-page');
const settingsPage = document.getElementById('settings-page');
const settingsStatus = document.getElementById('settings-status');
const zoneSelect = document.getElementById('display-time-zone');
const searchDelayInput = document.getElementById('search-delay');
const loginBanner = document.getElementById('login-banner');

let loadedLogs = [];
let logUserId = '';
let explorerUserId = '';
let explorerUserEmail = '';
let planExplorerId = '';
let planExplorerName = '';
let activityExplorerId = '';
let activityExplorerName = '';
let explorerSeq = 0;
let planExplorerSeq = 0;
let activityExplorerSeq = 0;
let userSearchTimer = 0;
let userSearchSeq = 0;
let eventOptions = KNOWN_EVENTS.slice();
let planMenu = null;
let accountMenu = null;

function token() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}

function storedUser() {
  const raw = sessionStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    const user = JSON.parse(raw);
    if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
    return user;
  } catch (err) {
    return null;
  }
}

function saveSessionUser(user) {
  sessionStorage.setItem(USER_KEY, JSON.stringify({
    firstName: user && user.firstName ? String(user.firstName) : '',
    lastName: user && user.lastName ? String(user.lastName) : '',
    email: user && user.email ? String(user.email) : '',
  }));
}

function bannerText() {
  if (!token()) return '';
  const user = storedUser();
  if (!user) return '';
  const name = [user.firstName, user.lastName]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
  const email = String(user.email || '').trim();
  if (name && email) return `Logged in as ${name} (${email})`;
  if (name) return `Logged in as ${name}`;
  if (email) return `Logged in as ${email}`;
  return '';
}

function updateBanner() {
  const text = bannerText();
  loginBanner.textContent = text;
  loginBanner.hidden = !text;
}

function showLoggedIn(isIn) {
  loginPanel.hidden = isIn;
  appPanel.hidden = !isIn;
  logoutButton.hidden = !isIn;
  appNav.hidden = !isIn;
  updateBanner();
  if (isIn) showPage();
}

function isCssColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function styleFor(type, saved) {
  const base = { ...STYLE_DEFAULTS[type] };
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return base;
  if (STYLE_FONTS.includes(saved.font)) base.font = saved.font;
  if (isCssColor(saved.color)) base.color = saved.color;
  const size = Number(saved.size);
  if (Number.isFinite(size) && size >= 12 && size <= 28) base.size = size;
  return base;
}

function loadStyles() {
  let saved = {};
  const raw = localStorage.getItem(STYLES_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
    } catch (err) {
      saved = {};
    }
  }
  const styles = {};
  for (const type of STYLE_TYPES) styles[type] = styleFor(type, saved[type]);
  return styles;
}

function applyStyles(styles) {
  const root = document.documentElement;
  for (const type of STYLE_TYPES) {
    const style = styles[type];
    root.style.setProperty(`--wv-${type}-font`, FONT_STACKS[style.font]);
    root.style.setProperty(`--wv-${type}-color`, style.color);
    root.style.setProperty(`--wv-${type}-size`, `${style.size}px`);
  }
}

function fillStyleFields(styles) {
  const root = document.getElementById('style-fields');
  root.replaceChildren();
  for (const type of STYLE_TYPES) {
    const style = styles[type];
    const box = document.createElement('fieldset');
    box.className = 'style-type';
    const legend = document.createElement('legend');
    legend.textContent = STYLE_LABELS[type];
    box.appendChild(legend);

    const fontLabel = document.createElement('label');
    fontLabel.append('Font');
    const font = document.createElement('select');
    font.id = `style-${type}-font`;
    for (const name of STYLE_FONTS) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      font.appendChild(option);
    }
    font.value = style.font;
    fontLabel.appendChild(font);

    const colorLabel = document.createElement('label');
    colorLabel.append('Color');
    const color = document.createElement('input');
    color.type = 'color';
    color.id = `style-${type}-color`;
    color.value = style.color;
    colorLabel.appendChild(color);

    const sizeLabel = document.createElement('label');
    sizeLabel.append('Size (px)');
    const size = document.createElement('input');
    size.type = 'number';
    size.id = `style-${type}-size`;
    size.min = '12';
    size.max = '28';
    size.step = 'any';
    size.value = String(style.size);
    sizeLabel.appendChild(size);

    box.append(fontLabel, colorLabel, sizeLabel);
    root.appendChild(box);
  }
}

function stylesFromForm() {
  const styles = {};
  for (const type of STYLE_TYPES) {
    const font = document.getElementById(`style-${type}-font`).value;
    const color = document.getElementById(`style-${type}-color`).value;
    const size = Number(document.getElementById(`style-${type}-size`).value);
    if (!STYLE_FONTS.includes(font) || !isCssColor(color) || !Number.isFinite(size) || size < 12 || size > 28) {
      return null;
    }
    styles[type] = { font, color, size };
  }
  return styles;
}

function isValidZone(zone) {
  if (!zone) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: zone }).format(new Date());
    return true;
  } catch (err) {
    return false;
  }
}

function browserZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidZone(zone) ? zone : 'UTC';
  } catch (err) {
    return 'UTC';
  }
}

function savedZone() {
  const saved = localStorage.getItem(ZONE_KEY);
  if (saved && ZONE_CHOICES.includes(saved) && isValidZone(saved)) return saved;
  return '';
}

function displayTimeZone() {
  return savedZone() || browserZone();
}

function searchDelaySec() {
  const raw = localStorage.getItem(DELAY_KEY);
  if (raw == null || String(raw).trim() === '') return 2;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0.5 || value > 10) return 2;
  return value;
}

function zoneAbbreviation(zone) {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      timeZoneName: 'short',
    }).formatToParts(new Date());
    const name = parts.find((part) => part.type === 'timeZoneName');
    return name && name.value ? name.value : zone;
  } catch (err) {
    return zone;
  }
}

function updateCreatedAtHeader() {
  const header = document.getElementById('created-at-header');
  if (!header) return;
  header.textContent = `createdAt (TZ: ${zoneAbbreviation(displayTimeZone())})`;
}

function fillZoneSelect() {
  zoneSelect.replaceChildren();
  const browser = document.createElement('option');
  browser.value = '';
  browser.textContent = 'Browser default';
  zoneSelect.appendChild(browser);
  for (const zone of ZONE_CHOICES) {
    const option = document.createElement('option');
    option.value = zone;
    option.textContent = zone;
    zoneSelect.appendChild(option);
  }
  zoneSelect.value = savedZone();
}

function formatCreatedAt(value) {
  if (value == null || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: displayTimeZone(),
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const part = (type) => {
      const found = parts.find((item) => item.type === type);
      return found && found.value ? found.value.padStart(2, '0') : '';
    };
    return `${part('month')}/${part('day')}/${part('year')} ${part('hour')}:${part('minute')}:${part('second')}`;
  } catch (err) {
    return String(value);
  }
}

const STATUS_PHRASES = {
  200: 'OK',
  201: 'Created',
  204: 'No content',
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  500: 'Server error',
};

const MESSAGE_OVERRIDES = {
  'POST /api/auth/login': {
    200: 'Signed in',
    400: 'Login rejected',
  },
  'GET /api/admin/users': {
    200: 'Account search',
  },
  'GET /api/admin/users/:userId': {
    200: 'Opened account',
  },
  'GET /api/admin/activities/:activityId': {
    200: 'Opened activity',
  },
  'GET /api/admin/plans/:planId': {
    200: 'Opened plan',
  },
  'DELETE /api/admin/plans/:planId': {
    409: 'Delete blocked',
  },
  'DELETE /api/admin/users/:userId': {
    409: 'Delete blocked',
  },
  'GET /api/plans': {
    401: 'Plans list denied',
  },
};

function statusCodeFrom(message) {
  if (typeof message === 'number' && Number.isInteger(message)) return message;
  const text = String(message == null ? '' : message).trim();
  if (!/^\d{3}$/.test(text)) return null;
  return Number(text);
}

function formatLogMessage(event, message) {
  const code = statusCodeFrom(message);
  if (code == null) return message == null ? '' : String(message);
  const overrides = MESSAGE_OVERRIDES[event] || {};
  const phrase = overrides[code] || STATUS_PHRASES[code] || 'Response';
  return `${phrase} (${code})`;
}

function showPage() {
  const page = location.hash === '#settings' ? 'settings' : 'logs';
  logsPage.hidden = page !== 'logs';
  settingsPage.hidden = page !== 'settings';
  for (const link of appNav.querySelectorAll('a')) {
    const active = link.getAttribute('href') === `#${page}`;
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  updateCreatedAtHeader();
  if (page === 'logs' && loadedLogs.length) renderLogs(loadedLogs);
}

async function readBody(response) {
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    return {};
  }
}

function messageFrom(body, fallback) {
  if (body && typeof body.message === 'string' && body.message) return body.message;
  if (body && typeof body.msg === 'string' && body.msg) return body.msg;
  return fallback;
}

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.textContent = '';
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  let response;
  try {
    response = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (err) {
    loginError.textContent = 'Could not reach the API.';
    return;
  }
  const body = await readBody(response);
  const role = body.user && body.user.role;
  if (!response.ok || role !== 'admin' || !body.token) {
    clearToken();
    loginError.textContent = role && role !== 'admin'
      ? 'This account is not an admin.'
      : messageFrom(body, 'Login failed.');
    showLoggedIn(false);
    return;
  }
  sessionStorage.setItem(TOKEN_KEY, body.token);
  saveSessionUser(body.user);
  showLoggedIn(true);
  document.getElementById('password').value = '';
  loadLogs();
});

function hideUserResults() {
  for (const list of document.querySelectorAll('.user-picker-results')) {
    list.hidden = true;
    list.replaceChildren();
  }
}

function clearSelectedUser() {
  clearTimeout(userSearchTimer);
  userSearchSeq += 1;
  logUserId = '';
  for (const input of document.querySelectorAll('.user-picker-query')) input.value = '';
  for (const chosen of document.querySelectorAll('.user-picker-chosen')) chosen.textContent = '';
  hideUserResults();
}

function showPickerNote(list, text) {
  list.replaceChildren();
  const item = document.createElement('li');
  item.className = 'user-picker-note';
  item.textContent = text;
  list.appendChild(item);
  list.hidden = false;
}

function userIdOf(user) {
  return user && user._id != null ? String(user._id) : '';
}

function userEmailOf(user) {
  return user && user.email != null ? String(user.email) : '';
}

function setPickerChoice(input, email) {
  if (input) input.value = email;
  const picker = input && input.closest('.user-picker');
  if (!picker) return;
  const chosen = picker.querySelector('.user-picker-chosen');
  if (chosen) chosen.textContent = email ? `Selected ${email}` : '';
  const list = picker.querySelector('.user-picker-results');
  if (list) {
    list.hidden = true;
    list.replaceChildren();
  }
}

function chooseAccountFilter(user) {
  const id = userIdOf(user);
  const email = userEmailOf(user);
  logUserId = id;
  setPickerChoice(document.getElementById('admin-account-filter'), email);
  openExplorer(id, email);
}

async function searchUsers(input, q) {
  const list = input.closest('.user-picker').querySelector('.user-picker-results');
  if (input.value.trim() !== q) return;
  const seq = ++userSearchSeq;
  let response;
  try {
    response = await fetch(`${API}/api/admin/users?q=${encodeURIComponent(q)}`, {
      headers: authHeaders(),
    });
  } catch (err) {
    if (seq !== userSearchSeq) return;
    showPickerNote(list, 'Could not reach the API.');
    return;
  }
  if (seq !== userSearchSeq) return;
  const body = await readBody(response);
  if (seq !== userSearchSeq) return;
  if (response.status === 401) {
    clearToken();
    clearSelectedUser();
    clearExplorer();
    showLoggedIn(false);
    loginError.textContent = messageFrom(body, 'Login expired.');
    return;
  }
  if (!response.ok) {
    showPickerNote(list, messageFrom(body, 'Could not search users.'));
    return;
  }
  const users = Array.isArray(body.users) ? body.users : [];
  if (!users.length) {
    showPickerNote(list, 'No matches.');
    return;
  }
  list.replaceChildren();
  for (const user of users) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'option');
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
    button.textContent = name ? `${user.email} — ${name}` : String(user.email || '');
    button.addEventListener('click', () => {
      chooseAccountFilter(user);
    });
    item.appendChild(button);
    list.appendChild(item);
  }
  list.hidden = false;
}

function scheduleUserSearch(input) {
  clearTimeout(userSearchTimer);
  const list = input.closest('.user-picker').querySelector('.user-picker-results');
  const q = input.value.trim();
  if (q.length < 2) {
    list.hidden = true;
    list.replaceChildren();
    return;
  }
  userSearchTimer = setTimeout(() => searchUsers(input, q), searchDelaySec() * 1000);
}

for (const input of document.querySelectorAll('.user-picker-query')) {
  input.addEventListener('input', () => {
    const picker = input.closest('.user-picker');
    const chosen = picker && picker.querySelector('.user-picker-chosen');
    if (chosen) chosen.textContent = '';
    logUserId = '';
    scheduleUserSearch(input);
  });
}

document.getElementById('clear-account-filter').addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  clearTimeout(userSearchTimer);
  userSearchSeq += 1;
  logUserId = '';
  const account = document.getElementById('admin-account-filter');
  if (account) account.value = '';
  const picker = account && account.closest('.user-picker');
  if (picker) {
    const chosen = picker.querySelector('.user-picker-chosen');
    if (chosen) chosen.textContent = '';
    const list = picker.querySelector('.user-picker-results');
    if (list) {
      list.hidden = true;
      list.replaceChildren();
    }
  }
});

document.getElementById('clear-plan-filter').addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  document.getElementById('filter-plan').value = '';
});

function loadLogsOnEnter(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  loadLogs();
}

document.getElementById('admin-account-filter').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  clearTimeout(userSearchTimer);
  userSearchSeq += 1;
  const picker = event.target.closest('.user-picker');
  const list = picker && picker.querySelector('.user-picker-results');
  if (list) {
    list.hidden = true;
    list.replaceChildren();
  }
  loadLogs();
});

document.getElementById('filter-plan').addEventListener('keydown', loadLogsOnEnter);

document.addEventListener('pointerdown', (event) => {
  if (planMenu && !planMenu.contains(event.target)) closePlanMenu();
  if (accountMenu && !accountMenu.contains(event.target)) closeAccountMenu();
  if (event.target.closest('.user-picker')) return;
  hideUserResults();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const activityDialog = document.getElementById('activity-dialog');
  if (activityDialog && activityDialog.open) {
    event.preventDefault();
    activityDialog.close();
    return;
  }
  const planDialog = document.getElementById('plan-dialog');
  if (planDialog && planDialog.open) {
    event.preventDefault();
    planDialog.close();
    return;
  }
  const dialog = document.getElementById('explorer-dialog');
  if (dialog && dialog.open) {
    event.preventDefault();
    dialog.close();
    return;
  }
  closePlanMenu();
  closeAccountMenu();
});

function clearExplorerFields() {
  const status = document.getElementById('explorer-status');
  const fields = document.getElementById('explorer-fields');
  const plans = document.getElementById('explorer-plans');
  const deleteStatus = document.getElementById('explorer-delete-status');
  const deletePlans = document.getElementById('explorer-delete-plans');
  if (status) status.textContent = '';
  if (fields) fields.replaceChildren();
  if (plans) plans.replaceChildren();
  if (deleteStatus) {
    deleteStatus.textContent = '';
    deleteStatus.classList.remove('is-error');
  }
  if (deletePlans) deletePlans.replaceChildren();
}

function clearPlanExplorerFields() {
  const status = document.getElementById('plan-dialog-status');
  const fields = document.getElementById('plan-dialog-fields');
  const members = document.getElementById('plan-dialog-members');
  const activities = document.getElementById('plan-dialog-activities');
  const deleteStatus = document.getElementById('plan-delete-status');
  if (status) status.textContent = '';
  if (fields) fields.replaceChildren();
  if (members) members.replaceChildren();
  if (activities) activities.replaceChildren();
  if (deleteStatus) {
    deleteStatus.textContent = '';
    deleteStatus.classList.remove('is-error');
  }
}

function clearActivityExplorerFields() {
  const status = document.getElementById('activity-dialog-status');
  const fields = document.getElementById('activity-dialog-fields');
  const revisions = document.getElementById('activity-dialog-revisions');
  const deleteStatus = document.getElementById('activity-delete-status');
  if (status) status.textContent = '';
  if (fields) fields.replaceChildren();
  if (revisions) revisions.replaceChildren();
  if (deleteStatus) {
    deleteStatus.textContent = '';
    deleteStatus.classList.remove('is-error');
  }
}

function clearActivityExplorer() {
  activityExplorerSeq += 1;
  activityExplorerId = '';
  activityExplorerName = '';
  const dialog = document.getElementById('activity-dialog');
  if (dialog && dialog.open) dialog.close();
  clearActivityExplorerFields();
}

function clearPlanExplorer() {
  clearActivityExplorer();
  planExplorerSeq += 1;
  const dialog = document.getElementById('plan-dialog');
  if (dialog && dialog.open) dialog.close();
  clearPlanExplorerFields();
}

function clearExplorer() {
  clearPlanExplorer();
  explorerSeq += 1;
  explorerUserId = '';
  explorerUserEmail = '';
  const dialog = document.getElementById('explorer-dialog');
  if (dialog && dialog.open) dialog.close();
  clearExplorerFields();
}

document.getElementById('explorer-dialog').addEventListener('close', () => {
  explorerSeq += 1;
  explorerUserId = '';
  explorerUserEmail = '';
  clearExplorerFields();
  const planDialog = document.getElementById('plan-dialog');
  if (planDialog && planDialog.open) planDialog.close();
});

document.getElementById('explorer-close').addEventListener('click', () => {
  const dialog = document.getElementById('explorer-dialog');
  if (dialog && dialog.open) dialog.close();
});

document.getElementById('plan-dialog').addEventListener('close', () => {
  planExplorerSeq += 1;
  planExplorerId = '';
  planExplorerName = '';
  clearPlanExplorerFields();
  const activityDialog = document.getElementById('activity-dialog');
  if (activityDialog && activityDialog.open) activityDialog.close();
});

document.getElementById('activity-dialog').addEventListener('close', () => {
  activityExplorerSeq += 1;
  activityExplorerId = '';
  activityExplorerName = '';
  clearActivityExplorerFields();
});

document.getElementById('activity-dialog-close').addEventListener('click', () => {
  const dialog = document.getElementById('activity-dialog');
  if (dialog && dialog.open) dialog.close();
});

document.getElementById('plan-dialog-close').addEventListener('click', () => {
  const dialog = document.getElementById('plan-dialog');
  if (dialog && dialog.open) dialog.close();
});

function explorerDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function renderExplorer(account) {
  const fields = document.getElementById('explorer-fields');
  const plansBody = document.getElementById('explorer-plans');
  const rows = [
    ['Email', account.email],
    ['First name', account.firstName],
    ['Last name', account.lastName],
    ['Phone', account.phoneNumber],
    ['Role', account.role],
  ];
  fields.replaceChildren();
  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value == null ? '' : String(value);
    fields.append(term, detail);
  }
  plansBody.replaceChildren();
  const plans = Array.isArray(account.plans) ? account.plans : [];
  for (const plan of plans) {
    const planId = plan && plan._id != null ? String(plan._id) : '';
    const row = document.createElement('tr');
    if (planId) {
      row.className = 'explorer-plan-row';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `Open plan ${plan.name || planId}`);
      const openPlan = () => openPlanExplorer(planId);
      row.addEventListener('click', openPlan);
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openPlan();
      });
    }
    for (const value of [
      plan.name,
      plan.type,
      explorerDate(plan.startDate),
      explorerDate(plan.endDate),
      plan.role,
    ]) {
      const cell = document.createElement('td');
      cell.textContent = value == null ? '' : String(value);
      row.appendChild(cell);
    }
    plansBody.appendChild(row);
  }
}

function explorerDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function renderPlanExplorer(plan) {
  const fields = document.getElementById('plan-dialog-fields');
  const membersBody = document.getElementById('plan-dialog-members');
  const activitiesBody = document.getElementById('plan-dialog-activities');
  const rows = [
    ['Name', plan.name],
    ['Type', plan.type],
    ['Destination', plan.destination],
    ['Start', explorerDate(plan.startDate)],
    ['End', explorerDate(plan.endDate)],
    ['Time zone', plan.timeZone],
  ];
  fields.replaceChildren();
  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value == null ? '' : String(value);
    fields.append(term, detail);
  }
  membersBody.replaceChildren();
  const members = Array.isArray(plan.members) ? plan.members : [];
  for (const member of members) {
    const row = document.createElement('tr');
    for (const value of [member.email, member.firstName, member.lastName, member.role]) {
      const cell = document.createElement('td');
      cell.textContent = value == null ? '' : String(value);
      row.appendChild(cell);
    }
    membersBody.appendChild(row);
  }
  activitiesBody.replaceChildren();
  const activities = Array.isArray(plan.activities) ? plan.activities : [];
  for (const activity of activities) {
    const activityId = activity && activity._id != null ? String(activity._id) : '';
    const row = document.createElement('tr');
    if (activityId) {
      row.className = 'explorer-activity-row';
      row.tabIndex = 0;
      row.dataset.activityId = activityId;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `Open activity ${activity.name || activityId}`);
      const openActivity = () => openActivityExplorer(activityId);
      row.addEventListener('click', openActivity);
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openActivity();
      });
    }
    for (const value of [activity.name, activity.type, explorerDateTime(activity.startTime)]) {
      const cell = document.createElement('td');
      cell.textContent = value == null ? '' : String(value);
      row.appendChild(cell);
    }
    activitiesBody.appendChild(row);
  }
}

function renderActivityExplorer(activity) {
  const fields = document.getElementById('activity-dialog-fields');
  const revisionsBody = document.getElementById('activity-dialog-revisions');
  const rows = [
    ['Name', activity.name],
    ['Type', activity.type],
    ['Start', explorerDateTime(activity.startTime)],
    ['End', explorerDateTime(activity.endTime)],
    ['Location', activity.location],
    ['Details', activity.details],
  ];
  fields.replaceChildren();
  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value == null ? '' : String(value);
    fields.append(term, detail);
  }
  revisionsBody.replaceChildren();
  const revisions = Array.isArray(activity.revisions) ? activity.revisions : [];
  for (const revision of revisions) {
    const row = document.createElement('tr');
    for (const value of [revision.action, explorerDateTime(revision.createdAt), revision.email]) {
      const cell = document.createElement('td');
      cell.textContent = value == null ? '' : String(value);
      row.appendChild(cell);
    }
    revisionsBody.appendChild(row);
  }
}

function removePlanActivityRow(activityId) {
  const body = document.getElementById('plan-dialog-activities');
  if (!body) return;
  for (const row of [...body.querySelectorAll('tr')]) {
    if (row.dataset.activityId === activityId) row.remove();
  }
  if (body.children.length) return;
  const status = document.getElementById('plan-dialog-status');
  if (!status || status.textContent.includes('No activities.')) return;
  status.textContent = status.textContent ? `${status.textContent} No activities.` : 'No activities.';
}

async function openActivityExplorer(activityId) {
  const id = activityId == null ? '' : String(activityId);
  const dialog = document.getElementById('activity-dialog');
  const status = document.getElementById('activity-dialog-status');
  const fields = document.getElementById('activity-dialog-fields');
  const revisionsBody = document.getElementById('activity-dialog-revisions');
  if (!dialog || !id) return;
  activityExplorerId = id;
  activityExplorerName = '';
  const deleteStatus = document.getElementById('activity-delete-status');
  if (deleteStatus) {
    deleteStatus.textContent = '';
    deleteStatus.classList.remove('is-error');
  }
  const seq = ++activityExplorerSeq;
  if (!dialog.open) dialog.showModal();
  status.textContent = 'Loading activity.';
  fields.replaceChildren();
  revisionsBody.replaceChildren();
  let response;
  try {
    response = await fetch(`${API}/api/admin/activities/${encodeURIComponent(id)}`, {
      headers: authHeaders(),
    });
  } catch (err) {
    if (seq !== activityExplorerSeq) return;
    status.textContent = 'Could not reach the API.';
    return;
  }
  if (seq !== activityExplorerSeq) return;
  const body = await readBody(response);
  if (seq !== activityExplorerSeq) return;
  if (response.status === 401) {
    clearToken();
    clearSelectedUser();
    clearExplorer();
    showLoggedIn(false);
    loginError.textContent = messageFrom(body, 'Login expired.');
    return;
  }
  if (!response.ok) {
    status.textContent = messageFrom(body, 'Could not open this activity.');
    return;
  }
  activityExplorerName = body.name == null ? '' : String(body.name);
  const revisionCount = Array.isArray(body.revisions) ? body.revisions.length : 0;
  status.textContent = revisionCount ? '' : 'No revisions.';
  renderActivityExplorer(body);
}

async function openPlanExplorer(planId) {
  const id = planId == null ? '' : String(planId);
  const dialog = document.getElementById('plan-dialog');
  const status = document.getElementById('plan-dialog-status');
  const fields = document.getElementById('plan-dialog-fields');
  const membersBody = document.getElementById('plan-dialog-members');
  const activitiesBody = document.getElementById('plan-dialog-activities');
  if (!dialog || !id) return;
  planExplorerId = id;
  planExplorerName = '';
  const deleteStatus = document.getElementById('plan-delete-status');
  if (deleteStatus) {
    deleteStatus.textContent = '';
    deleteStatus.classList.remove('is-error');
  }
  const seq = ++planExplorerSeq;
  if (!dialog.open) dialog.showModal();
  status.textContent = 'Loading plan.';
  fields.replaceChildren();
  membersBody.replaceChildren();
  activitiesBody.replaceChildren();
  let response;
  try {
    response = await fetch(`${API}/api/admin/plans/${encodeURIComponent(id)}`, {
      headers: authHeaders(),
    });
  } catch (err) {
    if (seq !== planExplorerSeq) return;
    status.textContent = 'Could not reach the API.';
    return;
  }
  if (seq !== planExplorerSeq) return;
  const body = await readBody(response);
  if (seq !== planExplorerSeq) return;
  if (response.status === 401) {
    clearToken();
    clearSelectedUser();
    clearExplorer();
    showLoggedIn(false);
    loginError.textContent = messageFrom(body, 'Login expired.');
    return;
  }
  if (!response.ok) {
    status.textContent = messageFrom(body, 'Could not open this plan.');
    return;
  }
  planExplorerName = body.name == null ? '' : String(body.name);
  const memberCount = Array.isArray(body.members) ? body.members.length : 0;
  const activityCount = Array.isArray(body.activities) ? body.activities.length : 0;
  const notes = [];
  if (!memberCount) notes.push('No members.');
  if (!activityCount) notes.push('No activities.');
  status.textContent = notes.join(' ');
  renderPlanExplorer(body);
}

async function openExplorer(userId, email) {
  const id = userId == null ? '' : String(userId);
  const dialog = document.getElementById('explorer-dialog');
  const status = document.getElementById('explorer-status');
  const fields = document.getElementById('explorer-fields');
  const plansBody = document.getElementById('explorer-plans');
  if (!dialog || !id) return;
  explorerUserId = id;
  if (email) explorerUserEmail = String(email);
  const deleteStatus = document.getElementById('explorer-delete-status');
  const deletePlans = document.getElementById('explorer-delete-plans');
  if (deleteStatus) {
    deleteStatus.textContent = '';
    deleteStatus.classList.remove('is-error');
  }
  if (deletePlans) deletePlans.replaceChildren();
  const seq = ++explorerSeq;
  if (!dialog.open) dialog.showModal();
  status.textContent = 'Loading account.';
  fields.replaceChildren();
  plansBody.replaceChildren();
  let response;
  try {
    response = await fetch(`${API}/api/admin/users/${encodeURIComponent(id)}`, {
      headers: authHeaders(),
    });
  } catch (err) {
    if (seq !== explorerSeq) return;
    status.textContent = 'Could not reach the API.';
    return;
  }
  if (seq !== explorerSeq) return;
  const body = await readBody(response);
  if (seq !== explorerSeq) return;
  if (response.status === 401) {
    clearToken();
    clearSelectedUser();
    clearExplorer();
    showLoggedIn(false);
    loginError.textContent = messageFrom(body, 'Login expired.');
    return;
  }
  if (!response.ok) {
    status.textContent = messageFrom(body, 'Could not open this account.');
    return;
  }
  if (body.email) explorerUserEmail = String(body.email);
  status.textContent = Array.isArray(body.plans) && body.plans.length ? '' : 'No plans.';
  renderExplorer(body);
}

logoutButton.addEventListener('click', () => {
  clearToken();
  clearSelectedUser();
  clearExplorer();
  loadedLogs = [];
  logsBody.replaceChildren();
  logsStatus.textContent = '';
  showLoggedIn(false);
});

document.getElementById('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const zone = zoneSelect.value;
  const delay = Number(searchDelayInput.value);
  if (zone && !isValidZone(zone)) {
    settingsStatus.classList.add('is-error');
    settingsStatus.textContent = 'Choose a valid time zone.';
    return;
  }
  if (!Number.isFinite(delay) || delay < 0.5 || delay > 10) {
    settingsStatus.classList.add('is-error');
    settingsStatus.textContent = 'Search delay must be a number from 0.5 to 10 seconds.';
    return;
  }
  const styles = stylesFromForm();
  if (!styles) {
    settingsStatus.classList.add('is-error');
    settingsStatus.textContent = 'Each text style needs a listed font, a color, and a size from 12 to 28.';
    return;
  }
  localStorage.setItem(ZONE_KEY, zone);
  localStorage.setItem(DELAY_KEY, String(delay));
  localStorage.setItem(STYLES_KEY, JSON.stringify(styles));
  applyStyles(styles);
  settingsStatus.classList.remove('is-error');
  const label = zone ? zone : `Browser default (${browserZone()})`;
  const delayLabel = delay === 1 ? '1 second' : `${delay} seconds`;
  settingsStatus.textContent = `Display time zone is ${label}. Search delay is ${delayLabel}. Text styles saved.`;
  updateCreatedAtHeader();
  if (loadedLogs.length) renderLogs(loadedLogs);
});

window.addEventListener('hashchange', () => {
  if (token()) showPage();
});

function authHeaders() {
  return {
    Authorization: `Bearer ${token()}`,
    'Content-Type': 'application/json',
  };
}

function renderEventOptions() {
  const select = document.getElementById('filter-event');
  const current = select.value;
  select.replaceChildren();
  const any = document.createElement('option');
  any.value = '';
  any.textContent = 'Any event';
  select.appendChild(any);
  for (const name of eventOptions) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  }
  select.value = eventOptions.includes(current) ? current : '';
}

function rememberEvents(logs) {
  let added = false;
  for (const row of logs) {
    const name = row && row.event != null ? String(row.event).trim() : '';
    if (!name || eventOptions.includes(name)) continue;
    eventOptions.push(name);
    added = true;
  }
  if (added) renderEventOptions();
}

function closePlanMenu() {
  if (!planMenu) return;
  planMenu.remove();
  planMenu = null;
}

function copyText(value) {
  const text = String(value);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => copyTextFallback(text));
    return;
  }
  copyTextFallback(text);
}

function copyTextFallback(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.width = '1px';
  area.style.height = '1px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

function copyPlanId(planId) {
  copyText(planId);
}

function closeAccountMenu() {
  if (!accountMenu) return;
  accountMenu.remove();
  accountMenu = null;
}

function placeContextMenu(menu, x, y) {
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function openAccountMenu(x, y, email, actorUserId) {
  closePlanMenu();
  closeAccountMenu();
  const menu = document.createElement('ul');
  menu.className = 'plan-menu';
  menu.setAttribute('role', 'menu');
  const actions = [
    ['Set account filter', () => {
      clearTimeout(userSearchTimer);
      userSearchSeq += 1;
      logUserId = actorUserId;
      const input = document.getElementById('admin-account-filter');
      if (input) input.value = email;
      const picker = input && input.closest('.user-picker');
      if (picker) {
        const chosen = picker.querySelector('.user-picker-chosen');
        if (chosen) chosen.textContent = email ? `Selected ${email}` : '';
        const list = picker.querySelector('.user-picker-results');
        if (list) {
          list.hidden = true;
          list.replaceChildren();
        }
      }
      closeAccountMenu();
    }],
    ['Copy email', () => {
      copyText(email);
      closeAccountMenu();
    }],
  ];
  for (const [label, onClick] of actions) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.addEventListener('click', onClick);
    item.appendChild(button);
    menu.appendChild(item);
  }
  placeContextMenu(menu, x, y);
  accountMenu = menu;
}

function openPlanMenu(x, y, planId) {
  closeAccountMenu();
  closePlanMenu();
  const menu = document.createElement('ul');
  menu.className = 'plan-menu';
  menu.setAttribute('role', 'menu');
  const actions = [
    ['Set plan id filter', () => {
      document.getElementById('filter-plan').value = planId;
      closePlanMenu();
      loadLogs();
    }],
    ['Copy plan id', () => {
      copyPlanId(planId);
      closePlanMenu();
    }],
  ];
  for (const [label, onClick] of actions) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.addEventListener('click', onClick);
    item.appendChild(button);
    menu.appendChild(item);
  }
  placeContextMenu(menu, x, y);
  planMenu = menu;
}

async function loadLogs() {
  closePlanMenu();
  closeAccountMenu();
  logsStatus.classList.remove('is-error');
  logsStatus.textContent = '';
  logsBody.replaceChildren();
  const params = new URLSearchParams();
  const eventName = document.getElementById('filter-event').value.trim();
  const planId = document.getElementById('filter-plan').value.trim();
  if (eventName) params.set('event', eventName);
  if (planId) params.set('planId', planId);
  if (logUserId) params.set('userId', logUserId);
  const query = params.toString();
  const url = `${API}/api/admin/logs${query ? `?${query}` : ''}`;
  let response;
  try {
    response = await fetch(url, { headers: authHeaders() });
  } catch (err) {
    logsStatus.classList.add('is-error');
    logsStatus.textContent = 'Could not reach the API.';
    return;
  }
  const body = await readBody(response);
  if (response.status === 401) {
    clearToken();
    clearSelectedUser();
    clearExplorer();
    showLoggedIn(false);
    loginError.textContent = messageFrom(body, 'Login expired.');
    return;
  }
  if (!response.ok) {
    logsStatus.classList.add('is-error');
    logsStatus.textContent = messageFrom(body, 'Could not load logs.');
    return;
  }
  loadedLogs = Array.isArray(body.logs) ? body.logs : [];
  rememberEvents(loadedLogs);
  renderLogs(loadedLogs);
}

function cellText(value) {
  return value == null ? '' : String(value);
}

function appendAccountCell(tr, email, actorUserId) {
  const cell = document.createElement('td');
  const label = cellText(email).trim();
  cell.textContent = cellText(email);
  const id = cellText(actorUserId).trim();
  if (id) cell.title = id;
  if (label) {
    cell.addEventListener('contextmenu', (menuEvent) => {
      menuEvent.preventDefault();
      openAccountMenu(menuEvent.clientX, menuEvent.clientY, label, id);
    });
  }
  tr.appendChild(cell);
}

function appendNamedIdCell(tr, name, idValue, onContextMenu) {
  const cell = document.createElement('td');
  cell.textContent = cellText(name);
  const id = cellText(idValue).trim();
  if (id) {
    cell.title = id;
    if (onContextMenu) {
      cell.addEventListener('contextmenu', (menuEvent) => {
        menuEvent.preventDefault();
        onContextMenu(menuEvent, id);
      });
    }
  }
  tr.appendChild(cell);
}

function renderLogs(logs) {
  updateCreatedAtHeader();
  logsBody.replaceChildren();
  if (!logs.length) {
    logsStatus.textContent = logsStatus.classList.contains('is-error') ? logsStatus.textContent : 'No logs.';
    return;
  }
  logsStatus.textContent = '';
  for (const row of logs) {
    const tr = document.createElement('tr');
    const actorUserId = cellText(row.actorUserId).trim();
    const planId = cellText(row.planId).trim();
    if (actorUserId) tr.dataset.actorUserId = actorUserId;
    if (planId) tr.dataset.planId = planId;
    for (const key of ['createdAt', 'event', 'level']) {
      const cell = document.createElement('td');
      const value = row[key];
      cell.textContent = key === 'createdAt' ? formatCreatedAt(value) : cellText(value);
      tr.appendChild(cell);
    }
    appendAccountCell(tr, row.actorEmail, row.actorUserId);
    appendNamedIdCell(tr, row.planName, row.planId, (menuEvent, planId) => {
      openPlanMenu(menuEvent.clientX, menuEvent.clientY, planId);
    });
    const messageCell = document.createElement('td');
    messageCell.textContent = formatLogMessage(row.event, row.message);
    tr.appendChild(messageCell);
    logsBody.appendChild(tr);
  }
}

document.getElementById('logs-form').addEventListener('submit', (event) => {
  event.preventDefault();
  loadLogs();
});

document.getElementById('explorer-delete').addEventListener('click', async () => {
  const status = document.getElementById('explorer-delete-status');
  const plans = document.getElementById('explorer-delete-plans');
  status.classList.remove('is-error');
  status.textContent = '';
  plans.replaceChildren();
  const userId = explorerUserId;
  if (!userId) return;
  const who = explorerUserEmail || 'this account';
  if (!window.confirm(`Delete user ${who}?`)) return;
  let response;
  try {
    response = await fetch(`${API}/api/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
  } catch (err) {
    status.classList.add('is-error');
    status.textContent = 'Could not reach the API.';
    return;
  }
  const body = await readBody(response);
  if (response.status === 401) {
    clearToken();
    clearSelectedUser();
    clearExplorer();
    showLoggedIn(false);
    loginError.textContent = messageFrom(body, 'Login expired.');
    return;
  }
  if (response.status === 409) {
    status.classList.add('is-error');
    status.textContent = messageFrom(body, 'Delete was blocked.');
    const blocking = Array.isArray(body.plans) ? body.plans : [];
    for (const plan of blocking) {
      const item = document.createElement('li');
      item.textContent = plan && plan.name ? String(plan.name) : 'Plan';
      plans.appendChild(item);
    }
    return;
  }
  if (response.status === 200 || response.status === 204) {
    clearExplorer();
    logsStatus.classList.remove('is-error');
    logsStatus.textContent = messageFrom(body, 'User deleted');
    return;
  }
  status.classList.add('is-error');
  status.textContent = messageFrom(body, 'Delete failed.');
});

document.getElementById('plan-delete').addEventListener('click', async () => {
  const status = document.getElementById('plan-delete-status');
  status.classList.remove('is-error');
  status.textContent = '';
  const planId = planExplorerId;
  if (!planId) return;
  const name = planExplorerName || 'this plan';
  if (!window.confirm(`Delete plan ${name}?`)) return;
  let response;
  try {
    response = await fetch(`${API}/api/admin/plans/${encodeURIComponent(planId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
  } catch (err) {
    status.classList.add('is-error');
    status.textContent = 'Could not reach the API.';
    return;
  }
  const body = await readBody(response);
  if (response.status === 401) {
    clearToken();
    clearSelectedUser();
    clearExplorer();
    showLoggedIn(false);
    loginError.textContent = messageFrom(body, 'Login expired.');
    return;
  }
  if (response.status === 409) {
    status.classList.add('is-error');
    status.textContent = messageFrom(body, 'Delete was blocked.');
    return;
  }
  if (response.status === 200 || response.status === 204) {
    const userId = explorerUserId;
    const email = explorerUserEmail;
    const planDialog = document.getElementById('plan-dialog');
    if (planDialog && planDialog.open) planDialog.close();
    if (userId) await openExplorer(userId, email);
    const accountStatus = document.getElementById('explorer-status');
    if (accountStatus && !accountStatus.textContent) {
      accountStatus.textContent = messageFrom(body, 'Plan deleted');
    }
    return;
  }
  status.classList.add('is-error');
  status.textContent = messageFrom(body, 'Delete failed.');
});

document.getElementById('activity-delete').addEventListener('click', async () => {
  const status = document.getElementById('activity-delete-status');
  status.classList.remove('is-error');
  status.textContent = '';
  const activityId = activityExplorerId;
  if (!activityId) return;
  const name = activityExplorerName || 'this activity';
  if (!window.confirm(`Delete activity ${name}?`)) return;
  let response;
  try {
    response = await fetch(`${API}/api/admin/activities/${encodeURIComponent(activityId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
  } catch (err) {
    status.classList.add('is-error');
    status.textContent = 'Could not reach the API.';
    return;
  }
  const body = await readBody(response);
  if (response.status === 401) {
    clearToken();
    clearSelectedUser();
    clearExplorer();
    showLoggedIn(false);
    loginError.textContent = messageFrom(body, 'Login expired.');
    return;
  }
  if (response.status === 200 || response.status === 204) {
    const dialog = document.getElementById('activity-dialog');
    if (dialog && dialog.open) dialog.close();
    removePlanActivityRow(activityId);
    return;
  }
  status.classList.add('is-error');
  status.textContent = messageFrom(body, 'Delete failed.');
});

renderEventOptions();
fillZoneSelect();
searchDelayInput.value = String(searchDelaySec());
const initialStyles = loadStyles();
applyStyles(initialStyles);
fillStyleFields(initialStyles);
showLoggedIn(Boolean(token()));
if (token()) loadLogs();
