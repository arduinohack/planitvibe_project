const TOKEN_KEY = 'planitvibe.import.token';
const USER_KEY = 'planitvibe.import.userId';
const DEFAULT_API = 'http://localhost:3000';

const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginButton = document.getElementById('login-button');
const logoutButton = document.getElementById('logout-button');
const sessionForm = document.getElementById('session-form');
const importForm = document.getElementById('import-form');
const planSelect = document.getElementById('plan-select');
const planNameInput = document.getElementById('plan-name');
const fileInput = document.getElementById('csv-file');
const columnMap = document.getElementById('column-map');
const nameSelect = document.getElementById('col-name');
const typeSelect = document.getElementById('col-type');
const defaultTypeLabel = document.getElementById('default-type-label');
const defaultTypeSelect = document.getElementById('default-type');
const startSelect = document.getElementById('col-start');
const endSelect = document.getElementById('col-end');
const locationSelect = document.getElementById('col-location');
const message = document.getElementById('message');
const planList = document.getElementById('plan-list');
const exportButton = document.getElementById('export-button');
const fieldWindow = document.getElementById('field-window');
const fieldForm = document.getElementById('field-form');
const fieldMessage = document.getElementById('field-message');
const fieldCancel = document.getElementById('field-cancel');
const exportOrder = document.getElementById('export-order');
const exportWindow = document.getElementById('export-window');
const exportPlan = document.getElementById('export-plan');
const exportCsv = document.getElementById('export-csv');
const exportXlsx = document.getElementById('export-xlsx');
const exportCancel = document.getElementById('export-cancel');
const exportMessage = document.getElementById('export-message');

let chosenFields = [];

function apiBase() {
  const configured = window.PLANITVIBE_API_BASE;
  const value = typeof configured === 'string' ? configured.trim() : '';
  return value.replace(/\/+$/, '') || DEFAULT_API;
}

function setMessage(text, isError) {
  message.textContent = text || '';
  message.className = isError ? 'message error' : 'message';
}

function authHeaders() {
  return { Authorization: `Bearer ${sessionStorage.getItem(TOKEN_KEY) || ''}` };
}

function canImport(role) {
  return role === 'Owner'
    || role === 'Collaborator'
    || role === 'VibeCoordinator'
    || role === 'coordinator'
    || role === 'VibePlanner'
    || role === 'planner';
}

function closeExportWindows() {
  if (fieldWindow.open) fieldWindow.close();
  if (exportWindow.open) exportWindow.close();
}

function clearColumnChoices() {
  columnMap.hidden = true;
  for (const select of [nameSelect, typeSelect, startSelect, endSelect, locationSelect]) {
    select.replaceChildren();
  }
  defaultTypeLabel.hidden = true;
}

function showSession(loggedIn) {
  loginButton.hidden = loggedIn;
  emailInput.hidden = loggedIn;
  passwordInput.hidden = loggedIn;
  emailInput.parentElement.hidden = loggedIn;
  passwordInput.parentElement.hidden = loggedIn;
  logoutButton.hidden = !loggedIn;
  if (!loggedIn) {
    importForm.hidden = true;
    planSelect.replaceChildren();
    planList.replaceChildren();
    clearColumnChoices();
    closeExportWindows();
  }
}

function endSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
  showSession(false);
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (err) {
    return {};
  }
}

function headerFields(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      fields.push(field.trim());
      field = '';
      continue;
    }
    if (ch === '\n' || ch === '\r') break;
    field += ch;
  }
  if (field.length > 0 || fields.length > 0) fields.push(field.trim());
  const seen = new Set();
  const headers = [];
  for (const item of fields) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    headers.push(item);
  }
  return headers;
}

function fillColumnSelect(select, headers, blankLabel) {
  select.replaceChildren();
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = blankLabel;
  select.appendChild(blank);
  for (const header of headers) {
    const option = document.createElement('option');
    option.value = header;
    option.textContent = header;
    select.appendChild(option);
  }
}

function preselect(select, headers, fieldName) {
  const match = headers.find((header) => header.toLowerCase() === fieldName.toLowerCase());
  if (match) select.value = match;
}

function toggleDefaultType() {
  defaultTypeLabel.hidden = typeSelect.value !== '';
}

function showColumns(headers) {
  fillColumnSelect(nameSelect, headers, 'Choose a column');
  fillColumnSelect(typeSelect, headers, 'Not mapped');
  fillColumnSelect(startSelect, headers, 'Not mapped');
  fillColumnSelect(endSelect, headers, 'Not mapped');
  fillColumnSelect(locationSelect, headers, 'Not mapped');
  preselect(nameSelect, headers, 'name');
  preselect(typeSelect, headers, 'type');
  preselect(startSelect, headers, 'startTime');
  preselect(endSelect, headers, 'endTime');
  preselect(locationSelect, headers, 'location');
  columnMap.hidden = false;
  toggleDefaultType();
}

function isCsvFile(file) {
  const filename = file.name.toLowerCase();
  return filename.endsWith('.csv') && !filename.endsWith('.xlsx') && !filename.endsWith('.xls');
}

async function storedRole(plan, userId) {
  if (plan.ownerId && String(plan.ownerId) === userId) return 'Owner';
  const response = await fetch(`${apiBase()}/api/plans/${plan._id}/users`, {
    headers: authHeaders(),
  });
  if (response.status === 401) return null;
  if (!response.ok) return '';
  const body = await readJson(response);
  const users = Array.isArray(body.users) ? body.users : [];
  const mine = users.find((row) => String(row.userId) === userId);
  return mine && mine.role ? String(mine.role) : '';
}

function renderPlans(rows) {
  planList.replaceChildren();
  planSelect.replaceChildren();
  const importable = rows.filter((row) => canImport(row.role));
  for (const row of importable) {
    const option = document.createElement('option');
    option.value = row.plan._id;
    option.dataset.planName = row.plan.name || '';
    option.textContent = row.plan.name || row.plan._id;
    planSelect.appendChild(option);
  }
  importForm.hidden = importable.length === 0;

  if (!rows.length) {
    const item = document.createElement('li');
    item.textContent = 'No plans yet';
    planList.appendChild(item);
    return;
  }

  for (const row of rows) {
    const item = document.createElement('li');
    const name = row.plan.name || 'Untitled plan';
    item.textContent = row.role ? `${name} (${row.role})` : name;
    planList.appendChild(item);
  }
}

async function loadPlans() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const userId = sessionStorage.getItem(USER_KEY);
  if (!token || !userId) {
    showSession(false);
    return;
  }
  showSession(true);
  const response = await fetch(`${apiBase()}/api/plans`, { headers: authHeaders() });
  if (response.status === 401) {
    endSession();
    setMessage('Log in again.', true);
    return;
  }
  if (!response.ok) {
    setMessage('Could not load plans.', true);
    return;
  }
  const body = await readJson(response);
  const plans = Array.isArray(body.plans) ? body.plans : [];
  const rows = [];
  for (const plan of plans) {
    const role = await storedRole(plan, userId);
    if (role === null) {
      endSession();
      setMessage('Log in again.', true);
      return;
    }
    rows.push({ plan, role });
  }
  renderPlans(rows);
}

function checkedExportFields() {
  return [...fieldForm.querySelectorAll('input[name="export-field"]:checked')].map((box) => box.value);
}

function orderItem(field) {
  for (const item of exportOrder.children) {
    if (item.dataset.field === field) return item;
  }
  return null;
}

function addOrderField(field) {
  if (orderItem(field)) return;
  const item = document.createElement('li');
  item.dataset.field = field;
  item.textContent = field;
  exportOrder.appendChild(item);
}

function removeOrderField(field) {
  const item = orderItem(field);
  if (item) item.remove();
}

function exportOrderValues() {
  return [...exportOrder.children].map((item) => item.dataset.field);
}

function orderItemAfter(y) {
  const items = [...exportOrder.querySelectorAll('li:not(.dragging)')];
  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;
  for (const child of items) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = child;
    }
  }
  return closest;
}

let draggingField = null;

function endFieldDrag() {
  if (!draggingField) return;
  draggingField.classList.remove('dragging');
  draggingField = null;
}

exportOrder.addEventListener('pointerdown', (event) => {
  const item = event.target.closest ? event.target.closest('li') : null;
  if (!item || item.parentElement !== exportOrder) return;
  if (event.button != null && event.button !== 0) return;
  draggingField = item;
  item.classList.add('dragging');
  if (item.setPointerCapture) {
    try { item.setPointerCapture(event.pointerId); } catch (err) { /* already released */ }
  }
  event.preventDefault();
});

exportOrder.addEventListener('pointermove', (event) => {
  if (!draggingField) return;
  event.preventDefault();
  const after = orderItemAfter(event.clientY);
  if (after) exportOrder.insertBefore(draggingField, after);
  else exportOrder.appendChild(draggingField);
});

exportOrder.addEventListener('pointerup', endFieldDrag);
exportOrder.addEventListener('pointercancel', endFieldDrag);

fieldForm.addEventListener('change', (event) => {
  const box = event.target;
  if (!box || box.name !== 'export-field') return;
  if (box.checked) addOrderField(box.value);
  else removeOrderField(box.value);
});

for (const field of checkedExportFields()) addOrderField(field);

function fillExportPlans() {
  exportPlan.replaceChildren();
  for (const option of planSelect.options) {
    const copy = document.createElement('option');
    copy.value = option.value;
    copy.dataset.planName = option.dataset.planName || '';
    copy.textContent = option.textContent;
    exportPlan.appendChild(copy);
  }
}

function exportDate(now) {
  const date = now instanceof Date ? now : new Date();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = String(date.getFullYear() % 100).padStart(2, '0');
  return `${month}-${day}-${year}`;
}

function exportFilename(planName, format, now) {
  const cleaned = String(planName || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned || 'plan';
  const ext = format === 'xlsx' ? 'xlsx' : 'csv';
  return `${base} ${exportDate(now)}.${ext}`;
}

function filenameFrom(response) {
  const header = response.headers.get('Content-Disposition') || '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch (err) {
      return '';
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain ? plain[1] : '';
}

function isFixedPlanName(filename, format) {
  const ext = format === 'xlsx' ? 'xlsx' : 'csv';
  const name = String(filename || '').trim();
  return name.toLowerCase() === `plan.${ext}`
    || new RegExp(`^plan \\d{2}-\\d{2}-\\d{2}\\.${ext}$`, 'i').test(name);
}

async function downloadExport(format) {
  const planId = exportPlan.value;
  if (!planId) {
    exportMessage.textContent = 'Choose a plan.';
    return;
  }
  if (!chosenFields.length) {
    exportMessage.textContent = 'Choose at least one field.';
    return;
  }
  const params = new URLSearchParams();
  params.set('format', format);
  params.set('fields', chosenFields.join(','));
  exportMessage.textContent = '';
  const response = await fetch(`${apiBase()}/api/plans/${planId}/export?${params}`, {
    headers: authHeaders(),
  });
  if (response.status === 401) {
    closeExportWindows();
    endSession();
    setMessage('Log in again.', true);
    return;
  }
  if (response.status === 403) {
    exportMessage.textContent = 'Not allowed.';
    return;
  }
  if (!response.ok) {
    const body = await readJson(response);
    exportMessage.textContent = body.message || 'Could not export.';
    return;
  }
  const blob = await response.blob();
  const selected = exportPlan.selectedOptions[0];
  const planName = selected ? selected.dataset.planName : '';
  const named = exportFilename(planName, format);
  const headerName = filenameFrom(response);
  const filename = headerName && !isFixedPlanName(headerName, format) ? headerName : named;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  exportWindow.close();
  setMessage(`Exported ${filename}.`);
}

sessionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('Logging in…');
  const response = await fetch(`${apiBase()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: emailInput.value.trim(),
      password: passwordInput.value,
    }),
  });
  const body = await readJson(response);
  if (!response.ok || !body.token) {
    setMessage(body.message || 'Login failed.', true);
    return;
  }
  const userId = body.user && (body.user._id || body.user.id);
  sessionStorage.setItem(TOKEN_KEY, body.token);
  sessionStorage.setItem(USER_KEY, userId ? String(userId) : '');
  passwordInput.value = '';
  setMessage('');
  await loadPlans();
});

logoutButton.addEventListener('click', () => {
  endSession();
  setMessage('');
});

fileInput.addEventListener('change', async () => {
  clearColumnChoices();
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  if (!isCsvFile(file)) {
    fileInput.value = '';
    setMessage('Choose a CSV file. Spreadsheet files are not accepted.', true);
    return;
  }
  let text = '';
  try {
    text = await file.text();
  } catch (err) {
    setMessage('Could not read that file.', true);
    return;
  }
  const headers = headerFields(text);
  if (!headers.length) {
    setMessage('That CSV has no header row.', true);
    return;
  }
  showColumns(headers);
  setMessage('');
});

typeSelect.addEventListener('change', toggleDefaultType);

importForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const planId = planSelect.value;
  const file = fileInput.files && fileInput.files[0];
  if (!planId) {
    setMessage('Choose a plan.', true);
    return;
  }
  if (!file || !isCsvFile(file)) {
    setMessage('Choose a CSV file. Spreadsheet files are not accepted.', true);
    return;
  }
  if (columnMap.hidden || !nameSelect.value) {
    setMessage('Choose the name column.', true);
    return;
  }
  const typeMapped = typeSelect.value !== '';
  if (!typeMapped && !defaultTypeSelect.value) {
    setMessage('Choose a default type.', true);
    return;
  }

  const map = { name: nameSelect.value };
  if (typeMapped) map.type = typeSelect.value;
  if (startSelect.value) map.startTime = startSelect.value;
  if (endSelect.value) map.endTime = endSelect.value;
  if (locationSelect.value) map.location = locationSelect.value;

  const payload = new FormData();
  payload.append('map', JSON.stringify(map));
  payload.append('file', file, file.name);
  const planName = planNameInput.value.trim();
  if (planName) payload.append('planName', planName);
  if (!typeMapped) payload.append('defaultType', defaultTypeSelect.value);

  setMessage('Importing…');
  const response = await fetch(`${apiBase()}/api/plans/${planId}/import`, {
    method: 'POST',
    headers: authHeaders(),
    body: payload,
  });
  const body = await readJson(response);
  if (response.status === 401) {
    endSession();
    setMessage('Log in again.', true);
    return;
  }
  if (response.status === 403) {
    setMessage('Not allowed.', true);
    return;
  }
  if (response.status !== 201) {
    setMessage(body.message || 'Could not import the CSV.', true);
    return;
  }
  fileInput.value = '';
  planNameInput.value = '';
  clearColumnChoices();
  setMessage(`Created ${body.name}. Inserted ${body.inserted}, skipped ${body.skipped}.`);
  await loadPlans();
});

exportButton.addEventListener('click', () => {
  fieldMessage.textContent = '';
  fieldWindow.showModal();
});

fieldCancel.addEventListener('click', () => {
  fieldWindow.close();
});

fieldForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const checked = exportOrderValues();
  if (!checked.length) {
    fieldMessage.textContent = 'Choose at least one field.';
    return;
  }
  chosenFields = checked;
  fieldMessage.textContent = '';
  fillExportPlans();
  fieldWindow.close();
  exportMessage.textContent = '';
  exportWindow.showModal();
});

exportCancel.addEventListener('click', () => {
  exportWindow.close();
});

exportCsv.addEventListener('click', () => {
  downloadExport('csv').catch(() => {
    exportMessage.textContent = 'Could not export.';
  });
});

exportXlsx.addEventListener('click', () => {
  downloadExport('xlsx').catch(() => {
    exportMessage.textContent = 'Could not export.';
  });
});

if (sessionStorage.getItem(TOKEN_KEY)) {
  loadPlans().catch(() => setMessage('Could not load plans.', true));
} else {
  showSession(false);
}
